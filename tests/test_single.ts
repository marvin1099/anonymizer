// Einmal-Marker: [ANON:S-OFF] / [ANON:S-FORCE] und einfache Klammern.
// Aufruf: bun test_single.ts
import { PLUGIN_DIST } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 30 23125 0."
const TRUSTED = { file_path: "/home/example-user/.local/share/anonymizer/x.txt" }
const EXT = { file_path: "/tmp/x.txt" }

let seq = 0
async function fresh() {
  const mod: any = await import(
    `${PLUGIN_DIST}?case=` + ++seq
  )
  const d: any = (mod as any)?.default ?? mod
  const H: Record<string, (e: any) => Promise<void> | void> = {}
  const toasts: string[] = []
  const ctx: any = {
    client: { tui: { showToast: (o: any) => { toasts.push(o?.body?.message ?? ""); return Promise.resolve(true) } } },
    session: { hook: async (n: string, f: any) => { H[n] = f } },
    tool: { hook: async (n: string, f: any) => { H[n] = f } },
  }
  await (d.setup ?? d.default.setup)(ctx)
  return {
    toasts,
    after: async (content: string, input: unknown = EXT) => {
      const ev: any = { tool: "read", input, status: "completed", result: { content } }
      await H["execute.after"](ev)
      return ev.result.content as string
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
const raw = (s: string) => s === PII
const isAnon = (s: string) => !s.includes("peter.parker@example.com") && s.includes("[")

// 1) S-OFF: genau EIN Tool-Ergebnis roh, Marker bleibt im Text sichtbar
{
  const p = await fresh()
  const t = await p.prompt("[ANON:S-OFF] lies die File")
  check("S-OFF: simple bracket detected (1. Ergebnis roh)", raw(await p.after(PII)))
  check("S-OFF: 2nd result filtered again", isAnon(await p.after(PII)))
  check("S-OFF: stays visible in message", t.includes("ANON:S-OFF"), JSON.stringify(t))
}
{
  const p = await fresh()
  const t = await p.prompt("[[ANON:S-OFF]] read the file")
  check("S-OFF: double bracket is literal", isAnon(await p.after(PII)))
  check("S-OFF: double brackets collapse", t === "[ANON:S-OFF] read the file", JSON.stringify(t))
}

// 2) S-FORCE filters exactly one tool result, even on a trusted path.
{
  const p = await fresh()
  const t = await p.prompt("[ANON:S-FORCE] read the script")
  check("S-FORCE: internal result filtered", isAnon(await p.after(PII, TRUSTED)))
  check("S-FORCE: internal free after", raw(await p.after(PII, TRUSTED)))
  check("S-FORCE: stays visible", t.includes("ANON:S-FORCE"), JSON.stringify(t))
}

// 3) S-OFF precedes FORCED; global OFF takes precedence over both.
{
  const p = await fresh()
  await p.prompt("[ANON:S-OFF] and [ANON:FORCED] together")
  check("S-OFF wins over FORCED", raw(await p.after(PII, TRUSTED)))
  // FORCED still applies to the next result, after S-OFF consumes the first.
  // The default state resumes afterward.
  check("FORCED budget covered follow-up", isAnon(await p.after(PII, TRUSTED)))
  check("then default again (internal free)", raw(await p.after(PII, TRUSTED)))
}
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] and [[ANON:S-FORCE]] together")
  check("OFF wins over S-FORCE same message", raw(await p.after(PII, TRUSTED)))
}
{
  // OFF remains active only if the next message repeats the OFF marker.
  const p = await fresh()
  await p.prompt("[ANON:OFF] global off")
  await p.prompt("[ANON:S-FORCE] filter only once")
  check("OFF ends when next message has a DIFFERENT marker",
    isAnon(await p.after(PII, TRUSTED)), "S-FORCE applies; OFF is reset")
}

// 4) An unused one-shot marker expires on the next message (fail-safe).
{
  const p = await fresh()
  await p.prompt("[ANON:S-OFF] no tool used")
  await p.prompt("next request")
  check("unused S-OFF expires", isAnon(await p.after(PII)))
}

// 5) Single-bracket marker forms are removed from the message.
{
  const p = await fresh()
  const t = await p.prompt("[ANON:OFF] take a look")
  check("simple OFF works", raw(await p.after(PII)))
  check("simple OFF removed from message", !t.includes("ANON"), JSON.stringify(t))
}
{
  const p = await fresh()
  const t = await p.prompt("[ANON:FORCE] filter the trusted path")
  check("simple FORCE works", isAnon(await p.after(PII, TRUSTED)))
  check("simple FORCE removed", !t.includes("ANON"), JSON.stringify(t))
}
{
  const p = await fresh()
  const t = await p.prompt("[ANON:ON] turn it on again")
  check("simple ON removed", !t.includes("ANON"), JSON.stringify(t))
  check("nothing catches normal ON", isAnon(await p.after(PII)))
}

// 6) Double brackets collapse. Build the expected value from character codes
//    so a literal [PERSON_1] in this source file cannot be rewritten.
{
  const p = await fresh()
  const S = String.fromCharCode(91)
  const C = String.fromCharCode(93)
  const input = `compare ${S}${S}PERSON_1${C}${C} and ${S}${S}EMAIL_2${C}${C} please`
  const want = `compare ${S}PERSON_1${C} and ${S}EMAIL_2${C} please`
  const t = await p.prompt(input)
  check("double brackets collapse", t === want, `IN=${JSON.stringify(input)} OUT=${JSON.stringify(t)}`)
  // Triple brackets are needed to write a double-bracket literal to disk.
  const t3 = await p.prompt(`literal ${S}${S}${S}PERSON_1${C}${C}${C} please`)
  check("triple brackets stay", t3 === `literal ${S}${S}PERSON_1${C}${C} please`, JSON.stringify(t3))
}

// 7) Unknown markers remain in the text and produce a warning.
{
  const p = await fresh()
  const t = await p.prompt("[ANON:FOO] what is this")
  check("unknown marker stays in text", t.includes("ANON:FOO"), JSON.stringify(t))
  check("unknown marker produces warning", p.toasts.some((x) => /Unknown marker/.test(x)), p.toasts[0] ?? "-")
}

console.log(failures === 0 ? "\n== ONE-SHOT MARKERS CONFIRMED ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)
