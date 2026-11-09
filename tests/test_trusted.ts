// Trusted-Pfade aus anonymizer.json -- HEISST: aus EIGENER Test-Config.
//
// Frueher schrieb dieser Test in ~/.config/opencode/anonymizer.json und
// stellte den Inhalt im finally-Block wieder her. Das ist genau die Kopplung,
// die diesen Test nicht universell macht:
//   * Abbruch mid-test (oder Crash in einem Signal-Handler) zerstoerte die
//     echten Pfade des Nutzers,
//   * der Test bestand nur, solange die manuelle Config zufaellig passte,
//   * zwei Tests gleichzeitig liefen sich gegenseitig ueber den Fuss.
//
// Jetzt: eigene Config-Datei in der Sandbox, per ANON_CONFIG gemeldet, bevor
// das Plugin das erste Mal geladen wird (TRUSTED_CONFIG wird beim Import der
// Modul-Datei aus der Umgebung gelesen). Die echte Konfiguration wird nie
// geoeffnet, nie geschrieben, nie wiederhergestellt -- sie wird ignoriert.
//
// Aufruf: ./run.sh test_trusted.ts
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { PLUGIN_DIST, SANDBOX, HOME_DIR, BUILTIN_RAW, TRUSTED_DIR } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

// EIGENE Config -- unabhaengig von der Sandbox-Config, die run.sh anlegt.
// Darin steht am Ende nur, was DIESE Suite braucht.
const OWN_CONFIG = `${SANDBOX}/config/trusted-case.json`
const PREVIOUS_CONFIG = process.env.ANON_CONFIG
process.env.ANON_CONFIG = OWN_CONFIG // VOR dem ersten fresh(): siehe Header

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567."
// "fremd" = nirgends eingetragen. Der Ordnername traegt keine Entity, der
// PATH bleibt also literal -- was nichts ausmacht, denn hier geht es um den
// INHALT (PII darin wird gefiltert, solange der Pfad nicht vertrauenswuerdig).
const OTHER = `${SANDBOX}/anderswo/etwas.txt`

function restoreEnv(): void {
  if (PREVIOUS_CONFIG === undefined) delete process.env.ANON_CONFIG
  else process.env.ANON_CONFIG = PREVIOUS_CONFIG
}
function cleanup(): void {
  restoreEnv()
  if (existsSync(OWN_CONFIG)) rmSync(OWN_CONFIG, { force: true })
}
process.on("exit", cleanup)
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanup()
    process.exit(130)
  })
}

let failures = 0
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}
const raw = (s: string) => s === PII
const isAnon = (s: string) =>
  !s.includes("peter.parker@example.com") && s.includes("[") && !s.includes("[ANON_ERROR]")

let seq = 0
async function fresh() {
  const mod: any = await import(`${PLUGIN_DIST}?case=` + ++seq)
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

// Schreibt ausschliesslich in die EIGENE Datei (Legende -> Testfaelle).
function setConfig(json: string): void {
  mkdirSync(dirname(OWN_CONFIG), { recursive: true })
  writeFileSync(OWN_CONFIG, json)
}

try {
  // 1) Config mit einem Projektordner
  setConfig(JSON.stringify({ trustedPaths: [`${SANDBOX}/mein-projekt`] }))
  {
    const after = await fresh()
    const p = `${SANDBOX}/mein-projekt/notiz.txt`
    check("Config-Pfad ist frei (read)", raw(await after({ file_path: p })),
      (await after({ file_path: p })).slice(0, 40))
    check("anderer Pfad bleibt gefiltert", isAnon(await after({ file_path: OTHER })))
    check("Shell bleibt immer gefiltert",
      isAnon(await after({ command: `cat ${SANDBOX}/mein-projekt/notiz.txt` }, "shell")))
  }

  // 2) Hot-Reload: Pfad wird entfernt -> wieder filtern, ohne Neustart.
  //    (trustedPaths() liest die Datei bei mtime-Aenderung neu.)
  setConfig(JSON.stringify({ trustedPaths: [] }))
  {
    const after = await fresh()
    check("entfernter Pfad wird wieder gefiltert",
      isAnon(await after({ file_path: `${SANDBOX}/mein-projekt/notiz.txt` })))
  }

  // 3) Kaputte Config -> eingebaute Pfade gelten weiter, kein Absturz
  setConfig("{ kaputt: ")
  {
    const after = await fresh()
    check("kaputte Config -> interne Pfade weiter frei", raw(await after({ file_path: BUILTIN_RAW })))
    check("kaputte Config -> externe Pfade gefiltert", isAnon(await after({ file_path: OTHER })))
  }

  // 4) ~/Praefix und Slash-Formen. "~" muss auf DIESEN Rechner expandieren,
  //    deshalb HOME_DIR und kein eingebauter Benutzername.
  setConfig(JSON.stringify({
    trustedPaths: ["~/.claude-trust-dir/", `${SANDBOX}/anders`, `${HOME_DIR}/Notes/privat`],
  }))
  {
    const after = await fresh()
    check("~ wird expandiert",
      raw(await after({ file_path: `${HOME_DIR}/.claude-trust-dir/a.md` })))
    check("Slash-Form am Ende funktioniert",
      raw(await after({ file_path: `${SANDBOX}/anders/a.md` })))
    check("zweiter Pfad ohne Slash auch",
      raw(await after({ file_path: `${HOME_DIR}/Notes/privat/x.md` })))
    check("Prefix-Kollision faellt nicht durch",
      isAnon(await after({ file_path: `${SANDBOX}/andersgelogen/x.md` })))
  }

  // 5) Der eingetragene Ordner traegt die Allowlist, die Sperrliste schlaegt
  //    sie: state.json innerhalb eines vertrauenswuerdigen Ordners bleibt roh
  //    NUR mit [ANON:RAW], nie ohne.
  setConfig(JSON.stringify({ trustedPaths: [TRUSTED_DIR] }))
  {
    const after = await fresh()
    const denied = `${TRUSTED_DIR}/.local/share/anonymizer/state.json`
    check("Sperrliste schlaegt Allowlist (gefiltert)", isAnon(await after({ file_path: denied })))
  }
} finally {
  cleanup()
}

console.log(failures === 0 ? "\n== TRUSTED-CONFIG BESTAETIGT ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)
