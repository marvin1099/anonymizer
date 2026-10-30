"""Stufe 1: deterministische Erkennung von strukturierten Identifikatoren.

Deutschland/EN-Fokus. Wo moeglich mit Pruefsumme (IBAN mod-97, Luhn,
ISO 7064 fuer die deutsche Steuer-ID).
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
    """Deutsche Steuer-Identifikationsnummer (IdNr), ISO 7064 MOD 11,10."""
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


# Regel-Set bewusst KLEIN gehalten: die Erkennung macht primaer das Modell
# (GLiNER, ner.py). Hier steht nur, was das Modell nachweislich nicht leistet:
#   * Pruefsummen-Formate (IBAN mod-97, Luhn, ISO 7064) -- das kann kein NER
#   * exakt deterministische Formate (E-Mail, IP, MAC -- das Modell verwechselt
#     MAC mit IP und laesst sie manchmal weg)
#   * nackte 11-15-stellige Ziffernbloecke (internationale Mobilnummer ohne
#     Trenner -- im dichten CSV verliert das Modell sie haeufig)
# Bewusst KEINE laenderspezifischen Telefon-/Format-Physiognomien mehr: das
# war Handpflege und erzeugte False Positives. Das Modell deckt DE/UK/US-Telefon-
# formate selbst ab.
PATTERNS: list[tuple[str, re.Pattern, object]] = [
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), None),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b"), iban_valid),
    ("CREDIT_CARD", re.compile(r"\b(?:\d[ \-]?){12,18}\d\b"), luhn_valid),
    ("TAX_ID", re.compile(r"\b\d{2}[ /]?\d{3}[ /]?\d{3}[ /]?\d{3}\b"), de_taxid_valid),
    ("IP_ADDRESS", re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b"), None),
    ("MAC_ADDRESS", re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b"), None),
    ("PHONE", re.compile(r"\b\d{11,15}\b"), None),
    # Login-Kennungen der Firm-IT: "e.mertens", "(a.barazi)", "example-user".
    # Ein Zeichen Praefix + Punkt + Nachname. Das ist ein FORMAT, keine
    # Namenserkennung -- GLiNER erkennt diese Tokens hinter Zeitstempeln in
    # Klammern nur unzuellaessig (gemessen: 5 von 12 im CMDB-Export).
    # Praefix bewusst genau EIN Zeichen: "io.netty" oder "app.min" sollen nicht
    # matchen. Lookbehind schliesst Pfade aus ("/etc/x.conf" bleibt lesbar),
    # weil Pfade fuer das Reverse-Mapping exakt bleiben muessen.
    ("USERNAME", re.compile(r"(?<![A-Za-z0-9./_-])[a-z]\.[a-z]{3,14}(?![a-z0-9])"), None),
]

# Aktuell ist kein Label standardmaessig abgeschaltet (die fehleranfaelligen
# Datum/PLZ-Muster wurden entfernt).
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
