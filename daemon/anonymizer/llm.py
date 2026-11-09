"""Optional stage 3: use a small local Ollama model for context-dependent cases."""
from __future__ import annotations

import json
import urllib.request

from .detectors import Span

OLLAMA_URL = "http://localhost:11434/api/chat"
DEFAULT_MODEL = "qwen2.5:7b"

_SYSTEM = (
    "You are a precise PII detector. Find personal and business data in any "
    "language, including German and English: names, organizations, addresses, "
    "phone numbers, IBANs, tax IDs, identifiers, email addresses, and dates of "
    "birth. Reply with JSON only."
)


def _post(payload: dict, timeout: int = 180) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(OLLAMA_URL, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def chat(prompt: str, model: str = DEFAULT_MODEL, system: str | None = None) -> str:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    out = _post({"model": model, "messages": messages, "stream": False})
    return out.get("message", {}).get("content", "")


def llm_spans(text: str, model: str = DEFAULT_MODEL) -> list[Span]:
    prompt = (
        "Find all sensitive entities in the following text. Preserve each "
        "entity exactly as written.\n"
        'Return JSON: {"entities":[{"text":"<exact substring>","label":"PERSON|ORG|ADDRESS|LOC|EMAIL|PHONE|IBAN|TAX_ID|ID|DOB"}]}\n\n'
        f"TEXT:\n{text}"
    )
    try:
        raw = chat(prompt, model=model, system=_SYSTEM)
    except Exception:
        return []
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(raw)
    except Exception:
        return []
    spans: list[Span] = []
    for ent in data.get("entities", []):
        needle = (ent.get("text") or "").strip()
        if not needle:
            continue
        label = (ent.get("label") or "ID").upper()
        idx = 0
        while True:
            i = text.find(needle, idx)
            if i < 0:
                break
            spans.append(Span(label, i, i + len(needle), needle, 0.8, "llm"))
            idx = i + len(needle)
    return spans


def run_task(text: str, task: str, model: str = DEFAULT_MODEL) -> str:
    return chat(f"{task}\n\nTEXT:\n{text}", model=model)
