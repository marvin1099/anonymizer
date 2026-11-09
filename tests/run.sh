#!/bin/sh
# Run the isolated integration test suite.
#
# The suite must work from a fresh clone without touching the user's real
# configuration or daemon state. It therefore:
#
#   * Creates a unique temporary directory for config, socket, and state.
#   * Starts with fresh state for deterministic placeholder numbers.
#   * Points PYTHONPATH at this checkout, not an installed package copy.
#   * Verifies that the daemon listens on the isolated socket.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${BUN:-$(command -v bun 2>/dev/null || printf '%s' "$HOME/.bun/bin/bun")}"
VENV_PY="${ANON_PYTHON:-$REPO/daemon/.venv/bin/python3}"

[ -x "$BUN" ] || { echo "bun not found (set BUN=/path/to/bun)"; exit 1; }
[ -x "$VENV_PY" ] || { echo "Python venv not found at $VENV_PY (see README, 'Install -> Daemon'; or set ANON_PYTHON)"; exit 1; }

echo "== Python unit tests =="
PYTHONPATH="$REPO/daemon${PYTHONPATH:+:$PYTHONPATH}" \
  "$VENV_PY" -m unittest discover -s "$REPO/tests" -p 'test_*.py'

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/anon-free.XXXXXX")"

# Use a new sandbox for each run; never remove or reuse a fixed /tmp path.
mkdir -p "$SANDBOX/share" "$SANDBOX/config" "$SANDBOX/trusted" "$SANDBOX/roh"

# Build the plugin from this checkout before running the tests.
echo "== building plugin/dist =="
(cd "$REPO/plugin" && "$BUN" install --frozen-lockfile --silent && "$BUN" build ./index.ts \
  --outdir dist --target bun --format esm >/dev/null)

# Sandbox config: only these test folders are trusted. All other paths are
# filtered, regardless of the user's actual configuration.
cat > "$SANDBOX/config/anonymizer.json" <<JSON
{ "trustedPaths": ["$SANDBOX/trusted", "$SANDBOX/roh"] }
JSON

# Both the plugin and its child daemon inherit this isolated environment.
export ANON_SANDBOX="$SANDBOX"
export ANON_CONFIG="$SANDBOX/config/anonymizer.json"
export ANON_SOCK="$SANDBOX/share/anon.sock"
export ANON_STATE="$SANDBOX/share/state.json"
export ANON_PLUGIN="$REPO/plugin/dist/index.js"
export PYTHONPATH="$REPO/daemon${PYTHONPATH:+:$PYTHONPATH}"

if [ -z "${ANON_BIN:-}" ]; then
  ANON_BIN="$SANDBOX/bin/anon"
  mkdir -p "$SANDBOX/bin"
  cat > "$ANON_BIN" <<EOF
#!/bin/sh
export PYTHONPATH="$REPO/daemon\${PYTHONPATH:+:\$PYTHONPATH}"
exec "$VENV_PY" -m anonymizer.cli "\$@"
EOF
  chmod +x "$ANON_BIN"
fi
export ANON_BIN

# Start the sandbox daemon and verify that it listens on the sandbox socket.
echo "== starting isolated daemon (fresh state) =="
"$ANON_BIN" --serve > "$SANDBOX/share/serve.log" 2>&1 &
DAEMON=$!
cleanup() {
  kill "$DAEMON" 2>/dev/null || true
  wait "$DAEMON" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

i=0
while [ ! -S "$ANON_SOCK" ]; do
  i=$((i+1))
  [ "$i" -gt 240 ] && { echo "ERROR: sandbox socket did not come up"; tail -5 "$SANDBOX/share/serve.log"; exit 1; }
  sleep 0.5
done

# Verify the daemon is listening on the isolated socket.
if ! grep -q "listening on $ANON_SOCK" "$SANDBOX/share/serve.log"; then
  echo "ERROR: daemon is NOT listening on the sandbox socket:"
  grep -o "listening on.*" "$SANDBOX/share/serve.log" | tail -1
  echo "  -> PYTHONPATH=$PYTHONPATH (must point at the repo)"
  exit 1
fi
echo "Daemon isolated: $ANON_SOCK"

# A crash counts as a failure even if the test did not print a FAIL line.
cd "$REPO/tests"
if [ "$#" -eq 0 ]; then
  set -- test_hooks.ts test_marker.ts test_single.ts test_denylist.ts test_raw.ts \
         test_trusted.ts test_offscope.ts test_reverse_always.ts test_cmdpath.ts \
         test_resolve.ts test_persist.ts test_persist_warm.ts test_progress.ts
fi
FAIL=0
FAILED=""
for t in "$@"; do
  echo
  echo "===== $t ====="
  if ! "$BUN" "$t" 2>&1; then
    FAIL=$((FAIL+1))
    FAILED="$FAILED $t"
  fi
done

echo
echo "=========================================="
if [ "$FAIL" -eq 0 ]; then
  echo "ALL SUITES GREEN ($# suites)"
else
  echo "$FAIL/$# SUITES FAILED:"
  for f in $FAILED; do echo "  - $f"; done
  exit 1
fi
