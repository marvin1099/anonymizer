// Regressionstest fuer: "File not found: /Users/[PERSON_9]/.config/..."
// Szenario wie im Vorfall: Plugin-Map leer (Reload) + Placeholder aus einer
// aelteren Session -> muss ueber den Daemon aufloesbar sein.
import { connect } from "node:net"

const SOCK = "/Users/example-user/.local/share/anonymizer/anon.sock"

function send(payload: unknown): Promise<any | null> {
  return new Promise((resolve) => {
    const s = connect(SOCK)
    let buf = ""
    const finish = (v: any | null) => {
      s.removeAllListeners()
      s.destroy()
      resolve(v)
    }
    s.setTimeout(240_000, () => finish(null))
    s.on("error", () => finish(null))
    s.on("data", (c) => {
      buf += c.toString("utf8")
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      try {
        finish(JSON.parse(buf.slice(0, nl)))
      } catch {
        finish(null)
      }
    })
    s.on("connect", () => s.write(JSON.stringify(payload) + "\n"))
  })
}

let failures = 0
function check(name: string, ok: boolean, info = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}

// --- 1. Pfad anonymisieren: was sieht das Modell? -------------------------
const text = "Bitte die Datei /Users/example-user/.config/opencode/opencode.jsonc öffnen, Kontakt Anna Müller (01701234567)."
const resp = await send({ text, opts: {} })
check("Daemon antwortet", !!resp?.ok)
const anonymized = resp.text
console.log(`      Modell sieht: ${anonymized}`)
const tag = anonymized.match(/\[[A-Z][A-Z_]*_\d+\]/)?.[0]
check("Pfad wurde anonymisiert", !!anonymized.includes("[") && !anonymized.includes("example-user"), anonymized.split(" ")[4])

// --- 2. simulate plugin reload: LEERE mapping, nur Daemon-Reverse ---------
const rev = await send({ resolve: [tag] })
const mapped = rev?.map?.[tag]
check("Reverse-Lookup liefert Original", mapped === "example-user", `${tag} -> ${mapped}`)

const path = anonymized.split(" ").find((w: string) => w.startsWith("/Users/"))
const resolvedPath = path.replace(tag, mapped ?? "")
check("Pfad wieder vollstaendig", resolvedPath === "/Users/example-user/.config/opencode/opencode.jsonc", resolvedPath)

// --- 3. Alle Placeholder der Textstelle aufloesbar -------------------------
const allTags = [...anonymized.matchAll(/\[([A-Z][A-Z_]*_\d+)\]/g)].map((m) => m[0])
const revAll = await send({ resolve: allTags })
check(
  "Alle Tags der Textstelle aufloesbar",
  allTags.every((t) => !!revAll?.map?.[t]),
  allTags.map((t) => `${t}=${revAll?.map?.[t]}`).join(", "),
)

// --- 4. Swap-Semantik bleibt erhalten -------------------------------------
const f = revAll.map["[PERSON_1]"]
const g = revAll.map["[PERSON_2]"]
if (f && g) {
  const swapped = `[PERSON_2] ${g.split(" ")[1]} und [PERSON_1] ${f.split(" ")[1]}`
    .replace("[PERSON_1]", g)
    .replace("[PERSON_2]", f)
  check("Swap aufloesbar", swapped.includes(f) && swapped.includes(g), swapped)
} else {
  console.log("SKIP  Swap (nur ein PERSON im Text)")
}

// --- 5. Unbekannter Tag bleibt unangetastet -------------------------------
const revUnknown = await send({ resolve: ["[PERSON_999]"] })
check("Unbekannter Tag liefert nichts", !revUnknown?.map?.["[PERSON_999]"])

console.log(failures === 0 ? "\n== ALLE TESTS BESTANDEN ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)