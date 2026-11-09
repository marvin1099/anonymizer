// Marker-Semantik (Stand: OFF ist sticky, FORCED ist anfragegebunden).
//  1) doppelte Klammern ja, einfache nein
//  2) Position egal
//  3) OFF bleibt ueber Folgeanfragen AN, bis [[ANON:ON]]
//  4) FORCED gilt nur fuer die eine Anfrage
// Aufruf: bun test_offscope.ts
import { PLUGIN_DIST, HOME_DIR } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567."
const TRUSTED_PATH = "${HOME_DIR}/.local/share/anonymizer/x.txt"

let seq = 0
async function fresh() {
  const mod: any = await import(
    `${PLUGIN_DIST}?case=` + ++seq
  )
  const d: any = (mod as any)?.default ?? mod
  const H: Record<string, (e: any) => Promise<void> | void> = {}
  const toasts: string[] = []
  const ctx: any = {
    client: {
      tui: { showToast: (o: any) => { toasts.push(o?.body?.message ?? ""); return Promise.resolve(true) } },
    },
    session: { hook: async (n: string, f: any) => { H[n] = f } },
    tool: { hook: async (n: string, f: any) => { H[n] = f } },
  }
  await (d.setup ?? d.default.setup)(ctx)
  return {
    toasts,
    after: async (content: string, input: unknown = { file_path: "/tmp/x" }) => {
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

// 1) Syntax: einfache UND doppelte Klammern wirken
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] schau mal")
  check("single bracket works too", raw(await p.after(PII)))
}
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] schau mal")
  check("double bracket works", raw(await p.after(PII)))
}
{
  const p = await fresh()
  const t = await p.prompt("kannst du bitte [ANON:OFF] die File lesen?")
  check("position irrelevant (mid-text)", !t.includes("ANON:OFF") && raw(await p.after(PII)))
}

// 2) OFF endet bei der naechsten Nachricht OHNE Marker (kein [[ANON:ON]] noetig)
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] erste Anfrage")
  await p.after(PII)                                        // 1. Anfrage: roh
  await p.prompt("zweite Anfrage, kein Marker")
  const second = await p.after(PII)
  check("marker-less message re-arms", isAnon(second), second.slice(0, 40))
  await p.prompt("dritte Anfrage, kein Marker")
  check("stays filtered in third", isAnon(await p.after(PII)))
  check("hint toast on re-arm", p.toasts.some((t) => /re-enabled/.test(t)), p.toasts[0] ?? "-")
}

// 2b) OFF ueberlebt Folgeanfragen nur MIT erneutem Marker
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] erste Anfrage")
  await p.prompt("[ANON:OFF] zweite Anfrage, Marker erneut")
  check("OFF with repeated marker", raw(await p.after(PII)), raw(await p.after(PII)) ? "roh" : "gefiltert")
  await p.prompt("dritte Anfrage without marker")
  check("filtered again after", isAnon(await p.after(PII)))
}

// 2c) Warn-Toast solange OFF laeuft
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] Anfrage")
  check("warning toast when OFF active", p.toasts.some((t) => /Anonymization is OFF/.test(t)), p.toasts[0] ?? "-")
  check("OFF text mentions end", p.toasts.some((t) => /marker-less message/.test(t)))
}

// 2d) [[ANON:ON]] schaltet auch sofort zurueck
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] mach was")
  const t = await p.prompt("[ANON:ON] stopp, wieder filtern")
  check("ON marker removed", !t.includes("ANON"), JSON.stringify(t))
  check("ON switches in same session", isAnon(await p.after(PII)))
}

// 3) Sticky ueberlebt viele Tool-Aufrufe (kein Token-Budget mehr)
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] lange Anfrage")
  let stillRaw = true
  for (let i = 0; i < 30; i++) if (!raw(await p.after(PII))) stillRaw = false
  check("OFF lasts 30 tool calls", stillRaw, "no expiry after 20")
}

// 4) FORCED bleibt anfragegebunden
{
  const p = await fresh()
  await p.prompt("[ANON:FORCED] force-Anfrage")
  check("FORCED filters internal path", isAnon(await p.after(PII, { file_path: TRUSTED_PATH })))
  await p.prompt("naechste Anfrage without marker")
  const t2 = await p.after(PII, { file_path: TRUSTED_PATH })
  check("FORCED ends with request", raw(t2), raw(t2) ? "intern wieder frei" : "bleibt gefiltert -> Ueberlauf")
}
{
  const p = await fresh()
  await p.prompt("[ANON:FORCE] ohne D")
  check("FORCE without D works", isAnon(await p.after(PII, { file_path: TRUSTED_PATH })))
}

// 5) OFF schlaegt FORCED und umgekehrt nicht
{
  const p = await fresh()
  await p.prompt("[ANON:FORCED] force")
  await p.prompt("[ANON:OFF] aus")
  check("OFF wins even if FORCED before", raw(await p.after(PII, { file_path: TRUSTED_PATH })))
}

// 6) Neustart-Semantik: Plugin-Neustart = Filter wieder aktiv (fail-safe)
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] aus")
  check("OFF aktiv", raw(await p.after(PII)))
  const p2 = await fresh() // simuliert Plugin-Reload: frische Instanz
  check("filtered again after plugin restart (fail-safe)", isAnon(await p2.after(PII)))
}

console.log(failures === 0 ? "\n== MARKER SEMANTICS CONFIRMED ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)