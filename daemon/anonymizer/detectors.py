"""Stage 1: deterministic detection of structured identifiers.

Focused on Germany and English-language data. Checksum validation is used
where available (IBAN mod-97, Luhn, ISO 7064 for German tax IDs).
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class Span:
    label: str
    start: int
    end: int
    text: str
    score: float = 1.0
    source: str = "rule"


def iban_valid(raw: str) -> bool:
    s = re.sub(r"\s+", "", raw).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{10,30}", s):
        return False
    rearranged = s[4:] + s[:4]
    digits = "".join(str(int(c, 36)) for c in rearranged)
    return int(digits) % 97 == 1


def luhn_valid(raw: str) -> bool:
    digits = [int(c) for c in raw if c.isdigit()]
    if not 12 <= len(digits) <= 19:
        return False
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def de_taxid_valid(raw: str) -> bool:
    """Validate a German tax identification number (IdNr), ISO 7064 MOD 11,10."""
    s = raw.replace(" ", "")
    if not re.fullmatch(r"\d{11}", s) or s[0] == "0":
        return False
    p = 10
    for ch in s[:-1]:
        m = (int(ch) + p) % 10
        if m == 0:
            m = 10
        p = (2 * m) % 11
    check = 11 - p
    if check == 10:
        check = 0
    return check == int(s[-1])


# Keep the rule set intentionally small: GLiNER (ner.py) handles most entity
# detection. This file covers formats that NER does not reliably detect:
#   * Checksummed values (IBAN mod-97, Luhn, ISO 7064)
#   * Strict formats (email, IP, MAC; NER can confuse MAC and IP addresses)
#   * Bare 11-15 digit strings (international phone numbers without separators)
# Avoid country-specific phone-format rules: they require manual upkeep and
# create false positives. The model handles German, UK, and US phone formats.
PATTERNS: list[tuple[str, re.Pattern, object]] = [
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), None),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b"), iban_valid),
    ("CREDIT_CARD", re.compile(r"\b(?:\d[ \-]?){12,18}\d\b"), luhn_valid),
    ("TAX_ID", re.compile(r"\b\d{2}[ /]?\d{3}[ /]?\d{3}[ /]?\d{3}\b"), de_taxid_valid),
    ("IP_ADDRESS", re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b"), None),
    ("MAC_ADDRESS", re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b"), None),
    ("PHONE", re.compile(r"\b\d{11,15}\b"), None),
    # Corporate login format, e.g. "e.mertens" or "(a.barazi)": one initial,
    # a dot, and a surname. This is a format, not name recognition. GLiNER can
    # miss these tokens in parentheses after timestamps. The one-character
    # prefix avoids matching strings such as "io.netty" or "app.min". The
    # lookbehind excludes paths ("/etc/x.conf"), which must remain exact for
    # reverse mapping.
    ("USERNAME", re.compile(r"(?<![A-Za-z0-9./_-])[a-z]\.[a-z]{3,14}(?![a-z0-9])"), None),
]

# No labels are disabled by default; unreliable date and postal-code rules
# were removed.
DEFAULT_OFF: set[str] = set()


def detect_rules(text: str, enabled: set[str] | None = None) -> list[Span]:
    spans: list[Span] = []
    for label, pattern, validator in PATTERNS:
        if enabled is not None and label not in enabled:
            continue
        for m in pattern.finditer(text):
            raw = m.group(0)
            if validator is not None and not validator(raw):
                continue
            spans.append(Span(label, m.start(), m.end(), raw, 1.0, "rule"))
    return spans
