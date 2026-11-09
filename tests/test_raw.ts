// Auswege aus der Sperrliste:
//   Default        -> gesperrte Dateien gefiltert
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
  check("Default: gesperrt gefiltert", isAnon(await p.after(DENIED)))
  check("Default: trusted roh", raw(await p.after(TRUSTED)))
  check("Default: fremd gefiltert", isAnon(await p.after(NORMAL)))
}

// 2) [ANON:RAW]: hebt NUR die Sperre
{
  const p = await fresh()
  const t = await p.prompt("[ANON:RAW] ich editiere opencode selbst")
  check("RAW: gesperrt jetzt roh", raw(await p.after(DENIED)))
  check("RAW: fremde Datei bleibt gefiltert", isAnon(await p.after(NORMAL)))
  check("RAW: trusted bleibt roh", raw(await p.after(TRUSTED)))
  check("RAW: Marker bleibt sichtbar", t.includes("ANON:RAW"), JSON.stringify(t))
  check("RAW: Hinweis-Toast", p.toasts.some((x) => /Gesperrte Pfade/.test(x)), p.toasts[0] ?? "-")
}

// 3) RAW endet mit der Nachricht
{
  const p = await fresh()
  await p.prompt("[ANON:RAW] erste Anfrage")
  await p.after(DENIED)
  await p.prompt("zweite Anfrage ohne Marker")
  check("RAW: endet bei markerloser Folgenachricht", isAnon(await p.after(DENIED)))
}

// 4) Voll-Ausweg OFF bleibt moeglich
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] alles roh")
  check("OFF: gesperrt roh", raw(await p.after(DENIED)))
  check("OFF: fremde Datei auch roh", raw(await p.after(NORMAL)))
}

{
  const p = await fresh()
}
console.log(failures === 0 ? "\n== AUSWEGE KORREKT ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)