"""Zusammenfuehren, Konflikte aufloesen und ersetzen (einweg)."""
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
    # Laengste zuerst, dann Regel vor NER, dann hoehere Score.
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

# Eigene Platzhalter (Anna Müller, /Users/example-user/y.json, [PERSON_1]-Escapes) duerfen NICHT
# erneut erkannt werden: sonst labelt GLiNER den literalen Text "Anna Müller" als
# Person, vergibt eine neue Nummer und das Reverse-Mapping wird zu Muell
# ("[PERSON_1]" -> "Anna Müller"). Beim Schreiben landet dann Platzhalter-Text
# auf der Platte. Deshalb: vor der Erkennung maskiert (Laenge bleibt gleich,
# Offsets bleiben gueltig), Spans die darauf liegen werden verworfen.
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
    # Titel/Höflichkeitsformen raus, damit "Herrn Peter Schmidt" == "Peter Schmidt"
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
    """state: optionale, persistente Zaehler/Seen-Map (Daemon),
    damit gleiche Werte ueber Aufrufe hinweg immer denselben Placeholder behalten."""
    enabled_rules = None
    if include is not None:
        enabled_rules = set(include)
    elif lang == "en":
        enabled_rules = {lbl for lbl, *_ in PATTERNS} - {"TAX_ID", "VAT_ID"}
    # Erkennung laeuft auf maskiertem Text, Ausgabe bleibt der Originaltext.
    masked, ph_spans = _mask_placeholders(text)
    spans = detect_rules(masked, enabled=enabled_rules)
    spans = [s for s in spans if s.label not in DEFAULT_OFF]

    if use_ner:
        try:
            spans += ner_mod.detect_ner(masked, threshold=threshold, progress=progress)
        except Exception:
            pass

    if extra_spans:
        spans += extra_spans

    if include is not None:
        spans = [s for s in spans if s.label in include]
    if exclude:
        spans = [s for s in spans if s.label not in exclude]

    # Nichts ueber einem Platzhalter ersetzen.
    if ph_spans:
        spans = [
            s for s in spans if not any(s.start < e and st < s.end for st, e in ph_spans)
        ]

    spans = _resolve_overlaps(spans)

    if state is None:
        counters: dict[str, int] = {}
        seen: dict[tuple[str, str], str] = {}
    else:
        # Persistente Nummerierung (Daemon): gleicher Wert -> gleicher Placeholder
        # ueber alle Anfragen/Session hinweg.
        counters = state.setdefault("counters", {})
        seen = state.setdefault("seen", {})
    replacements: list[Replacement] = []
    # Reverse-Lookup-Tabelle (nur im persistenten Daemon-State): exaktes
    # Original je Placeholder, damit das Plugin auch NACH einem Plugin-Reload
    # oder Daemon-Neustart Pfade/Dateien wieder zurueckuebersetzen kann
    # (z.B. /Users/[USERNAME_1]/... -> /Users/example-user/...).
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

    # Alias-Passing (keine Namensliste!): Ist ein Wortteil eines bekannten
    # PERSON-Spans solo im Dokument ("Kontakt Anna"), bekommt derselbe
    # Placeholder wie der volle Name ("Anna Müller"). Nur wenn eindeutig.
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
                continue  # mehrdeutig ("Anna" in Anna Mueller und Anna Schmidt)
            for m in re.finditer(
                r"(?<![A-Za-z0-9._-])" + re.escape(tok) + r"(?![A-Za-z0-9._-])", text
            ):
                s, e = m.start(), m.end()
                if any(s < r.end and r.start < e for r in replacements):
                    continue  # gehoert schon zu einem Span
                replacements.append(
                    Replacement("PERSON", tok, full.placeholder, s, e, "alias", 0.95)
                )

    out = text
    for r in sorted(replacements, key=lambda r: r.start, reverse=True):
        out = out[: r.start] + r.placeholder + out[r.end :]
    return Result(out, replacements)
