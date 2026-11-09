#!/bin/sh
# Test-Lauf fuer den anonymizer.
#
# Der Punkt des Ganzen: die Suitten muessen auf einem frisch geklonten Repo
# laufen, ohne deine echte Konfiguration zu beruehren und ohne deinen echten
# Daemon-State zu belasten. Deshalb:
#
#   * /tmp/anon-free bekommt EIGENEN Config-, Socket- und State-Pfad.
#     ~/.config/opencode/anonymizer.json wird nie gelesen, nie geschrieben.
#   * Jeder Lauf startet mit frischem State -- alte Numerierung laesst sonst
#     Tests fehlschlagen, die PERSON_1/PERSON_2 voraussetzen.
#   * PYTHONPATH zeigt auf das REPO, damit der gestartete Daemon den Code aus
#     diesem Repo fuehrt und nicht eine installierte Kopie. Sonst testet man
#     stillschweigend etwas anderes, als hier liegt.
#   * Nach dem Start wird geprueft, dass der Daemon WIRKLICH am Sandbox-Socket
#     hoert. Das ist die stille Falle: er laeuft, aber am alten Pfad.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="/tmp/anon-free"
BUN="${BUN:-$HOME/.bun/bin/bun}"
VENV_PY="${ANON_PYTHON:-$HOME/.local/share/anonymizer/.venv/bin/python3}"

[ -x "$BUN" ] || { echo "bun not found (set BUN=/path/to/bun)"; exit 1; }

# 1) Sandbox frisch aufbauen -> garantiert leerer Zaehlstand.
#    Nur ein Daemon, der AM SANDBOX-SOCKET laeuft, wird beendet (lsof),
#    niemals der laufende Benutzer-Daemon.
if lsof -t -U "$SANDBOX/share/anon.sock" >/dev/null 2>&1; then
  echo "== stopping old sandbox daemon =="
  lsof -t -U "$SANDBOX/share/anon.sock" | xargs kill -9 2>/dev/null || true
  sleep 1
fi
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"/{share,config,trusted,roh}

# 2) Plugin aus dem REPO bauen. Ohne das testen die Suitten nichts.
echo "== building plugin/dist =="
(cd "$REPO/plugin" && "$BUN" install --silent && "$BUN" build ./index.ts \
  --outdir dist --target bun --format esm >/dev/null)

# 3) Sandbox-Config: die Ordner, die in den Tests ROH bleiben sollen.
#    Alles ausserhalb ist damit automatisch gefiltert -- unabhaengig davon,
#    was auf dem Rechner des Lesers in der echten Konfiguration steht.
cat > "$SANDBOX/config/anonymizer.json" <<JSON
{ "trustedPaths": ["$SANDBOX/trusted", "$SANDBOX/roh"] }
JSON

# 4) Isolierte Umgebung fuer Plugin UND Daemon. Der Plugin-Spawn
#    (ensureDaemon -> "anon --serve") erbt diese Variablen.
export ANON_SANDBOX="$SANDBOX"
export ANON_CONFIG="$SANDBOX/config/anonymizer.json"
export ANON_SOCK="$SANDBOX/share/anon.sock"
export ANON_STATE="$SANDBOX/share/state.json"
export ANON_PLUGIN="$REPO/plugin/dist/index.js"
export ANON_BIN="${ANON_BIN:-$REPO/tests/bin/anon}"
export PYTHONPATH="$REPO/daemon${PYTHONPATH:+:$PYTHONPATH}"

# 5) Test CLI: used repo-wide so 'anon' runs the repo code.
mkdir -p "$REPO/tests/bin"
cat > "$REPO/tests/bin/anon" <<EOF
#!/bin/sh
export PYTHONPATH="$REPO/daemon\${PYTHONPATH:+:\$PYTHONPATH}"
exec "$VENV_PY" -m anonymizer.cli "\$@"
EOF
chmod +x "$REPO/tests/bin/anon"
[ -x "$VENV_PY" ] || { echo "venv python missing: $VENV_PY (see README, 'Install -> Daemon')"; exit 1; }

# 6) Daemon in der Sandbox starten und NACHWEISEN, dass er am Sandbox-Socket
#    hoert. Genau diese Pruefung faengt den Fehler, dass er am alten Pfad laeuft.
echo "== starting isolated daemon (fresh state) =="
"$ANON_BIN" --serve > "$SANDBOX/share/serve.log" 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true' EXIT INT TERM

i=0
while [ ! -S "$ANON_SOCK" ]; do
  i=$((i+1))
  [ "$i" -gt 240 ] && { echo "ERROR: sandbox socket did not come up"; tail -5 "$SANDBOX/share/serve.log"; exit 1; }
  sleep 0.5
done

# Verifikation: der Daemon muss auf $ANON_SOCK gehoert haben.
if ! grep -q "listening on $ANON_SOCK" "$SANDBOX/share/serve.log"; then
  echo "ERROR: daemon is NOT listening on the sandbox socket:"
  grep -o "listening on.*" "$SANDBOX/share/serve.log" | tail -1
  echo "  -> PYTHONPATH=$PYTHONPATH (must point at the repo)"
  exit 1
fi
echo "Daemon isolated: $ANON_SOCK"

# 7) Suitten laufen. Abbruch (Crash) zaehlt als FEHLER -- sonst ergibt ein
#    abgestuerzter Test still 0 Fehler, weil nie eine FAIL-Zeile gedruckt wird.
cd "$REPO/tests"
if [ "$#" -eq 0 ]; then
  set -- test_hooks.ts test_marker.ts test_single.ts test_denylist.ts test_raw.ts \
         test_trusted.ts test_offscope.ts test_reverse_always.ts test_cmdpath.ts \
         test_resolve.ts test_persist.ts test_persist_warm.ts test_progress.ts
fi
FAIL=0
FAILED=""
for t in "$@"; do
  echo
  echo "===== $t ====="
  if ! "$BUN" "$t" 2>&1; then
    FAIL=$((FAIL+1))
    FAILED="$FAILED $t"
  fi
done

echo
echo "=========================================="
if [ "$FAIL" -eq 0 ]; then
  echo "ALL SUITES GREEN ($# suites)"
else
  echo "$FAIL/$# SUITES FAILED:"
  for f in $FAILED; do echo "  - $f"; done
  exit 1
fi
