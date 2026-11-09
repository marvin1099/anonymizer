// Gemeinsame Test-Helfer: keine Suite haelt mehr einen festen Benutzerpfad.
//
// Was auf einem frisch geklonten Rechner laeuft, ohne deine Konfiguration
// anzufassen:
//
//   * ANON_CONFIG/ANON_SOCK/ANON_STATE/ANON_SANDBOX kommen aus run.sh und
//     zeigen in /tmp/anon-free. Dein echtes ~/.config/opencode/anonymizer.json
//     wird NIE gelesen und NIE ueberschrieben -- siehe test_trusted.ts, die
//     als Einzige eine eigene Config anlegt (per env, nicht per Ueberschreiben).
//
//   * "Muss gefiltert bleiben" braucht PII IM PFAD. Der Daemon ersetzt nur
//     Entities, ein generischer Pfad ergibt 0 Treffer und bleibt literal --
//     dann ist "wird gefiltert" nicht beobachtbar. Deshalb tragen die
//     unvertrauenswuerdigen Pfade Personen- oder Mail-Namen als Ordner.
//     test_random.ts legt dafuer pro Lauf einen zufaelligen Ordner an.
//
//   * Pfade, die ROH bleiben sollen, muessen in der Allowlist liegen. Das
//     sind die eingebauten Pfade (BUILTIN_RAW) oder die Sandbox-Ordner, die
//     run.sh in die Sandbox-Config eintraegt (TRUSTED_*).
import { connect } from "node:net"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"

const HOME = homedir()

// Repo-Root aus dieser Datei abgeleitet: die Tests testen IMMER den Build,
// der im Repo liegt (frisch geklont -> plugin/dist existiert nach run.sh).
const REPO = resolve(import.meta.dir, "..")

// Sandbox -- nur gesetzt, wenn ueber run.sh gestartet wird.
export const SANDBOX = process.env.ANON_SANDBOX ?? "/tmp/anon-free"

// Plugin-Quelle: Repo-Build, damit die Tests die Datei testen, die im Repo liegt.
export const PLUGIN_DIST = process.env.ANON_PLUGIN ?? resolve(REPO, "plugin/dist/index.js")

// Socket und State der Sandbox: eigener Daemon, eigener Zaehlerstand.
export const SOCK = process.env.ANON_SOCK ?? `${SANDBOX}/share/anon.sock`
export const STATE = process.env.ANON_STATE ?? `${SANDBOX}/share/state.json`

// Die Sandbox-Config, die run.sh anlegt -- NIEMALS der echte Benutzer-Pfad.
export const SANDBOX_CONFIG = process.env.ANON_CONFIG ?? `${SANDBOX}/config/anonymizer.json`

// In der Sandbox-Config als vertrauenswuerdig eingetragen -> roh.
export const TRUSTED_DIR = `${SANDBOX}/trusted`
export const TRUSTED_FILE = `${TRUSTED_DIR}/notiz.md`

// In der Allowlist eingebaut, NICHT gesperrt -> roh, unabhaengig von Config.
// Braucht die Datei nicht zu existieren: die Entscheidung ist reine Zeichenketten-
// Pruefung (substring auf dem Pfad-Argument).
export const BUILTIN_RAW = `${HOME}/.config/opencode/plugins/x/y.ts`

// Sperrliste: schlaegt JEDE Allowlist. Absichtlich INNERHALB eines vertrauens-
// wuerdigen Ordners konstruiert -- nur so testet man, dass die Sperre gewinnt.
// Haengt an keinem Benutzerpfad (die Serrliste matcht auf Suffixe).
export const DENIED = `${TRUSTED_DIR}/.local/share/anonymizer/state.json`

// Absolut, in der Allowlist, aber ohne Entity im Pfad: der Pfad selbst bleibt
// literal, der INHALT wird gefiltert. Nur fuer "Inhalt gefiltert" geeignet --
// um zu sehen, dass der PFAD ersetzt wird, braucht es PII im Pfad (unten).
export const LITERAL = `${SANDBOX}/fremd/datei.md`

export const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567."

/** Fail-fast: ohne Sandbox-Umgebung zeigen die Tests gegen den falschen Daemon
 *  (den echten) und wuerden dessen State durcheinanderbringen. */
export function ensureSandboxEnv(): void {
  const missing = ["ANON_SOCK", "ANON_STATE", "ANON_CONFIG"].filter((k) => !process.env[k])
  if (missing.length) {
    throw new Error(
      `Tests ohne Sandbox-Umgebung (fehlt: ${missing.join(", ")}).\n` +
        `Starte sie ueber tests/run.sh -- der isoliert Daemon, Config und State in ${SANDBOX}.`,
    )
  }
}

/** Pro Lauf ein zufaelliger Ordner mit Personen-Name im Pfad. Damit ist
 *  "fremd" abschliessend fremd: nirgends eingetragen, und der Daemon sieht
 *  eine Entity, also wird der Pfad wirklich ersetzt. */
export function randomUntrusted(): string {
  const dir = `${SANDBOX}/Anna Mueller-${Math.random().toString(36).slice(2, 8)}`
  mkdirSync(dir, { recursive: true })
  const file = `${dir}/geheim.md`
  writeFileSync(file, PII)
  return file
}

/** Plugin frisch laden und die Hooks abfangen. Pro Fall eigene Instanz,
 *  damit Marker-Zaehler (singleOff/singleForce/anonOff) nicht ueberlaufen. */
export async function freshPlugin(): Promise<Record<string, (e: any) => Promise<void> | void>> {
  const mod: any = await import(`${PLUGIN_DIST}?case=${Math.random()}`)
  const d: any = mod?.default ?? mod
  const H: Record<string, (e: any) => Promise<void> | void> = {}
  const ctx: any = {
    client: { tui: { showToast: () => Promise.resolve(true) } },
    session: { hook: async (n: string, f: any) => { H[n] = f } },
    tool: { hook: async (n: string, f: any) => { H[n] = f } },
  }
  await (d.setup ?? d.default.setup)(ctx)
  return H
}

/** Marker-Verarbeitung: der Prompt-Hook laeuft VOR der Anfrage. */
export async function runPrompt(text: string, H?: Record<string, any>): Promise<string> {
  const hooks = H ?? (await freshPlugin())
  const ev: any = { prompt: { text } }
  await hooks["prompt"](ev)
  return ev.prompt.text as string
}

/** Ein Tool-Ergebnis durch den Filter schicken. Wichtig: mehrere Aufrufe
 *  muessen dieselbe Instanz nehmen (H), sonst zaehlen die Marker neu los. */
export async function after(
  H: Record<string, any>,
  input: unknown,
  content = PII,
  tool = "read",
): Promise<string> {
  const ev: any = { tool, input, status: "completed", result: { content } }
  await H["execute.after"](ev)
  return ev.result.content as string
}

export const HOME_DIR = HOME

export const isRaw = (s: string) => s === PII
// WICHTIG: "[ANON_ERROR]" entsteht, wenn der Daemon nicht antwortet. Das ist
// ein TESTFEHLER, kein Beweis fuer Filterung -- sonst waere ein toter Daemon
// ein gruener Test.
export const isAnon = (s: string) =>
  !s.includes("peter.parker@example.com") && s.includes("[") && !s.includes("[ANON_ERROR]")

let failures = 0
export function check(name: string, ok: boolean, info = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}
export function finish(label: string): never {
  console.log(failures === 0 ? `\n== ${label} ==` : `\n== ${failures} FEHLER ==`)
  process.exit(failures === 0 ? 0 : 1)
}

/** Daemon-Anfrage ueber den Sandbox-Socket. */
export function send(payload: unknown): Promise<any | null> {
  return new Promise((resolve) => {
    const s = connect(SOCK)
    let buf = ""
    const finishReq = (v: any | null) => {
      s.removeAllListeners()
      s.destroy()
      resolve(v)
    }
    s.setTimeout(240_000, () => finishReq(null))
    s.on("error", () => finishReq(null))
    s.on("data", (c) => {
      buf += c.toString("utf8")
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      try { finishReq(JSON.parse(buf.slice(0, nl))) } catch { finishReq(null) }
    })
    s.on("connect", () => s.write(JSON.stringify(payload) + "\n"))
  })
}
