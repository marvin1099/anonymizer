# anonymizer

Local, one-way PII anonymization for coding agents — for German and English text.

Everything runs on your machine. No cloud API, no telemetry. The tool replaces
names, locations, emails, phone numbers, IBANs and similar identifiers with
stable placeholders (`Peter Parker`, `Ort Berlin`, `peter.parker@example.com`, …), and can map them
back to the originals on demand. It was built as an OpenCode plugin plus a local
Python daemon, but both halves are usable on their own.

## Why

Coding agents inevitably see your files: configs, notes, tickets, logs. Most
anonymizers either send that data to a remote API or do a lossy regex scrub. This
one keeps a **reversible** mapping on disk that only you can read, so the model
works with placeholders while you still get the real values back where you need
them.

## Architecture

Three parts that talk to each other:

| Part | Location | Role |
| --- | --- | --- |
| Daemon | `daemon/` (Python) | Does the actual detection (NER + regex) and owns the placeholder mapping state |
| Plugin | `plugin/` (TypeScript) | Hooks into OpenCode and filters tool output / resolves placeholders in tool input |
| Skill | `skill/` (Markdown) | Teaches the model when to use the `anon` CLI and the marker syntax |

The plugin is a thin client: it talks to the daemon over a Unix socket and
auto-spawns the daemon if it is not running.

```
agent tool output ──▶ plugin hook ──▶ daemon (socket) ──▶ placeholders
agent tool input  ◀── plugin hook ◀── daemon (reverse map) ◀── real paths/names
```

## Trust model

- Trusted paths are an **allowlist**, not a denylist. Only files under a
  configured path may pass through unfiltered, and only via recognised file
  tools.
- The shell tool and every MCP tool are **always** filtered. The runtime can
  rename tools, so anything not explicitly allowlisted is treated as untrusted.
- A **denylist** beats the allowlist for state, logs, sessions and credentials —
  those are never raw, even inside trusted folders.

> **Warning:** everything under a trusted path is passed through *unfiltered*.
> Add folders deliberately.

## Install

### 1. Daemon

```bash
cd daemon
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/anon --text "Peter Parker aus Berlin"   # smoke test
```

Requires Python 3.12+. The NER model (gliner + torch) downloads on first use.
`--no-ner` skips it for regex-only operation.

### 2. Plugin (OpenCode)

```bash
cd plugin
bun add
bun build ./index.ts --outdir dist --target bun --format esm
cp -R . ~/.config/opencode/plugins/anonymizer
```

OpenCode auto-discovers plugins in `~/.config/opencode/plugins/`. Do **not** add
an explicit `plugins` entry to your config — loading it twice causes the marker
state to reset mid-session.

### 3. Trusted paths

Create `~/.config/opencode/anonymizer.json`. It is re-read whenever the file
changes, so adding a folder needs no restart.

```json
{
  "trustedPaths": [
    "/Users/you/Projects/anonymizer/",
    "/Users/you/.config/opencode/"
  ]
}
```

Prefix-match on directories, trailing slash included. `state.json`, logs,
sessions and credentials stay blocked regardless of what you list here.

## Usage

Anonymize a string, a file, or a directory:

```bash
anon --text "Peter Parker aus Berlin, Telefon +49 170 1234567"
anon --file note.txt --out note.anon.txt
anon --dir ./tickets --suffix .anon --include "*.md"
cat | anon --stdin
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--lang de\|en\|both` | Detector language (default `both`) |
| `--no-ner` | Regex only, no ML model |
| `--threshold 0.30` | NER confidence threshold |
| `--style placeholder\|numbered` | Placeholder rendering |
| `--json` | JSON report on stdout |
| `--with-originals` | Include originals in the JSON report |
| `--serve` | Run the socket daemon the plugin talks to |

### Markers

Markers are stripped from your message before the model sees them. They never
work in tool output — the model cannot switch the filter off for itself.

| Marker | Effect |
| --- | --- |
| `[[ANON:OFF]]` | Filtering off from the next user message until a plain message re-arms it |
| `[[ANON:ON]]` | Switch back on explicitly, same message allowed |
| `[[ANON:FORCED]]` | Filter even inside trusted paths, this request only |
| `[[ANON:RAW]]` | One request may read denylisted paths raw (a toast reminds you) |
| `[[ANON:S-OFF]]` | Make exactly one tool result raw |
| `[[ANON:S-FORCE]]` | Force one tool result through the filter |

Placeholders in your tool input are resolved back to real values automatically,
so `grep "Peter Parker"` searches for the actual name.

## Tests

The suites import `plugin/dist/index.js`, so build first.

```bash
cd plugin && bun build ./index.ts --outdir dist --target bun --format esm
cd ../tests
for m in strip-off strip-forced base-untrusted base-trusted forced-trusted \
         off reverse reverse-off reverse-stale reverse-path reverse-pathspan; do
  bun test_hooks.ts "$m"
done
for t in marker single denylist raw offscope reverse_always cmdpath trusted \
         resolve persist_warm; do
  bun "test_$t.ts"
done
```

Two things worth knowing when reading failures:

- The suites share one daemon socket. Stale mapping state from a previous run
  causes bogus failures — restart the daemon (`pkill -f "anon --serve"; rm -f
  anon.sock`) before trusting a red run.
- `state.json` is per-user accumulated mapping state. Tests that assume
  placeholder numbering starts at 1 only pass against a fresh state.

## State

The daemon keeps its placeholder → original table in `state.json`
(`~/.local/share/anonymizer/` by default). **This file is the complete inverse of
the anonymization** — it is the one thing that must never leave your machine, and
it is therefore listed in `.gitignore`.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
