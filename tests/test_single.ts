// Einmal-Marker: [ANON:S-OFF] / [ANON:S-FORCE] und einfache Klammern.
// Aufruf: bun test_single.ts
import { PLUGIN_DIST, HOME_DIR } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567."
const TRUSTED = { file_path: "${HOME_DIR}/.local/share/anonymizer/x.txt" }
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
  const t = await p.prompt("[[ANON:S-OFF]] lies die File")
  check("S-OFF: double bracket is literal", isAnon(await p.after(PII)))
  check("S-OFF: double brackets collapse", t === "[ANON:S-OFF] lies die File", JSON.stringify(t))
}

// 2) S-FORCE: genau EIN Tool-Ergebnis filtern, auch auf internem Pfad
{
  const p = await fresh()
  const t = await p.prompt("[ANON:S-FORCE] lies das Skript")
  check("S-FORCE: internal result filtered", isAnon(await p.after(PII, TRUSTED)))
  check("S-FORCE: internal free after", raw(await p.after(PII, TRUSTED)))
  check("S-FORCE: stays visible", t.includes("ANON:S-FORCE"), JSON.stringify(t))
}

// 3) Reihenfolge: S-OFF vor FORCED, global OFF gewinnt alles
{
  const p = await fresh()
  await p.prompt("[ANON:S-OFF] und [ANON:FORCED] beides")
  check("S-OFF wins over FORCED", raw(await p.after(PII, TRUSTED)))
  // FORCED hatte noch Budget: es deckte die naechste Ausgabe ab, die S-OFF
  // verbraucht hat. Danach ist wieder Default.
  check("FORCED budget covered follow-up", isAnon(await p.after(PII, TRUSTED)))
  check("then default again (internal free)", raw(await p.after(PII, TRUSTED)))
}
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] und [[ANON:S-FORCE]] beides")
  check("OFF wins over S-FORCE same message", raw(await p.after(PII, TRUSTED)))
}
{
  // OFF bleibt nur erhalten, wenn die naechste Nachricht wieder OFF traegt.
  const p = await fresh()
  await p.prompt("[ANON:OFF] global aus")
  await p.prompt("[ANON:S-FORCE] nur einmal filtern")
  check("OFF ends when next message has a DIFFERENT marker",
    isAnon(await p.after(PII, TRUSTED)), "S-FORCE gilt, OFF ist zurueckgesetzt")
}

// 4) Verbraucht sich ungenutzt beim naechsten Nachricht (fail-safe)
{
  const p = await fresh()
  await p.prompt("[ANON:S-OFF] kein Tool benutzt")
  await p.prompt("naechste Anfrage")
  check("unused S-OFF expires", isAnon(await p.after(PII)))
}

// 5) Einfache Klammern fuer die uebrigen Marker, werden entfernt
{
  const p = await fresh()
  const t = await p.prompt("[ANON:OFF] schau mal")
  check("simple OFF works", raw(await p.after(PII)))
  check("simple OFF removed from message", !t.includes("ANON"), JSON.stringify(t))
}
{
  const p = await fresh()
  const t = await p.prompt("[ANON:FORCE] intern filtern")
  check("simple FORCE works", isAnon(await p.after(PII, TRUSTED)))
  check("simple FORCE removed", !t.includes("ANON"), JSON.stringify(t))
}
{
  const p = await fresh()
  const t = await p.prompt("[ANON:ON] wieder an")
  check("simple ON removed", !t.includes("ANON"), JSON.stringify(t))
  check("nothing catches normal ON", isAnon(await p.after(PII)))
}

// 6) Doppelte Klammern kollabieren. Erwartungswert wird aus chr(91) gebaut:
//    ein literales [PERSON_1] in dieser File waere beim Schreiben selbst
//    kollabiert worden.
{
  const p = await fresh()
  const S = String.fromCharCode(91)
  const C = String.fromCharCode(93)
  const input = `vergleiche ${S}${S}PERSON_1${C}${C} und ${S}${S}EMAIL_2${C}${C} bitte`
  const want = `vergleiche ${S}PERSON_1${C} und ${S}EMAIL_2${C} bitte`
  const t = await p.prompt(input)
  check("double brackets collapse", t === want, `IN=${JSON.stringify(input)} OUT=${JSON.stringify(t)}`)
  // fuer einen literalen Text auf der Platte braucht es dreifache Klammern
  const t3 = await p.prompt(`literal ${S}${S}${S}PERSON_1${C}${C}${C} bitte`)
  check("triple brackets stay", t3 === `literal ${S}${S}PERSON_1${C}${C} bitte`, JSON.stringify(t3))
}

// 7) Unbekannter Marker: bleibt stehen + Warnung
{
  const p = await fresh()
  const t = await p.prompt("[ANON:FOO] was ist das")
  check("unknown marker stays in text", t.includes("ANON:FOO"), JSON.stringify(t))
  check("unknown marker produces warning", p.toasts.some((x) => /Unknown marker/.test(x)), p.toasts[0] ?? "-")
}

console.log(failures === 0 ? "\n== ONE-SHOT MARKERS CONFIRMED ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)