// Die Sperrliste schlaegt jede Allowlist: state.json (vollstaendige
// Placeholder->Original-Tabelle), Logs, Sessions, Credentials.
// Aufruf: bun test_denylist.ts
import def0 from "/Users/example-user/.config/opencode/plugins/anonymizer/dist/index.js"

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567."

let seq = 0
async function fresh() {
  const mod: any = await import(
    "/Users/example-user/.config/opencode/plugins/anonymizer/dist/index.js?case=" + ++seq
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

// 1) Gesperrte Dateien: immer gefiltert, auch in trusted Pfaden
const blocked = [
  "/Users/example-user/.local/share/anonymizer/state.json",
  "/Users/example-user/.local/share/opencode/opencode.db",
  "/Users/example-user/.local/share/opencode/opencode.db-wal",
  "/Users/example-user/.local/share/opencode/log/opencode.log",
  "/Users/example-user/.local/share/opencode/storage/auth.json",
  "/Users/example-user/.local/share/opencode/session/abc.json",
  "/Users/example-user/.config/opencode/service.json",
  "/Users/example-user/.config/opencode/service-t.json",
  "/Users/example-user/.config/opencode/cli.json",
]
for (const f of blocked) {
  check(`gesperrt: ${f.split("/").slice(-2).join("/")}`, isAnon(await after(f)))
}

// 2) Nicht gesperrte Dateien in denselben trusted Ordnern bleiben roh
const allowed = [
  "/Users/example-user/.local/share/anonymizer/anonymizer/engine.py",
  "/Users/example-user/.local/share/anonymizer/test_hooks.ts",
  "/Users/example-user/.config/opencode/opencode.jsonc",
  "/Users/example-user/.config/opencode/skills/anonymizer/SKILL.md",
  "/Users/example-user/Projects/Scripts/etwas.sh",
]
for (const f of allowed) {
  check(`erlaubt (roh): ${f.split("/").slice(-2).join("/")}`, raw(await after(f)))
}

console.log(failures === 0 ? "\n== SPERRLISTE WIRKT ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)