// Trusted paths come from an isolated test config.
//
// This test used to overwrite ~/.config/opencode/anonymizer.json and restore
// it in a finally block. That made it machine-specific and unsafe:
//   * An interruption could destroy the user's real paths.
//   * The test only passed when the manual config happened to match.
//   * Concurrent test runs could interfere with each other.
//
// Now it creates a private sandbox config and sets ANON_CONFIG before loading
// the plugin. The user's real config is never opened or modified.
//
// Run with: ./run.sh test_trusted.ts
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { PLUGIN_DIST, SANDBOX, HOME_DIR, BUILTIN_RAW, TRUSTED_DIR } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

// Separate config for this suite, independent of the one created by run.sh.
const OWN_CONFIG = `${SANDBOX}/config/trusted-case.json`
const PREVIOUS_CONFIG = process.env.ANON_CONFIG
process.env.ANON_CONFIG = OWN_CONFIG // Set before fresh(); see the header.

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 30 23125 0."
// This untrusted path contains no entity, so its name stays literal. The test
// checks that content is filtered when the path is not trusted.
const OTHER = `${SANDBOX}/anderswo/etwas.txt`

function restoreEnv(): void {
  if (PREVIOUS_CONFIG === undefined) delete process.env.ANON_CONFIG
  else process.env.ANON_CONFIG = PREVIOUS_CONFIG
}
function cleanup(): void {
  restoreEnv()
  if (existsSync(OWN_CONFIG)) rmSync(OWN_CONFIG, { force: true })
}
process.on("exit", cleanup)
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanup()
    process.exit(130)
  })
}

let failures = 0
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}
const raw = (s: string) => s === PII
const isAnon = (s: string) =>
  !s.includes("peter.parker@example.com") && s.includes("[") && !s.includes("[ANON_ERROR]")

let seq = 0
async function fresh() {
  const mod: any = await import(`${PLUGIN_DIST}?case=` + ++seq)
  const d: any = (mod as any)?.default ?? mod
  const H: Record<string, (e: any) => Promise<void> | void> = {}
  const ctx: any = {
    client: { tui: { showToast: () => Promise.resolve(true) } },
    session: { hook: async (n: string, f: any) => { H[n] = f } },
    tool: { hook: async (n: string, f: any) => { H[n] = f } },
  }
  await (d.setup ?? d.default.setup)(ctx)
  return async (input: unknown, tool = "read") => {
    const ev: any = { tool, input, status: "completed", result: { content: PII } }
    await H["execute.after"](ev)
    return ev.result.content as string
  }
}

// Write only to this suite's own config file.
function setConfig(json: string): void {
  mkdirSync(dirname(OWN_CONFIG), { recursive: true })
  writeFileSync(OWN_CONFIG, json)
}

try {
  // 1) Config with one project directory.
  setConfig(JSON.stringify({ trustedPaths: [`${SANDBOX}/my-project`] }))
  {
    const after = await fresh()
    const p = `${SANDBOX}/my-project/note.txt`
    check("Config path is free (read)", raw(await after({ file_path: p })),
      (await after({ file_path: p })).slice(0, 40))
    check("other path stays filtered", isAnon(await after({ file_path: OTHER })))
    check("Shell always filtered",
      isAnon(await after({ command: `cat ${SANDBOX}/my-project/note.txt` }, "shell")))
  }

  // 2) Removing a path filters it again without a restart.
  setConfig(JSON.stringify({ trustedPaths: [] }))
  {
    const after = await fresh()
    check("removed path filtered again",
      isAnon(await after({ file_path: `${SANDBOX}/my-project/note.txt` })))
  }

  // 3) A broken config does not crash or disable built-in trusted paths.
  setConfig("{ kaputt: ")
  {
    const after = await fresh()
    check("broken config -> internal paths still free", raw(await after({ file_path: BUILTIN_RAW })))
    check("broken config -> external paths filtered", isAnon(await after({ file_path: OTHER })))
  }

  // 4) Expand `~` to this runtime's home directory and handle slash variants.
  setConfig(JSON.stringify({
    trustedPaths: ["~/.claude-trust-dir/", `${SANDBOX}/anders`, `${HOME_DIR}/Notes/privat`],
  }))
  {
    const after = await fresh()
    check("~ expanded",
      raw(await after({ file_path: `${HOME_DIR}/.claude-trust-dir/a.md` })))
    check("trailing slash form works",
      raw(await after({ file_path: `${SANDBOX}/anders/a.md` })))
    check("second path without slash too",
      raw(await after({ file_path: `${HOME_DIR}/Notes/privat/x.md` })))
    check("prefix collision not bypassed",
      isAnon(await after({ file_path: `${SANDBOX}/andersgelogen/x.md` })))
  }

  // 5) Denylist entries override the allowlist: state.json is only raw with
  //    [ANON:RAW], even when it is inside a trusted folder.
  setConfig(JSON.stringify({ trustedPaths: [TRUSTED_DIR] }))
  {
    const after = await fresh()
    const denied = `${TRUSTED_DIR}/.local/share/anonymizer/state.json`
    check("denylist beats allowlist (filtered)", isAnon(await after({ file_path: denied })))
  }
} finally {
  cleanup()
}

console.log(failures === 0 ? "\n== TRUSTED CONFIG CONFIRMED ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)
