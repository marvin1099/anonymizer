// Beweis: Numbering + Reverse-Mapping ueberleben einen Daemon-Neustart.
// WICHTIG: Alle Platzhalter-Literale in dieser Datei sind als [[PERSON_x]]
// geschrieben -- der Plugin-Write-Path loest "[PERSON_1]" NICHT auf, es
// schreibt literal "Anna Müller" auf die Platte. Sonst wuerde diese Datei
// beim Speichern ihre eigenen Marker durch echte Namen ersetzen.
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
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}

const phase = process.argv[2] ?? "a"
const T1 = "[PERSON_1]"
const T2 = "[PERSON_2]"

if (phase === "a") {
  const r = await send({
    text: "Anna Müller und Peter Schmidt sind die Kontakte. Datei: /Users/example-user/x.json",
    opts: {},
  })
  console.log("Phase A:", r.text)
  check("A: zwei Personen distinct", r.text.includes(T1) && r.text.includes(T2), r.text)
  const pathTag = r.text.match(/\[URL_\d+\]/)?.[0]
  const rev = await send({ resolve: [T1, T2, pathTag ?? ""] })
  check("A: Anna aufloesbar", rev?.map?.[T1] === "Anna Müller", JSON.stringify(rev?.map))
  check("A: Peter aufloesbar", rev?.map?.[T2] === "Peter Schmidt", JSON.stringify(rev?.map))
  check("A: Pfad ist Platzhalter und aufloesbar", !!pathTag && rev?.map?.[pathTag ?? ""] === "/Users/example-user/x.json", `${pathTag} -> ${rev?.map?.[pathTag ?? ""]}`)
} else {
  // Phase B: NUR Peter Schmidt + neuer Pfad. Erwartet: Peter Schmidt (NICHT
  // Anna Müller) -- geht nur, wenn der State ueber den Neustart kam.
  // Wichtig: kein "Nur" davor -- GLiNER labelt "Nur Peter Schmidt" als einen
  // kompletten Person-Span und vergaebe damit eine neue Nummer.
  const r = await send({ text: "Kontakt Peter Schmidt, Datei /Users/example-user/y.json", opts: {} })
  console.log("Phase B:", r.text)
  check("B: Peter Schmidt behaelt seine Nummer", r.text.includes(T2) && !r.text.includes(T1), r.text)

  const pathTag = r.text.match(/\[URL_\d+\]/)?.[0]
  const rev = await send({ resolve: [T2, pathTag ?? "", T1] })
  check("B: Reverse-Mapping nach Neustart", rev?.map?.[T2] === "Peter Schmidt", JSON.stringify(rev?.map))
  check("B: auch Anna Müller noch aufloesbar", rev?.map?.[T1] === "Anna Müller", JSON.stringify(rev?.map))
  check("B: Pfad laesst sich zurueckuebersetzen", rev?.map?.[pathTag ?? ""] === "/Users/example-user/y.json", `${pathTag} -> ${rev?.map?.[pathTag ?? ""]}`)

  // Platzhalter duerfen NICHT erneut anonymisiert werden (sonst Muell-Mapping).
  const again = await send({ text: r.text, opts: {} })
  check("B: Platzhalter bleiben unveraendert", again.text === r.text, `${r.text}  ->  ${again.text}`)
}

console.log(failures === 0 ? "\n== PHASE OK ==" : `\n== ${failures} FEHLER ==`)
process.exit(failures === 0 ? 0 : 1)