// Invariant: [TAG] is always resolved, regardless of marker state.
// [[TAG]] always stays literal. Reverse mapping applies to tool input, not
// output, so it is independent of whether filtering is enabled.
// Run with: bun test_reverse_always.ts
import { PLUGIN_DIST } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 30 23125 0."

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

// Create a tag in the default state.
const p = await fresh()
const anon = await p.after(PII)
const tag = anon.match(/\[PERSON_\d+\]/)?.[0] ?? ""
const real = bare(tag) === "PERSON_1" ? "Peter Parker" : bare(tag)
check("Tag + original determined", !!tag, `${tag} -> ${real}`)

// Check all marker states.
const states: Array<[string, string]> = [
  ["without marker", "a plain message"],
  ["[ANON:OFF]", "[ANON:OFF] work with raw data"],
  ["[ANON:S-OFF]", "[ANON:S-OFF] one raw result"],
  ["[ANON:FORCED]", "[ANON:FORCED] force filtering"],
  ["[ANON:S-FORCE]", "[ANON:S-FORCE] filter one result"],
]

for (const [name, msg] of states) {
  await p.prompt(msg)

  // 1) Command: [TAG] resolves to its original.
  const cmd = await p.before("shell", { command: `grep "${tag}" f.txt` })
  check(`${name}: command resolves [TAG]`, cmd.command.includes(real), "")

  // 2) Command: [[TAG]] stays literal.
  const esc = await p.before("shell", { command: `grep "${dbl(tag)}" f.txt` })
  check(`${name}: command keeps [[TAG]] literal`, esc.command.includes(tag) && !esc.command.includes(real), "")

  // 3) Schreib-Inhalt: [TAG] resolved
  const w = await p.before("write", { filePath: "/tmp/o.txt", content: `${tag} Notiz` })
  check(`${name}: write resolves [TAG]`, w.content.includes(real), "")

  // 4) Schreib-Inhalt: [[TAG]] literal
  const w2 = await p.before("write", { filePath: "/tmp/o.txt", content: `${dbl(tag)} Beispiel` })
  check(`${name}: write keeps [[TAG]] literal`, w2.content.includes(tag) && !w2.content.includes(real), "")

  // 5) Path argument: [TAG] resolves.
  const r = await p.before("read", { filePath: `/tmp/${tag}.txt` })
  check(`${name}: path argument resolves [TAG]`, r.filePath.includes(real), "")
}

console.log(failures === 0 ? "\n== REVERSE ALWAYS ACTIVE ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)
