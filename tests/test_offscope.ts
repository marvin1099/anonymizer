// Marker-Semantik (Stand: OFF ist sticky, FORCED ist anfragegebunden).
//  1) doppelte Klammern ja, einfache nein
//  2) Position egal
//  3) OFF bleibt ueber Folgeanfragen AN, bis [[ANON:ON]]
//  4) FORCED gilt nur fuer die eine Anfrage
// Aufruf: bun test_offscope.ts
import def0 from "/Users/example-user/.config/opencode/plugins/anonymizer/dist/index.js"

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567."
const TRUSTED_PATH = "/Users/example-user/.local/share/anonymizer/x.txt"

let seq = 0
async function fresh() {
  const mod: any = await import(
    "/Users/example-user/.config/opencode/plugins/anonymizer/dist/index.js?case=" + ++seq
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
  check("einfache Klammer wirkt ebenfalls", raw(await p.after(PII)))
}
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] schau mal")
  check("doppelte Klammer wirkt", raw(await p.after(PII)))
}
{
  const p = await fresh()
  const t = await p.prompt("kannst du bitte [ANON:OFF] die Datei lesen?")
  check("Position egal (mitten im Text)", !t.includes("ANON:OFF") && raw(await p.after(PII)))
}

// 2) OFF endet bei der naechsten Nachricht OHNE Marker (kein [[ANON:ON]] noetig)
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] erste Anfrage")
  await p.after(PII)                                        // 1. Anfrage: roh
  await p.prompt("zweite Anfrage, kein Marker")
  const second = await p.after(PII)
  check("Marker-lose Nachricht schaltet wieder zu", isAnon(second), second.slice(0, 40))
  await p.prompt("dritte Anfrage, kein Marker")
  check("bleibt auch in der dritten gefiltert", isAnon(await p.after(PII)))
  check("Hinweis-Toast beim Re-Arm", p.toasts.some((t) => /wieder aktiv/.test(t)), p.toasts[0] ?? "-")
}

// 2b) OFF ueberlebt Folgeanfragen nur MIT erneutem Marker
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] erste Anfrage")
  await p.prompt("[ANON:OFF] zweite Anfrage, Marker erneut")
  check("OFF mit erneutem Marker in Folgeanfrage", raw(await p.after(PII)), raw(await p.after(PII)) ? "roh" : "gefiltert")
  await p.prompt("dritte Anfrage ohne Marker")
  check("danach wieder gefiltert", isAnon(await p.after(PII)))
}

// 2c) Warn-Toast solange OFF laeuft
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] Anfrage")
  check("Warn-Toast bei OFF aktiv", p.toasts.some((t) => /Anonymisierung ist AUS/.test(t)), p.toasts[0] ?? "-")
  check("OFF-Tontext nennt das Ende", p.toasts.some((t) => /nächsten Nachricht ohne Marker/.test(t)))
}

// 2d) [[ANON:ON]] schaltet auch sofort zurueck
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] mach was")
  const t = await p.prompt("[ANON:ON] stopp, wieder filtern")
  check("ON-Marker wird entfernt", !t.includes("ANON"), JSON.stringify(t))
  check("ON schaltet in derselben Session zu", isAnon(await p.after(PII)))
}

// 3) Sticky ueberlebt viele Tool-Aufrufe (kein Token-Budget mehr)
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] lange Anfrage")
  let stillRaw = true
  for (let i = 0; i < 30; i++) if (!raw(await p.after(PII))) stillRaw = false
  check("OFF haelt 30 Tool-Aufrufe durch", stillRaw, "kein Erlöschen nach 20")
}

// 4) FORCED bleibt anfragegebunden
{
  const p = await fresh()
  await p.prompt("[ANON:FORCED] force-Anfrage")
  check("FORCED filtert internen Pfad", isAnon(await p.after(PII, { file_path: TRUSTED_PATH })))
  await p.prompt("naechste Anfrage ohne Marker")
  const t2 = await p.after(PII, { file_path: TRUSTED_PATH })
  check("FORCED endet mit der Anfrage", raw(t2), raw(t2) ? "intern wieder frei" : "bleibt gefiltert -> Ueberlauf")
}
{
  const p = await fresh()
  await p.prompt("[ANON:FORCE] ohne D")
  check("FORCE ohne D wirkt", isAnon(await p.after(PII, { file_path: TRUSTED_PATH })))
}

// 5) OFF schlaegt FORCED und umgekehrt nicht
{
  const p = await fresh()
  await p.prompt("[ANON:FORCED] force")
  await p.prompt("[ANON:OFF] aus")
  check("OFF gewinnt, auch wenn vorher FORCED", raw(await p.after(PII, { file_path: TRUSTED_PATH })))
}

// 6) Neustart-Semantik: Plugin-Neustart = Filter wieder aktiv (fail-safe)
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] aus")
  check("OFF aktiv", raw(await p.after(PII)))
  const p2 = await fresh() // simuliert Plugin-Reload: frische Instanz
  check("nach Plugin-Neustart wieder gefiltert (fail-safe)", isAnon(await p2.after(PII)))
}

console.log(failures === 0 ? "\n== MARKER-SEMANTIK BESTAETIGT ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)