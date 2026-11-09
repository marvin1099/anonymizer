// Auswege aus der Sperrliste:
//   Default        -> gesperrte Fileen gefiltert
//   [ANON:RAW]     -> nur die gesperrten Pfade roh, sonst bleibt alles gefiltert
//   [ANON:OFF]        -> alles roh
// Aufruf: bun test_raw.ts
import { PLUGIN_DIST, DENIED as DENIED_PATH, TRUSTED_FILE } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567."

// DENIED_PATH: Sperrliste, absichtlich innerhalb eines vertrauenswuerdigen
// Ordners -- nur so zeigt der Test, dass die Sperre die Allowlist schlaegt.
// TRUSTED_FILE: vertrauenswuerdig NUR ueber die Sandbox-Config von run.sh.
// Frueher beide ein Benutzerpfad, der nur durch die manuelle Config passte.
const DENIED = DENIED_PATH
const TRUSTED = TRUSTED_FILE
const NORMAL = "/tmp/pii.txt"

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
    after: async (filePath: string) => {
      const ev: any = { tool: "read", input: { file_path: filePath }, status: "completed", result: { content: PII } }
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

// 1) Default: Sperre gilt
{
  const p = await fresh()
  check("Default: blocked filtered", isAnon(await p.after(DENIED)))
  check("Default: trusted raw", raw(await p.after(TRUSTED)))
  check("Default: foreign filtered", isAnon(await p.after(NORMAL)))
}

// 2) [ANON:RAW]: hebt NUR die Sperre
{
  const p = await fresh()
  const t = await p.prompt("[ANON:RAW] ich editiere opencode selbst")
  check("RAW: blocked now raw", raw(await p.after(DENIED)))
  check("RAW: foreign file stays filtered", isAnon(await p.after(NORMAL)))
  check("RAW: trusted stays raw", raw(await p.after(TRUSTED)))
  check("RAW: marker stays visible", t.includes("ANON:RAW"), JSON.stringify(t))
  check("RAW: hint toast", p.toasts.some((x) => /Blocked paths/.test(x)), p.toasts[0] ?? "-")
}

// 3) RAW endet mit der Nachricht
{
  const p = await fresh()
  await p.prompt("[ANON:RAW] erste Anfrage")
  await p.after(DENIED)
  await p.prompt("zweite Anfrage without marker")
  check("RAW: ends on marker-less follow-up", isAnon(await p.after(DENIED)))
}

// 4) Voll-Ausweg OFF bleibt moeglich
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] alles roh")
  check("OFF: blocked raw", raw(await p.after(DENIED)))
  check("OFF: foreign file raw too", raw(await p.after(NORMAL)))
}

{
  const p = await fresh()
}
console.log(failures === 0 ? "\n== ESCAPES CORRECT ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)