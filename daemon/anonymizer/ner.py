"""Stage 2: NER via GLiNER (multilingual; runs on Apple Silicon and CPU).

The model handles general entity detection. Regex rules in detectors.py cover
formats it does not reliably detect, such as checksummed and exact formats.

GLiNER truncates inputs at 384 tokens. Long text is split into tokenizer-sized
chunks that end on line boundaries and overlap slightly so entities at chunk
boundaries are not lost. Chunks are predicted individually because batching
reduced span quality and did not improve throughput in testing.
"""
from __future__ import annotations

import os

from .detectors import Span

MODEL_ID = os.environ.get("ANON_GLINER_MODEL", "urchade/gliner_multi_pii-v1")

# Labels passed to the GLiNER model.
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

# GLiNER label -> output label.
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

# GLiNER truncates inputs at 384 tokens; stay below that limit with a buffer.
MAX_TOKENS = 340
# Chunk overlap in characters, to catch entities at boundaries.
CHUNK_OVERLAP_CHARS = 120
# Batching was removed: it degraded spans and did not improve throughput.

# Fallback chunk size when no tokenizer is available.
FALLBACK_CHUNK_CHARS = 900

_model = None


def _get_model():
    global _model
    if _model is None:
        import torch

        from gliner import GLiNER

        # Use all available CPU cores where supported.
        try:
            torch.set_num_threads(os.cpu_count() or 4)
        except Exception:
            pass
        _model = GLiNER.from_pretrained(MODEL_ID)
    return _model


def preload_model():
    """Load the model during daemon startup so later requests are warm."""
    _get_model()


def _tokenizer(model):
    dp = getattr(model, "data_processor", None)
    return getattr(dp, "transformer_tokenizer", None)


def _ntok(tok, text: str) -> int:
    return len(tok(text, add_special_tokens=False)["input_ids"])


def _hard_split(text: str, start: int, end: int, tok, budget: int):
    """Split an oversized section (for example, a long line) by token budget."""
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
    """Return deterministic, token-budgeted, line-aware overlapping offsets."""
    n = len(text)
    if n == 0:
        return []
    tok = _tokenizer(model)
    if tok is None:
        # Without a tokenizer, use a conservative character-based estimate.
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

    # Estimate characters per token from a sample to keep line grouping cheap;
    # verify exact token counts afterward.
    sample = text[:3000]
    n_ids = max(_ntok(tok, sample), 1)
    chars_per_token = max(len(sample) / n_ids, 1.0)
    soft_budget_chars = int(MAX_TOKENS * chars_per_token)

    # Line spans, including their newline characters.
    line_spans: list[tuple[int, int]] = []
    start = 0
    for i, ch in enumerate(text):
        if ch == "\n":
            line_spans.append((start, i + 1))
            start = i + 1
    if start < n:
        line_spans.append((start, n))

    # Greedily group lines, then verify each chunk's exact token count.
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

    # Overlap chunks so boundary entities appear twice; the engine deduplicates
    # overlapping spans, preferring longer spans and higher scores.
    planned: list[tuple[int, int]] = []
    for s, e in raw:
        if planned:
            s = max(s - CHUNK_OVERLAP_CHARS, planned[-1][0] + 1)
        fit = _fit_start(text, s, e, tok, MAX_TOKENS)
        if fit is not None:
            planned.append((fit, e))
        else:
            # Still too large without overlap: split directly, without adding
            # overlap that would exceed the token budget again.
            for ps, pe in _hard_split(text, s, e, tok, MAX_TOKENS):
                planned.append((ps, pe))
    return planned


def _fit_start(text: str, start: int, end: int, tok, budget: int) -> int | None:
    """Find the earliest start whose [start, end) range fits the token budget.

    Return None if the range is too large even without overlap. This is needed
    because overlap is added after chunking and could otherwise exceed the
    model's token limit.
    """
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
        # Predict each chunk individually instead of using batch_predict_entities:
        # padding to the longest sequence degraded spans, and batching did not
        # measurably improve throughput in tests.
        for e in model.predict_entities(text[cs:ce], LABELS, threshold=threshold):
            s = cs + int(e["start"])
            en = cs + int(e["end"])
            if en <= s or en > len(text):
                continue
            # Trim whitespace at span edges to avoid losing text on replacement.
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
            # Report progress per chunk so long files do not look stalled.
            progress(idx, len(chunks))
    out.sort(key=lambda sp: sp.start)
    return out
