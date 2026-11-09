// The denylist overrides every allowlist, protecting state, logs, sessions,
// and credentials.
// Run with: bun test_denylist.ts
import { PLUGIN_DIST, SANDBOX } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 30 23125 0."
const TEST_HOME = "/home/example-user"

let seq = 0
async function fresh() {
  const mod: any = await import(
    `${PLUGIN_DIST}?case=` + ++seq
  )
  const d: any = (mod as any)?.default ?? mod
  const H: Record<string, (e: any) => Promise<void> | void> = {}
  const ctx: any = {
    client: { tui: { showToast: () => Promise.resolve(true) } },
    session: { hook: async (n: string, f: any) => { H[n] = f } },
    tool: { hook: async (n: string, f: any) => { H[n] = f } },
  }
  await (d.setup ?? d.default.setup)(ctx)
  return async (filePath: string) => {
    const ev: any = {
      tool: "read",
      input: { file_path: filePath },
      status: "completed",
      result: { content: PII },
    }
    await H["execute.after"](ev)
    return ev.result.content as string
  }
}

let failures = 0
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}
const raw = (s: string) => s === PII
const isAnon = (s: string) => !s.includes("peter.parker@example.com") && s.includes("[")

const after = await fresh()

// 1) Denied files are always filtered, even under trusted paths.
const blocked = [
  `${TEST_HOME}/.local/share/anonymizer/state.json`,
  `${TEST_HOME}/.local/share/opencode/opencode.db`,
  `${TEST_HOME}/.local/share/opencode/opencode.db-wal`,
  `${TEST_HOME}/.local/share/opencode/log/opencode.log`,
  `${TEST_HOME}/.local/share/opencode/storage/auth.json`,
  `${TEST_HOME}/.local/share/opencode/session/abc.json`,
  `${TEST_HOME}/.config/opencode/service.json`,
  `${TEST_HOME}/.config/opencode/service-t.json`,
  `${TEST_HOME}/.config/opencode/cli.json`,
]
for (const f of blocked) {
  check(`blocked: ${f.split("/").slice(-2).join("/")}`, isAnon(await after(f)))
}

// 2) Non-denied files in the same trusted folders remain raw.
const allowed = [
  `${TEST_HOME}/.local/share/anonymizer/anonymizer/engine.py`,
  `${TEST_HOME}/.local/share/anonymizer/test_hooks.ts`,
  `${SANDBOX}/trusted/raw-via-config.md`,
  `${TEST_HOME}/.config/opencode/skills/anonymizer/SKILL.md`,
  `${SANDBOX}/roh/example.sh`,
]
for (const f of allowed) {
  check(`allowed (raw): ${f.split("/").slice(-2).join("/")}`, raw(await after(f)))
}

console.log(failures === 0 ? "\n== DENYLIST WORKS ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)
