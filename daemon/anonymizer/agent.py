"""Anon-Agent: Wrapper around OpenCode with the local Ollama model.

Usage:
  anon-agent "Read my browser tab and summarize it"
  anon-agent "Run /path/to/script.py and tell me the output"

This delegates to: opencode run --model ollama/qwen2.5:7b "$@"
The local model runs inside OpenCode's harness, so it has ALL tools:
browser-control MCP, shell, file system, skills (including anonymizer).

The model receives simple instructions: do the task, run result through
anon, save to file, return <return>ANSWER</return>.
"""

from __future__ import annotations

import re
import subprocess
import sys

INSTRUCTIONS = """You will get a simple task. Do it, then run the result through the anon tool and save to a file. Use <return>ANSWER</return> where ANSWER is: I did what you requested and anonymized it, the file is saved in PATH.

TASK:
"""


def extract_return(text: str) -> str:
    """Extract content from <return>...</return> tags."""
    match = re.search(r"<return>(.*?)</return>", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return text.strip()


def main():
    if len(sys.argv) < 2:
        print("Usage: anon-agent \"TASK DESCRIPTION\"")
        print()
        print("Delegates to: opencode run --model ollama/qwen2.5:7b \"TASK\"")
        print()
        print("Examples:")
        print('  anon-agent "Read my current browser tab and summarize"')
        print('  anon-agent "Run /path/to/script.py and tell me the output"')
        print('  anon-agent "Read /path/to/file.txt and summarize"')
        sys.exit(1)

    task = " ".join(sys.argv[1:])
    full_prompt = INSTRUCTIONS + task

    cmd = ["opencode", "run", "--model", "ollama/qwen2.5:7b", full_prompt]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        output = result.stdout + result.stderr
        print(extract_return(output))
        sys.exit(result.returncode)
    except FileNotFoundError:
        print("Error: 'opencode' not found in PATH.", file=sys.stderr)
        print("Make sure OpenCode is installed and in your PATH.", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
