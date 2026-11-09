// Die Sperrliste schlaegt jede Allowlist: state.json (vollstaendige
// Placeholder->Original-Tabelle), Logs, Sessions, Credentials.
// Aufruf: bun test_denylist.ts
import { PLUGIN_DIST, HOME_DIR, SANDBOX } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567."

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

// 1) Gesperrte Fileen: immer gefiltert, auch in trusted Pfaden
const blocked = [
  `${HOME_DIR}/.local/share/anonymizer/state.json`,
  `${HOME_DIR}/.local/share/opencode/opencode.db`,
  `${HOME_DIR}/.local/share/opencode/opencode.db-wal`,
  `${HOME_DIR}/.local/share/opencode/log/opencode.log`,
  `${HOME_DIR}/.local/share/opencode/storage/auth.json`,
  `${HOME_DIR}/.local/share/opencode/session/abc.json`,
  `${HOME_DIR}/.config/opencode/service.json`,
  `${HOME_DIR}/.config/opencode/service-t.json`,
  `${HOME_DIR}/.config/opencode/cli.json`,
]
for (const f of blocked) {
  check(`blocked: ${f.split("/").slice(-2).join("/")}`, isAnon(await after(f)))
}

// 2) Nicht gesperrte Fileen in denselben trusted Ordnern bleiben roh
const allowed = [
  `${HOME_DIR}/.local/share/anonymizer/anonymizer/engine.py`,
  `${HOME_DIR}/.local/share/anonymizer/test_hooks.ts`,
  `${SANDBOX}/trusted/roh-via-config.md`,   // nur ueber Sandbox-Config vertraut
  `${HOME_DIR}/.config/opencode/skills/anonymizer/SKILL.md`,
  `${SANDBOX}/roh/etwas.sh`,                 // nur ueber Sandbox-Config vertraut
]
for (const f of allowed) {
  check(`allowed (raw): ${f.split("/").slice(-2).join("/")}`, raw(await after(f)))
}

console.log(failures === 0 ? "\n== DENYLIST WORKS ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)