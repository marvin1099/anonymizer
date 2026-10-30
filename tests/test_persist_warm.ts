// Beweis ohne State-Leerung: Numbering + Reverse-Mapping ueberleben einen
// Daemon-Neustart. Nutzt einen einmaligen Namen, damit die Nummern in einem
// warmen State eindeutig sind (state.json wird bewusst NICHT geloescht).
// Aufruf: bun test_persist_warm.ts a   |   Neustart   |   bun test_persist_warm.ts b
import { connect } from "node:net"

const S = String.fromCharCode(91)
const C = String.fromCharCode(93)
const SOCK = "/Users/example-user/.local/share/anonymizer/anon.sock"
const NAME = "Wilhelmine Faydrbush"
const PATH = "/Users/example-user/persist_warm.json"

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
    s.on("error", (e: any) => finish(null))
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
const check = (name: string, ok: boolean, info = "") => {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (info ? "  -> " + info : ""))
  if (!ok) failures++
}
// Extrakt ohne Regex: die oeffnende Klammer steht direkt vor dem Label,
// danach folgen nur Ziffern. Regex waere hier eine Zeichenklasse-Falle.
const grab = (t: string, label: string) => {
  const i = t.indexOf(label)
  if (i === -1) return ""
  const open = t.lastIndexOf(S, i)
  let k = i + label.length
  while (k < t.length && t[k] >= "0" && t[k] <= "9") k++
  return t.slice(open, k) + C
}

const r = await send({ text: `Kontakt ${NAME}, Datei ${PATH}`, opts: {} })
if (!r?.text) {
  console.log("FAIL  Daemon antwortet nicht (Socket " + SOCK + ")")
  process.exit(1)
}
const tag = grab(r.text, "PERSON_")
const pathTag = grab(r.text, "URL_")
check("Name wurde als PERSON erkannt", !!tag, r.text)
check("Pfad wurde als URL erkannt", !!pathTag, r.text)
const rev = await send({ resolve: [tag ?? "", pathTag ?? ""] })
check("Name ist rueckwaerts aufloesbar", rev?.map?.[tag ?? ""] === NAME, JSON.stringify(rev?.map))
// Der URL-Span umfasst das fuehrende Wort mit ("Datei /pfad") -- daher contains.
check("Pfad ist rueckwaerts aufloesbar", (rev?.map?.[pathTag ?? ""] ?? "").includes(PATH), (pathTag ?? "") + " -> " + rev?.map?.[pathTag ?? ""])

if ((process.argv[2] ?? "a") === "a") {
  console.log("TAG=" + (tag ?? ""))
} else {
  console.log("erwartet TAG=" + (tag ?? ""))
}
console.log(failures === 0 ? "\n== PHASE OK ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)
