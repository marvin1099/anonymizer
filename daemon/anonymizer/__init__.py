"""Lokaler Anonymisierungs-Agent (DE+EN), usermode.

Stufe 1: deterministische Regeln + Pruefsummen
Stufe 2: GLiNER NER (Person, Organisation, Ort, Adresse, ...)
Stufe 3 (optional): kleines lokales LLM via Ollama
"""

__version__ = "0.1.0"
