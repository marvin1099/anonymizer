"""Warm-Model-Daemon: GLiNER bleibt geladen, Unix Socket, JSON pro Zeile.

Protokoll (eine JSON-Objekt pro Zeile, newline-delimited):
  Anfrage:  {"text": "...", "opts": {"lang": ..., "use_ner": ..., ...}}
  Antwort:  {"ok": true, "text": "...", "replacements": [{...}, ...], "counts": {...}}
  Fehler:   {"ok": false, "error": "..."}

Persistenter Zustand (counters/seen) sorgt fuer stabile Placeholder
ueber alle Anfragen hinweg: Anna Mueller -> immer [PERSON_1].
Reverse-Lookup passiert im Plugin/CLI via "replacements" (original<->placeholder).
"""
from __future__ import annotations

import json
import hashlib
import os
import signal
import socket
import sys
import threading
from collections import OrderedDict

SOCKET_PATH = os.path.expanduser("~/.local/share/anonymizer/anon.sock")
STATE_PATH = os.path.expanduser("~/.local/share/anonymizer/state.json")

# In-Memory-Cache fuer bereits anonymisierte Texte (haeufig: gleiche Datei
# wird mehrfach gelesen). Klein gehalten, damit der RAM nicht wächst.
_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_CACHE_MAX = 32


def _load_state() -> dict:
    """State von Platte laden, damit Placeholder und Reverse-Mapping einen
    Daemon-Neustart ueberleben (sonst kann das Plugin Pfade nicht mehr
    zurueckuebersetzen: '/Users/[USERNAME_1]/...' -> File not found)."""
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            data.setdefault("counters", {})
            data.setdefault("exact", {})
            # 'seen' hat Tupel-Keys -> auf der Platte als Liste von 3-Tupeln.
            data["seen"] = {
                (str(p[0]), str(p[1])): str(p[2])
                for p in (data.get("seen") or [])
                if len(p) == 3
            }
            return data
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        print(f"[serve] WARN state nicht lesbar: {e}", flush=True)
    return {"counters": {}, "seen": {}, "exact": {}}


def _save_state(state: dict) -> None:
    try:
        payload = {
            "counters": state.get("counters", {}),
            # Tupel-Keys sind in JSON unzulaessig -> Liste von 3-Tupeln.
            "seen": [[k[0], k[1], ph] for k, ph in state.get("seen", {}).items()],
            "exact": state.get("exact", {}),
        }
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, STATE_PATH)
        os.chmod(STATE_PATH, 0o600)
    except Exception as e:  # noqa: BLE001
        print(f"[serve] WARN state nicht speicherbar: {e}", flush=True)


def _preload():
    from .ner import preload_model

    try:
        preload_model()
        print("[serve] GLiNER preloaded", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[serve] WARN preload failed: {e}", flush=True)


def _handle(line: str, state: dict, emit=None) -> dict:
    try:
        req = json.loads(line)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"bad json: {e}"}

    # Reverse-Lookup: Plugin fragt die Placeholder->Original-Tabelle ab, wenn
    # sein In-Memory-Mapping leer ist (Plugin-Reload) oder ein Placeholder
    # fehlt (z.B. aus einer aelteren Session).
    if req.get("resolve") is not None:
        exact = state.get("exact", {})
        if isinstance(req["resolve"], list):
            keys = [str(k) for k in req["resolve"]]
            return {"ok": True, "map": {k: exact[k] for k in keys if k in exact}}
        return {"ok": True, "map": exact}

    text = req.get("text", "")
    opts = req.get("opts") or {}
    key = None
    if text:
        key = json.dumps([text, opts], ensure_ascii=False, sort_keys=True)
        key = hashlib.sha256(key.encode("utf-8")).hexdigest()
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit
    try:
        from .engine import anonymize

        result = anonymize(
            text,
            lang=opts.get("lang", "both"),
            use_ner=opts.get("use_ner", True),
            threshold=opts.get("threshold", 0.30),
            style=opts.get("style", "numbered"),
            include=opts.get("include"),
            exclude=opts.get("exclude"),
            state=state,
            # Fortschrittszeilen VOR der Antwort, wenn der Client streamt
            # (Plugin zeigt sie als Toast, damit lange Läufe nicht wie ein
            # Haenger wirken). Ohne "progress": keine Zusatzzeilen.
            progress=(
                (lambda done, total: emit({"p": done, "n": total}))
                if (emit is not None and req.get("progress"))
                else None
            ),
        )
        resp = {
            "ok": True,
            "text": result.text,
            "replacements": [
                {
                    "label": r.label,
                    "original": r.original,
                    "placeholder": r.placeholder,
                    "start": r.start,
                    "end": r.end,
                    "source": r.source,
                }
                for r in result.replacements
            ],
            "counts": result.counts,
        }
        _save_state(state)
        if key is not None:
            _CACHE[key] = resp
            while len(_CACHE) > _CACHE_MAX:
                _CACHE.popitem(last=False)
        return resp
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def is_alive(socket_path: str = SOCKET_PATH, timeout: float = 0.3) -> bool:
    try:
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(timeout)
        s.connect(socket_path)
        s.close()
        return True
    except OSError:
        return False


def request(text: str, opts: dict | None = None, socket_path: str = SOCKET_PATH,
            timeout: float = 30.0) -> dict | None:
    """Anfrage an den Daemon. None wenn kein Daemon laeuft."""
    try:
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(timeout)
        s.connect(socket_path)
    except OSError:
        return None
    try:
        payload = json.dumps({"text": text, "opts": opts or {}}, ensure_ascii=False) + "\n"
        s.sendall(payload.encode("utf-8"))
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        line = buf.split(b"\n", 1)[0]
        if not line:
            return None
        return json.loads(line.decode("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    finally:
        s.close()


def serve(socket_path: str = SOCKET_PATH) -> None:
    os.makedirs(os.path.dirname(socket_path), exist_ok=True)
    if os.path.exists(socket_path):
        try:
            probe = socket.socket(socket.AF_UNIX)
            probe.settimeout(0.3)
            probe.connect(socket_path)
            probe.close()
            print(f"[serve] already running at {socket_path}", flush=True)
            return
        except OSError:
            os.unlink(socket_path)

    _preload()
    state: dict = _load_state()
    print(
        f"[serve] state geladen: {len(state.get('exact', {}))} Platzhalter", flush=True
    )

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(socket_path)
    os.chmod(socket_path, 0o600)
    srv.listen(16)
    print(f"[serve] listening on {socket_path}", flush=True)

    stop = threading.Event()

    def _sig(_sig, _frm):
        stop.set()

    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)

    def client_thread(conn: socket.socket):
        buf = b""
        lock = threading.Lock()

        def emit(obj: dict) -> None:
            # Fortschrittszeilen waehrend der Verarbeitung senden.
            with lock:
                try:
                    conn.sendall((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
                except OSError:
                    pass

        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    resp = _handle(line.decode("utf-8", "replace"), state, emit=emit)
                    with lock:
                        conn.sendall((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
        except OSError:
            pass
        finally:
            conn.close()

    while not stop.is_set():
        srv.settimeout(0.5)
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=client_thread, args=(conn,), daemon=True).start()

    srv.close()
    try:
        os.unlink(socket_path)
    except OSError:
        pass
    print("[serve] stopped", flush=True)
