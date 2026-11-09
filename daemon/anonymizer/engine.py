"""Merge detections, resolve conflicts, and replace entities (one-way)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .detectors import Span, detect_rules, DEFAULT_OFF, PATTERNS
from . import ner as ner_mod


@dataclass
class Replacement:
    label: str
    original: str
    placeholder: str
    start: int
    end: int
    source: str
    score: float


@dataclass
class Result:
    text: str
    replacements: list[Replacement] = field(default_factory=list)

    @property
    def counts(self) -> dict[str, int]:
        c: dict[str, int] = {}
        for r in self.replacements:
            c[r.label] = c.get(r.label, 0) + 1
        return c


_SOURCE_RANK = {"rule": 2, "llm": 3, "ner": 1}


def _resolve_overlaps(spans: list[Span]) -> list[Span]:
    # Prefer longer spans, then rules over NER, then higher confidence scores.
    ordered = sorted(
        spans,
        key=lambda s: (-(s.end - s.start), -_SOURCE_RANK.get(s.source, 0), -s.score),
    )
    chosen: list[Span] = []
    for s in ordered:
        if any(s.start < c.end and c.start < s.end for c in chosen):
            continue
        chosen.append(s)
    chosen.sort(key=lambda s: s.start)
    return chosen


_TITLES = re.compile(r"^(herrn?|frau|frauen|dr\.?|prof\.?|mag\.?|ing\.?|dipl[\-\s]?ing\.?)+\s+", re.IGNORECASE)

# Existing placeholders must not be detected again: GLiNER might classify the
# literal text "Anna Example" as a person, assign a new number, and corrupt the
# reverse mapping. Mask placeholders before detection while preserving string
# length and offsets, then discard any spans that overlap them.
_PLACEHOLDER_RE = re.compile(r"\[\[[A-Z][A-Z_]*_\d+\]\]|\[[A-Z][A-Z_]*_\d+\]|\[[A-Z][A-Z_]*\]")


def _mask_placeholders(text: str) -> tuple[str, list[tuple[int, int]]]:
    spans = [(m.start(), m.end()) for m in _PLACEHOLDER_RE.finditer(text)]
    if not spans:
        return text, []
    chars = list(text)
    for s, e in spans:
        for i in range(s, e):
            if chars[i] != "[" and chars[i] != "]":
                chars[i] = "x"
    return "".join(chars), spans


def _norm(text: str) -> str:
    # Remove titles and honorifics so "Mr Peter Schmidt" == "Peter Schmidt".
    return re.sub(r"\s+", " ", _TITLES.sub("", text.strip()).lower())


def anonymize(
    text: str,
    *,
    lang: str = "both",
    use_ner: bool = True,
    threshold: float = 0.30,
    style: str = "numbered",
    include: set[str] | None = None,
    exclude: set[str] | None = None,
    extra_spans: list[Span] | None = None,
    state: dict | None = None,
    progress=None,
) -> Result:
    """Anonymize text, optionally preserving placeholder numbering in daemon state."""
    enabled_rules = None
    if include is not None:
        enabled_rules = set(include)
    elif lang == "en":
        enabled_rules = {lbl for lbl, *_ in PATTERNS} - {"TAX_ID", "VAT_ID"}
    # Detect entities in the masked text, but apply replacements to the original.
    masked, ph_spans = _mask_placeholders(text)
    spans = detect_rules(masked, enabled=enabled_rules)
    spans = [s for s in spans if s.label not in DEFAULT_OFF]

    if use_ner:
        try:
            spans += ner_mod.detect_ner(masked, threshold=threshold, progress=progress)
        except Exception as exc:
            # Never silently degrade to regex-only filtering: that could let
            # names, locations, and other NER-only data reach the model.
            raise RuntimeError("NER detection failed; refusing to return unfiltered text") from exc

    if extra_spans:
        spans += extra_spans

    if include is not None:
        spans = [s for s in spans if s.label in include]
    if exclude:
        spans = [s for s in spans if s.label not in exclude]

    # Do not replace any text inside an existing placeholder.
    if ph_spans:
        spans = [
            s for s in spans if not any(s.start < e and st < s.end for st, e in ph_spans)
        ]

    spans = _resolve_overlaps(spans)

    if state is None:
        counters: dict[str, int] = {}
        seen: dict[tuple[str, str], str] = {}
    else:
        # Persistent daemon numbering: the same value keeps the same
        # placeholder across requests and sessions.
        counters = state.setdefault("counters", {})
        seen = state.setdefault("seen", {})
    replacements: list[Replacement] = []
    # Persist exact originals in daemon state so the plugin can reverse-map
    # paths and files after a plugin reload or daemon restart.
    exact: dict[str, str] = state.setdefault("exact", {}) if state is not None else {}
    for s in spans:
        key = (s.label, _norm(s.text))
        if style == "numbered":
            if key not in seen:
                counters[s.label] = counters.get(s.label, 0) + 1
                seen[key] = f"[{s.label}_{counters[s.label]}]"
            placeholder = seen[key]
            if placeholder not in exact:
                exact[placeholder] = s.text
        else:
            placeholder = f"[{s.label}]"
        replacements.append(
            Replacement(s.label, s.text, placeholder, s.start, s.end, s.source, s.score)
        )

    # Alias propagation (without a name list): if a unique part of a detected
    # person name also appears alone ("Contact Anna"), use the same
    # placeholder as the full name.
    persons = [r for r in replacements if r.label == "PERSON"]
    for full in persons:
        tokens = [t for t in re.split(r"[\s,]+", full.original) if len(t) >= 4]
        for tok in tokens:
            tok_l = tok.lower()
            if any(
                r is not full
                and tok_l in {t2.lower() for t2 in re.split(r"[\s,]+", r.original)}
                for r in persons
            ):
                continue  # Ambiguous ("Anna" in Anna Example and Anna Sample).
            for m in re.finditer(
                r"(?<![A-Za-z0-9._-])" + re.escape(tok) + r"(?![A-Za-z0-9._-])", text
            ):
                s, e = m.start(), m.end()
                if any(s < r.end and r.start < e for r in replacements):
                    continue  # Already belongs to a detected span.
                replacements.append(
                    Replacement("PERSON", tok, full.placeholder, s, e, "alias", 0.95)
                )

    # Alias spans must not overlap other detections. Discard an alias if it
    # collides with a span already retained.
    kept: list[Replacement] = []
    for r in replacements:
        if r.source == "alias" and any(
            r.start < o.end and o.start < r.end for o in kept
        ):
            continue
        kept.append(r)
    replacements = kept

    out = text
    for r in sorted(replacements, key=lambda r: r.start, reverse=True):
        out = out[: r.start] + r.placeholder + out[r.end :]
    return Result(out, replacements)
