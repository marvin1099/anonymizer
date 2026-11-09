// Invariante: [TAG] wird IMMER aufgeloest, unabhaengig von jedem Marker-
// zustand. [[TAG]] bleibt immer literal. Das Reverse darf nie davon
// abhaengen, ob die Filterung an oder aus ist -- es laeuft ja in der anderen
// Richtung (Tool-Eingabe), nicht bei der Ausgabe.
// Aufruf: bun test_reverse_always.ts
import { PLUGIN_DIST } from "./helpers"
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
    prompt: async (text: string) => {
      const ev: any = { prompt: { text } }
      await H["prompt"](ev)
      return ev.prompt.text as string
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
const bare = (t: string) => t.slice(1, -1)
const dbl = (t: string) => S + S + bare(t) + C + C

// Tag einmalig erzeugen (im Default-Zustand)
const p = await fresh()
const anon = await p.after(PII)
const tag = anon.match(/\[PERSON_\d+\]/)?.[0] ?? ""
const real = bare(tag) === "PERSON_1" ? "Peter Parker" : bare(tag)
check("Tag + Original ermittelt", !!tag, `${tag} -> ${real}`)

// Alle Markerzustaende durchprobieren
const states: Array<[string, string]> = [
  ["ohne Marker", "ganz normale Nachricht"],
  ["[ANON:OFF]", "[ANON:OFF] arbeite mit Rohdaten"],
  ["[ANON:S-OFF]", "[ANON:S-OFF] einmal roh"],
  ["[ANON:FORCED]", "[ANON:FORCED] filter streng"],
  ["[ANON:S-FORCE]", "[ANON:S-FORCE] einmal filtern"],
]

for (const [name, msg] of states) {
  await p.prompt(msg)

  // 1) Kommando: [TAG] aufgeloest
  const cmd = await p.before("shell", { command: `grep "${tag}" f.txt` })
  check(`${name}: Kommando loest [TAG] auf`, cmd.command.includes(real), "")

  // 2) Kommando: [[TAG]] literal
  const esc = await p.before("shell", { command: `grep "${dbl(tag)}" f.txt` })
  check(`${name}: Kommando laesst [[TAG]] literal`, esc.command.includes(tag) && !esc.command.includes(real), "")

  // 3) Schreib-Inhalt: [TAG] aufgeloest
  const w = await p.before("write", { filePath: "/tmp/o.txt", content: `${tag} Notiz` })
  check(`${name}: write loest [TAG] auf`, w.content.includes(real), "")

  // 4) Schreib-Inhalt: [[TAG]] literal
  const w2 = await p.before("write", { filePath: "/tmp/o.txt", content: `${dbl(tag)} Beispiel` })
  check(`${name}: write laesst [[TAG]] literal`, w2.content.includes(tag) && !w2.content.includes(real), "")

  // 5) Pfad-Argument: [TAG] aufgeloest
  const r = await p.before("read", { filePath: `/tmp/${tag}.txt` })
  check(`${name}: Pfad-Argument loest auf`, r.filePath.includes(real), "")
}

console.log(failures === 0 ? "\n== REVERSE IMMER AKTIV ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)