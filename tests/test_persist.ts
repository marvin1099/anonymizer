import { SOCK, SANDBOX } from "./helpers"
// Beweis: Numbering + Reverse-Mapping ueberleben einen Daemon-Neustart.
// WICHTIG: Alle Platzhalter-Literale in dieser File sind als [[PERSON_x]]
// geschrieben -- der Plugin-Write-Path loest "[PERSON_1]" NICHT auf, es
// schreibt literal "Anna Müller" auf die Platte. Sonst wuerde diese File
// beim Speichern ihre eigenen Marker durch echte Namen ersetzen.
import { connect } from "node:net"
import { writeFileSync, readFileSync, existsSync } from "node:fs"

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
const STATE_FILE = `${SANDBOX}/share/persist_a.json`

async function discoverTags(): Promise<{ anna: string; peter: string; path: string }> {
  const r = await send({
    text: "Anna Müller und Peter Schmidt sind die Contacte. File: ${HOME_DIR}/x.json",
    opts: {},
  })
  const pathTag = r.text.match(/\[URL_\d+\]/)?.[0] ?? ""
  const tags = [...r.text.matchAll(/\[[A-Z][A-Z_]*_\d+\]/g)].map((m) => m[0])
  const rev = await send({ resolve: tags })
  let anna = ""
  let peter = ""
  for (const t of tags) {
    if (rev?.map?.[t] === "Anna Müller") anna = t
    if (rev?.map?.[t] === "Peter Schmidt") peter = t
  }
  return { anna, peter, path: pathTag }
}

if (phase === "a") {
  const r = await send({
    text: "Anna Müller und Peter Schmidt sind die Contacte. File: ${HOME_DIR}/x.json",
    opts: {},
  })
  console.log("Phase A:", r.text)
  const { anna, peter, path } = await discoverTags()
  check("A: two distinct persons", !!anna && !!peter && anna !== peter, r.text)
  const rev = await send({ resolve: [anna, peter, path ?? ""] })
  check("A: Anna resolvable", rev?.map?.[anna] === "Anna Müller", JSON.stringify(rev?.map))
  check("A: Peter resolvable", rev?.map?.[peter] === "Peter Schmidt", JSON.stringify(rev?.map))
  check("A: Path is placeholder and resolvable", !!path && rev?.map?.[path ?? ""] === "${HOME_DIR}/x.json", `${path} -> ${rev?.map?.[path ?? ""]}`)
  try { writeFileSync(STATE_FILE, JSON.stringify({ anna, peter, path })) } catch {}
} else {
  // Phase B: NUR Peter Schmidt + neuer Pfad. Erwartet: Peter Schmidt (NICHT
  // Anna Müller) -- geht nur, wenn der State ueber den Neustart kam.
  let anna = "", peter = ""
  try {
    if (existsSync(STATE_FILE)) {
      const st = JSON.parse(readFileSync(STATE_FILE, "utf8"))
      anna = st.anna ?? ""
      peter = st.peter ?? ""
    }
  } catch {}
  if (!anna || !peter) {
    const d = await discoverTags()
    anna = d.anna
    peter = d.peter
  }
  const r = await send({ text: "Contact Peter Schmidt, File ${HOME_DIR}/y.json", opts: {} })
  console.log("Phase B:", r.text)
  check("B: Peter Schmidt keeps his number", !!peter && r.text.includes(peter) && !r.text.includes(anna), r.text)

  const pathTag = r.text.match(/\[URL_\d+\]/)?.[0]
  const rev = await send({ resolve: [peter, pathTag ?? "", anna] })
  check("B: Reverse mapping after restart", rev?.map?.[peter] === "Peter Schmidt", JSON.stringify(rev?.map))
  check("B: Anna Müller still resolvable", rev?.map?.[anna] === "Anna Müller", JSON.stringify(rev?.map))
  check("B: Path can be translated back", rev?.map?.[pathTag ?? ""] === "${HOME_DIR}/y.json", `${pathTag} -> ${rev?.map?.[pathTag ?? ""]}`)

  // Platzhalter duerfen NICHT erneut anonymisiert werden (sonst Muell-Mapping).
  const again = await send({ text: r.text, opts: {} })
  check("B: Placeholders stay unchanged", again.text === r.text, `${r.text}  ->  ${again.text}`)
}

console.log(failures === 0 ? "\n== PHASE OK ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)