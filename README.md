# anonymizer

Local PII anonymization for coding agents — for German and English text.

Everything runs on your machine. No cloud API, no telemetry. The tool replaces
names, locations, emails, phone numbers, IBANs and similar identifiers with
stable placeholders (`[PERSON_1]`, `[LOC_1]`, `[EMAIL_1]`, …), and maps them
back to the originals when needed. Its primary use is as an OpenCode plugin,
which automatically filters agent tool output and resolves placeholders in
tool input. The local Python daemon also offers an optional CLI for anonymizing
text or files directly, outside OpenCode.

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
| Skill | `skill/` (Markdown) | Explains placeholders, markers, and safe handling to the coding agent |

The plugin is a thin client: it talks to the daemon over a Unix socket and
auto-spawns the daemon if it is not running.

```
agent tool output ──▶ plugin hook ──▶ daemon (socket) ──▶ placeholders
agent tool input  ◀── plugin hook ◀── daemon (reverse map) ◀── real paths/names
```

## OpenCode plugin (primary use)

In normal use, you do not run the anonymizer yourself: the plugin filters tool
output before the model sees it and resolves placeholders in tool input before
the tool runs.

### 1. Install the daemon

Run these commands from the project root. The plugin starts this executable
automatically when needed; by default it looks for `~/.local/bin/anon`.

```bash
python3 -m venv ~/.local/share/anonymizer/venv
~/.local/share/anonymizer/venv/bin/pip install ./daemon
mkdir -p ~/.local/bin
ln -s ~/.local/share/anonymizer/venv/bin/anon ~/.local/bin/anon
```

Requires Python 3.12+. The multilingual NER model (GLiNER + PyTorch) downloads
on first use. If NER fails while enabled, the tool returns an error rather than
silently falling back to regex-only filtering. If you install the executable
elsewhere, set `ANON_BIN` in OpenCode's environment to its path.

### 2. Install the plugin

```bash
cd plugin
bun install --frozen-lockfile
bun build ./index.ts --outdir dist --target bun --format esm
cp -R . ~/.config/opencode/plugins/anonymizer
```

OpenCode auto-discovers plugins in `~/.config/opencode/plugins/`. Do **not** add
an explicit `plugins` entry to your config — loading it twice causes the marker
state to reset mid-session.

### 3. Configure trusted paths

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

Paths are matched by prefix, including the trailing slash. `state.json`, logs,
sessions and credentials stay blocked regardless of what you list here.

### Plugin trust model

- Trusted paths are an **allowlist**, not a denylist. Only files under a
  configured path may pass through unfiltered, and only via recognised file
  tools.
- The shell tool and every MCP tool are **always** filtered. The runtime can
  rename tools, so anything not explicitly allowlisted is treated as untrusted.
- A **denylist** beats the allowlist for state, logs, sessions and credentials —
  those are never raw, even inside trusted folders.

> **Warning:** everything under a trusted path is passed through *unfiltered*.
> Add folders deliberately.

### Plugin markers

Markers are stripped from your message before the model sees them. They never
affect standalone CLI commands, and they never work in tool output — the model
cannot switch the filter off for itself.

| Marker | Effect |
| --- | --- |
| `[[ANON:OFF]]` | Filtering off from the next user message until a plain message re-arms it |
| `[[ANON:ON]]` | Switch back on explicitly, same message allowed |
| `[[ANON:FORCED]]` | Filter even inside trusted paths, this request only |
| `[[ANON:RAW]]` | One request may read denylisted paths raw (a toast reminds you) |
| `[[ANON:S-OFF]]` | Make exactly one tool result raw |
| `[[ANON:S-FORCE]]` | Force one tool result through the filter |

Placeholders in your tool input are resolved back to real values automatically,
so `grep "[PERSON_1]"` searches for the original name.

## Standalone CLI (optional)

Use the CLI when you want to anonymize text, files, or a directory yourself—for
example, to prepare material before sharing it. This is separate from the
plugin's normal workflow and does not require OpenCode. If you already installed
the daemon for the plugin above, its executable is at
`~/.local/share/anonymizer/venv/bin/anon`.

To install the daemon just for CLI use, run from `daemon/`:

```bash
python3 -m venv .venv
.venv/bin/pip install -e .
```

Then run it from `daemon/`:

```bash
.venv/bin/anon --text "Peter Parker aus Berlin, Telefon +49 30 23125 0"
.venv/bin/anon --file note.txt --out note.anon.txt
.venv/bin/anon --dir ./tickets --suffix .anon --include "*.md"
cat note.txt | .venv/bin/anon --stdin
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--lang de\|en\|both` | Detector language (default `both`) |
| `--no-ner` | Explicitly skip the ML model and use deterministic rules only |
| `--threshold 0.30` | NER confidence threshold |
| `--style placeholder\|numbered` | Placeholder rendering |
| `--json` | JSON report on stdout |
| `--with-originals` | Include originals in the JSON report |
| `--serve` | Run the socket daemon used by the OpenCode plugin |

## Tests

Install the daemon dependencies above and Bun, then run the isolated suite:

```bash
cd plugin && bun install --frozen-lockfile
cd ..
./tests/run.sh
```

The runner builds the plugin and starts a daemon with a new temporary socket,
configuration, and state file. It does not read or modify your real OpenCode
configuration or daemon state. German-language fixtures are intentional and
exercise German support alongside English fixtures.

## State

The daemon keeps its placeholder → original table in `state.json`
(`~/.local/share/anonymizer/` by default). **This file is the complete inverse of
the anonymization** — it is the one thing that must never leave your machine, and
it is therefore listed in `.gitignore`.

## License

GNU Affero General Public License v3.0. See [LICENSE](LICENSE).
