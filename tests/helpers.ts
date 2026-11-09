// Shared test helpers. No suite embeds a developer-specific home path.
//
// The test runner uses an isolated sandbox and never modifies user config:
//
//   * ANON_CONFIG/ANON_SOCK/ANON_STATE/ANON_SANDBOX come from run.sh and point
//     to a fresh temporary directory. test_trusted.ts creates its own sandbox
//     config via the environment; it never opens or overwrites user config.
//
//   * Tests that require filtering use an entity in the path. A generic path
//     has no matches and stays literal, so the filtering would not be visible.
//     randomUntrusted() creates a unique path for those cases.
//
//   * Paths that should remain raw must be allowlisted: either built-in paths
//     (BUILTIN_RAW) or sandbox paths (TRUSTED_*).
import { connect } from "node:net"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"

const HOME = homedir()

// Derive the repo root from this file so tests always use this checkout's
// plugin build (created by run.sh).
const REPO = resolve(import.meta.dir, "..")

// The runner sets this to a fresh temporary directory.
export const SANDBOX = process.env.ANON_SANDBOX ?? "/tmp/anon-free"

// Plugin-Quelle: Repo-Build, damit die Tests die File testen, die im Repo liegt.
export const PLUGIN_DIST = process.env.ANON_PLUGIN ?? resolve(REPO, "plugin/dist/index.js")

// Socket und State der Sandbox: eigener Daemon, eigener Zaehlerstand.
export const SOCK = process.env.ANON_SOCK ?? `${SANDBOX}/share/anon.sock`
export const STATE = process.env.ANON_STATE ?? `${SANDBOX}/share/state.json`

// Sandbox config created by run.sh; never use the user's real config.
export const SANDBOX_CONFIG = process.env.ANON_CONFIG ?? `${SANDBOX}/config/anonymizer.json`

// Listed as trusted in the sandbox config, so content stays raw.
export const TRUSTED_DIR = `${SANDBOX}/trusted`
export const TRUSTED_FILE = `${TRUSTED_DIR}/notiz.md`

// Built-in allowlist path that is not denied. The file need not exist; the
// plugin makes its decision by inspecting the path string.
export const BUILTIN_RAW = `${HOME}/.config/opencode/plugins/x/y.ts`

// Denylist path nested inside a trusted folder, verifying that deny rules
// override allow rules. Matching is based on path suffixes.
export const DENIED = `${TRUSTED_DIR}/.local/share/anonymizer/state.json`

// Absolute path in the allowlist but without an entity: the path stays literal,
// while its content is filtered. Use a path with an entity to test path masking.
export const LITERAL = `${SANDBOX}/fremd/datei.md`

export const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 30 23125 0."

/** Fail fast if tests are not using an isolated daemon and state directory. */
export function ensureSandboxEnv(): void {
  const missing = ["ANON_SOCK", "ANON_STATE", "ANON_CONFIG"].filter((k) => !process.env[k])
  if (missing.length) {
    throw new Error(
      `Tests ohne Sandbox-Umgebung (fehlt: ${missing.join(", ")}).\n` +
      `Run tests/run.sh to isolate the daemon, config, and state in ${SANDBOX}.`,
    )
  }
}

/** Create a unique untrusted path containing an entity so path masking is visible. */
export function randomUntrusted(): string {
  const dir = `${SANDBOX}/Anna Mueller-${Math.random().toString(36).slice(2, 8)}`
  mkdirSync(dir, { recursive: true })
  const file = `${dir}/geheim.md`
  writeFileSync(file, PII)
  return file
}

/** Load a fresh plugin instance and capture its hooks for an isolated case. */
export async function freshPlugin(): Promise<Record<string, (e: any) => Promise<void> | void>> {
  const mod: any = await import(`${PLUGIN_DIST}?case=${Math.random()}`)
  const d: any = mod?.default ?? mod
  const H: Record<string, (e: any) => Promise<void> | void> = {}
  const ctx: any = {
    client: { tui: { showToast: () => Promise.resolve(true) } },
    session: { hook: async (n: string, f: any) => { H[n] = f } },
    tool: { hook: async (n: string, f: any) => { H[n] = f } },
  }
  await (d.setup ?? d.default.setup)(ctx)
  return H
}

/** Process prompt markers before a request. */
export async function runPrompt(text: string, H?: Record<string, any>): Promise<string> {
  const hooks = H ?? (await freshPlugin())
  const ev: any = { prompt: { text } }
  await hooks["prompt"](ev)
  return ev.prompt.text as string
}

/** Filter a tool result. Reuse the same hook instance to preserve marker state. */
export async function after(
  H: Record<string, any>,
  input: unknown,
  content = PII,
  tool = "read",
): Promise<string> {
  const ev: any = { tool, input, status: "completed", result: { content } }
  await H["execute.after"](ev)
  return ev.result.content as string
}

export const HOME_DIR = HOME

export const isRaw = (s: string) => s === PII
// [ANON_ERROR] means the daemon did not respond; it must not count as a
// successful filtering result.
export const isAnon = (s: string) =>
  !s.includes("peter.parker@example.com") && s.includes("[") && !s.includes("[ANON_ERROR]")

let failures = 0
export function check(name: string, ok: boolean, info = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}
export function finish(label: string): never {
  console.log(failures === 0 ? `\n== ${label} ==` : `\n== ${failures} FAILURES ==`)
  process.exit(failures === 0 ? 0 : 1)
}

/** Send a daemon request over the sandbox socket. */
export function send(payload: unknown): Promise<any | null> {
  return new Promise((resolve) => {
    const s = connect(SOCK)
    let buf = ""
    const finishReq = (v: any | null) => {
      s.removeAllListeners()
      s.destroy()
      resolve(v)
    }
    s.setTimeout(240_000, () => finishReq(null))
    s.on("error", () => finishReq(null))
    s.on("data", (c) => {
      buf += c.toString("utf8")
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      try { finishReq(JSON.parse(buf.slice(0, nl))) } catch { finishReq(null) }
    })
    s.on("connect", () => s.write(JSON.stringify(payload) + "\n"))
  })
}
