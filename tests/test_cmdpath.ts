// Kommando-Pfad: [TAG] wird aufgeloest, [[TAG]] bleibt literal.
// Deckt auch den Toolnamen-Unterschied ab ("shell" vs "bash" vs sonstige).
// Aufruf: bun test_cmdpath.ts
import { PLUGIN_DIST, HOME_DIR } from "./helpers"
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
  return {
    after: async (content: string) => {
      const ev: any = { tool: "read", input: { file_path: "/tmp/x" }, status: "completed", result: { content } }
      await H["execute.after"](ev)
      return ev.result.content as string
    },
    before: async (tool: string, input: any) => {
      const ev: any = { tool, input }
      await H["execute.before"](ev)
      return ev.input
    },
  }
}

let failures = 0
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}
const S = String.fromCharCode(91)
const C = String.fromCharCode(93)
// ACHTUNG: tag enthaelt bereits Klammern. Fuer doppelte Klammern den NACKTEN
// Namen nehmen, sonst entstehen dreifache und man testet den Escape gar nicht.
const bare = (t: string) => t.slice(1, -1)
const dbl = (t: string) => S + S + bare(t) + C + C // [[TAG]]

// Tag aus einer echten Anonymisierung holen
const p = await fresh()
const anon = await p.after(PII)
const tag = anon.match(/\[PERSON_\d+\]/)?.[0] ?? ""
const emailTag = anon.match(/\[EMAIL_\d+\]/)?.[0] ?? ""
check("Tag erzeugt", !!tag, `${tag} / ${emailTag}`)

// 1) Aufloesen: [TAG] -> Original
for (const tool of ["shell", "bash", "run_command"]) {
  const inp = await p.before(tool, { command: `grep "${tag}" /tmp/pii.txt` })
  check(`[TAG] aufgeloest (${tool})`, inp.command.includes("Peter Parker"), inp.command)
}

// 2) Literal: [[TAG]] -> [TAG], nie aufgeloest
for (const tool of ["shell", "bash"]) {
  const inp = await p.before(tool, { command: `grep "${dbl(tag)}" /tmp/pii.txt` })
  check(`[[TAG]] bleibt literal (${tool})`, inp.command.includes(tag) && !inp.command.includes("Peter Parker"), inp.command)
}

// 3) Mehrere Tags in einem Kommando, gemischt mit normalem Text
{
  const inp = await p.before("shell", {
    command: `grep -c "${tag}" file.txt && grep -o "${emailTag}" file.txt`,
  })
  check(
    "zwei Tags im selben Kommando",
    inp.command.includes("Peter Parker") && inp.command.includes("peter.parker@example.com"),
    inp.command,
  )
}

// 4) Literal und aufgeloest im selben Kommando
{
  const inp = await p.before("shell", {
    command: `echo "${tag}" "${dbl(tag)}"`,
  })
  check("gemischt: einmal aufgeloest, einmal literal", inp.command === `echo "Peter Parker" "${tag}"`, "")
}

// 5) Pfad-Argument bleibt aufloesbar, Command mit Platzhalter im Dateinamen
{
  const inp = await p.before("shell", { command: `cat "/tmp/${dbl(tag)}.txt"` })
  const inp2 = await p.before("read", { filePath: `/tmp/${tag}.txt` })
  check("Dateiname aus [[TAG]] bleibt literal", inp.command === `cat "/tmp/${tag}.txt"`, "")
  check("Pfad-Argument mit [TAG] aufgeloest", inp2.filePath === "/tmp/Peter Parker.txt", "")
}

// 6) Ein Befehl ganz ohne Tag bleibt unangetastet
{
  const inp = await p.before("shell", { command: "ls -la /tmp | head -20" })
  check("Kommando ohne Tag unveraendert", inp.command === "ls -la /tmp | head -20", inp.command)
}

console.log(failures === 0 ? "\n== KOMMANDO-PFAD BESTAETIGT ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)