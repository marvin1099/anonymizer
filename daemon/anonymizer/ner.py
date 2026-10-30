"""Stufe 2: NER via GLiNER (multilingual, laeuft auf Apple Silicon / CPU).

Das Modell ist der eigentliche Detektor -- Regex-Regeln in detectors.py decken
nur ab, was es nachweislich nicht leistet (Pruefsummen, exakte Formate).

Lange Texte: GLiNER schneidet auf 384 Tokens ab. Deshalb wird der Text in
Chunks zerlegt, die per Tokenizer *gemessen* unter diesem Budget bleiben, an
Zeilengrenzen enden und leicht ueberlappen (Entitaeten an Grenzen gehen sonst
verloren). Die Chunks werden gebündelt durch `batch_predict_entities` geschickt
-- das ist der Performance-Hebel (Faktor ~5 gegenueber Einzelaufrufen).
"""
from __future__ import annotations

import os

from .detectors import Span

MODEL_ID = os.environ.get("ANON_GLINER_MODEL", "urchade/gliner_multi_pii-v1")

# Labels, die dem GLiNER-Modell uebergeben werden.
LABELS = [
    "person",
    "organization",
    "location",
    "address",
    "email",
    "phone number",
    "date of birth",
    "credit card number",
    "bank account number",
    "iban",
    "tax identification number",
    "social security number",
    "passport number",
    "driver license number",
    "license plate",
    "ip address",
    "url",
    "username",
    "password",
]

# GLiNER-Label -> Ausgabe-Label
LABEL_MAP = {
    "person": "PERSON",
    "organization": "ORG",
    "location": "LOC",
    "address": "ADDRESS",
    "email": "EMAIL",
    "phone number": "PHONE",
    "date of birth": "DOB",
    "credit card number": "CREDIT_CARD",
    "bank account number": "BANK_ACCOUNT",
    "iban": "IBAN",
    "tax identification number": "TAX_ID",
    "social security number": "SOCIAL_SECURITY",
    "passport number": "PASSPORT",
    "driver license number": "DRIVER_LICENSE",
    "license plate": "LICENSE_PLATE",
    "ip address": "IP_ADDRESS",
    "url": "URL",
    "username": "USERNAME",
    "password": "PASSWORD",
}

# GLiNER truncatet bei 384 Tokens -> mit Puffer darunter bleiben.
MAX_TOKENS = 340
# Ueberlappung zwischen Chunks in Zeichen (faengt Entitaeten an Grenzen ab).
CHUNK_OVERLAP_CHARS = 120
# (Batching entfernt: verfälscht die Spans, kein Speedup)

# Notfall-Budget, falls der Tokenizer nicht erreichbar ist.
FALLBACK_CHUNK_CHARS = 900

_model = None


def _get_model():
    global _model
    if _model is None:
        import torch

        from gliner import GLiNER

        # Der Mac hat 10 Kerne, torch nutzt aber nur 4 -> ~20% mehr Durchsatz.
        try:
            torch.set_num_threads(os.cpu_count() or 4)
        except Exception:
            pass
        _model = GLiNER.from_pretrained(MODEL_ID)
    return _model


def preload_model():
    """Modell jetzt laden (Daemon-Start), damit spaetere Aufrufe warm sind."""
    _get_model()


def _tokenizer(model):
    dp = getattr(model, "data_processor", None)
    return getattr(dp, "transformer_tokenizer", None)


def _ntok(tok, text: str) -> int:
    return len(tok(text, add_special_tokens=False)["input_ids"])


def _hard_split(text: str, start: int, end: int, tok, budget: int):
    """Ein einzelner Abschnitt (z.B. eine Minidin ohne Zeilenumbruch) ist zu
    gross: per二分-Suche in Token-Budget-grosse Stuecke teilen."""
    lo, hi = start, end
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _ntok(tok, text[start:mid]) <= budget:
            lo = mid
        else:
            hi = mid - 1
    if lo <= start:
        lo = min(start + 1, end)
    if lo >= end:
        return
    yield (start, lo)
    yield from _hard_split(text, lo, end, tok, budget)


def _plan_chunks(text: str, model) -> list[tuple[int, int]]:
    """(start, end)-Offsets: token-budgetiert, zeilenweise geschnitten,
    ueberlappend. Deterministisch und auf den ganzen Text anwendbar."""
    n = len(text)
    if n == 0:
        return []
    tok = _tokenizer(model)
    if tok is None:
        # Kein Tokenizer: grobe Zeichenschuetzung.
        step = FALLBACK_CHUNK_CHARS
        chunks, pos = [], 0
        while pos < n:
            end = min(pos + step, n)
            if end < n:
                brk = text.rfind("\n", pos + step // 2, end)
                if brk != -1:
                    end = brk + 1
            chunks.append((pos, end))
            if end >= n:
                break
            pos = max(end - CHUNK_OVERLAP_CHARS, pos + 1)
        return chunks

    # Zeichen-pro-Token aus einer Stichprobe schaetzen, damit die Greife fuer
    # Zeilen billig bleiben; exakt geprueft wird danach mit dem Tokenizer.
    sample = text[:3000]
    n_ids = max(_ntok(tok, sample), 1)
    chars_per_token = max(len(sample) / n_ids, 1.0)
    soft_budget_chars = int(MAX_TOKENS * chars_per_token)

    # Zeilenspannen (inkl. Zeilenumbruch).
    line_spans: list[tuple[int, int]] = []
    start = 0
    for i, ch in enumerate(text):
        if ch == "\n":
            line_spans.append((start, i + 1))
            start = i + 1
    if start < n:
        line_spans.append((start, n))

    # Zeilenweise greedy fuellen; am Ende (bzw. bei Ueberlauf) exakt pruefen.
    raw: list[tuple[int, int]] = []

    def _emit(s: int, e: int) -> None:
        if e > s:
            raw.append((s, e))

    def _flush(s: int, e: int) -> None:
        if e <= s:
            return
        if _ntok(tok, text[s:e]) > MAX_TOKENS:
            for ps, pe in _hard_split(text, s, e, tok, MAX_TOKENS):
                _emit(ps, pe)
        else:
            _emit(s, e)

    cur_start: int | None = None
    cur_end = 0
    for ls, le in line_spans:
        if cur_start is None:
            cur_start, cur_end = ls, le
            continue
        if le - cur_start <= soft_budget_chars:
            cur_end = le
            continue
        _flush(cur_start, cur_end)
        cur_start, cur_end = ls, le
    if cur_start is not None:
        _flush(cur_start, cur_end)

    # Ueberlappung: jedes Stueck beginnt CHUNK_OVERLAP_CHARS frueher als das
    # vorige endet. Grenz-Entitaeten werden so zweimal gesehen; die Engine
    # dedupliziert ueberlappende Spans (laengster/hoechster Score gewinnt).
    planned: list[tuple[int, int]] = []
    for s, e in raw:
        if planned:
            s = max(s - CHUNK_OVERLAP_CHARS, planned[-1][0] + 1)
        fit = _fit_start(text, s, e, tok, MAX_TOKENS)
        if fit is not None:
            planned.append((fit, e))
        else:
            # Selbst ohne Ueberlappung zu gross: hart teilen (darf dann nicht
            # noch einmal ueberlappen, sonst wieder Budget-Ueberschreitung).
            for ps, pe in _hard_split(text, s, e, tok, MAX_TOKENS):
                planned.append((ps, pe))
    return planned


def _fit_start(text: str, start: int, end: int, tok, budget: int) -> int | None:
    """Kleinster Startpunkt ab `start`, bei dem [start, end) noch in das
    Token-Budget passt -- None, wenn selbst der Start zu gross ist.
    Wird gebraucht, weil die Ueberlappung erst NACH dem Zuschnitt dazukommt
    und sonst das Budget sprengt (GLiNER warnt dann 'truncated to 384')."""
    lo, hi, best = start, end, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if _ntok(tok, text[mid:end]) <= budget:
            best = mid
            hi = mid - 1
        else:
            lo = mid + 1
    return best


def detect_ner(text: str, threshold: float = 0.45, progress=None) -> list[Span]:
    model = _get_model()
    chunks = _plan_chunks(text, model)
    if not chunks:
        return []
    out: list[Span] = []
    best: dict[tuple[int, int], float] = {}
    for idx, (cs, ce) in enumerate(chunks, start=1):
        # Bewusst EINZELN pro Chunk, nicht batch_predict_entities: beim Batching
        # paddet GLiNER auf die laengste Sequenz des Batches und liefert dann
        # schlechtere Spans (gemessen: Logins "e.mertens" 1/4 statt 4/4).
        # Batching brachte keinen messbaren Durchsatzgewinn (4.5-4.6 chunks/s
        # bei Batch 4/8/16/32/48), deshalb ist es raus.
        for e in model.predict_entities(text[cs:ce], LABELS, threshold=threshold):
            s = cs + int(e["start"])
            en = cs + int(e["end"])
            if en <= s or en > len(text):
                continue
            # Leerraum am Span-Rand abschneiden (sonst Textverlust beim Replace).
            while s < en and text[s].isspace():
                s += 1
            while en > s and text[en - 1].isspace():
                en -= 1
            score = float(e.get("score", 1.0))
            key = (s, en)
            if best.get(key, -1.0) >= score:
                continue
            best[key] = score
            label = LABEL_MAP.get(e["label"], str(e["label"]).upper().replace(" ", "_"))
            out.append(Span(label, s, en, text[s:en], score, "ner"))
        if progress is not None:
            # Fortschritt pro Chunk: die Wartezeit (Ganzdatei ~25 s) soll im UI
            # sichtbar sein, damit sie nicht wie ein Haenger wirkt.
            progress(idx, len(chunks))
    out.sort(key=lambda sp: sp.start)
    return out