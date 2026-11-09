"""Local anonymization agent (German and English), running in user mode.

Stage 1: deterministic rules and checksums
Stage 2: GLiNER NER (people, organizations, locations, addresses, ...)
Stage 3 (optional): a small local LLM via Ollama
"""

__version__ = "0.1.0"
