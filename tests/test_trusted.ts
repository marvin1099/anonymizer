// Trusted-Pfade aus ~/.config/opencode/anonymizer.json (hot reload, kein Restart).
// Aufruf: bun test_trusted.ts
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import def0 from "/Users/example-user/.config/opencode/plugins/anonymizer/dist/index.js"

const CONFIG = "/Users/example-user/.config/opencode/anonymizer.json"
const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567."
const HOME_PROJ = "/Users/example-user/Projects/mein-projekt"
const OTHER = "/Users/example-user/Downloads/etwas.txt"

// WICHTIG: Diese Datei wird waehrend des Tests ueberschrieben. Deshalb den
// Originalinhalt vorher sichern und im finally-Block (und zusaetzlich bei
// Abbruch) byteweise zurueckschreiben. Vorher stand hier ein
// `writeFileSync(CONFIG, '{"trustedPaths":[]}')`, das die echten Pfade des
// Nutzers zerstoert hat.
const BACKUP = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : null
function restore(): void {
  if (BACKUP === null) rmSync(CONFIG, { force: true })
  else writeFileSync(CONFIG, BACKUP)
}
process.on("exit", restore)
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    restore()
    process.exit(130)
  })
}

let failures = 0
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}

const hadConfig = existsSync(CONFIG)
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
  return async (input: unknown, tool = "read") => {
    const ev: any = { tool, input, status: "completed", result: { content: PII } }
    await H["execute.after"](ev)
    return ev.result.content as string
  }
}
const raw = (s: string) => s === PII
const isAnon = (s: string) => !s.includes("peter.parker@example.com") && s.includes("[")

try {
  // 1) Config mit einem Projektordner
  writeFileSync(CONFIG, JSON.stringify({ trustedPaths: ["~/Projects/mein-projekt"] }))
  {
    const after = await fresh()
    check("Config-Pfad ist frei (read)", raw(await after({ file_path: `${HOME_PROJ}/notiz.txt` })),
      (await after({ file_path: `${HOME_PROJ}/notiz.txt` })).slice(0, 40))
    check("anderer Pfad bleibt gefiltert", isAnon(await after({ file_path: OTHER })))
    check("Shell bleibt immer gefiltert", isAnon(await after({ command: `cat ${HOME_PROJ}/notiz.txt` }, "shell")))
  }

  // 2) Hot-Reload: Pfad wird entfernt -> wieder filtern, ohne Neustart
  writeFileSync(CONFIG, JSON.stringify({ trustedPaths: [] }))
  {
    const after = await fresh()
    check("entfernter Pfad wird wieder gefiltert", isAnon(await after({ file_path: `${HOME_PROJ}/notiz.txt` })))
  }

  // 3) Kaputte Config -> eingebaute Pfade gelten weiter, kein Absturz
  writeFileSync(CONFIG, "{ kaputt: ")
  {
    const after = await fresh()
    check("kaputte Config -> interne Pfade weiter frei",
      raw(await after({ file_path: "/Users/example-user/.config/opencode/plugins/x/y.ts" })))
    check("kaputte Config -> externe Pfade gefiltert", isAnon(await after({ file_path: OTHER })))
  }

  // 4) ~/Praefix und Slash-Formen
  writeFileSync(CONFIG, JSON.stringify({ trustedPaths: ["~/Projects/anders/", "~/Notes/privat"] }))
  {
    const after = await fresh()
    check("Slash-Form am Ende funktioniert", raw(await after({ file_path: "/Users/example-user/Projects/anders/a.md" })))
    check("zweiter Pfad ohne Slash auch", raw(await after({ file_path: "/Users/example-user/Notes/privat/x.md" })))
    check("Prefix-Kollision faellt nicht durch",
      isAnon(await after({ file_path: "/Users/example-user/Projects/andersgelogen/x.md" })))
  }
} finally {
  restore()
}

console.log(failures === 0 ? "\n== TRUSTED-CONFIG BESTAETIGT ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)