import { SOCK } from "./helpers"
// Verify that numbering and reverse mapping survive a daemon restart without
// clearing state. A unique name keeps the placeholder unambiguous.
// Run with: bun test_persist_warm.ts a, restart the daemon, then use phase b.
import { connect } from "node:net"

const S = String.fromCharCode(91)
const C = String.fromCharCode(93)
const NAME = "Wilhelmine Faydrbush"
const PATH = "/home/example-user/warm.json"

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
// Extract a tag without regex: the opening bracket precedes the label, then
// only digits follow. A character class would be error-prone here.
const grab = (t: string, label: string) => {
  const i = t.indexOf(label)
  if (i === -1) return ""
  const open = t.lastIndexOf(S, i)
  let k = i + label.length
  while (k < t.length && t[k] >= "0" && t[k] <= "9") k++
  return t.slice(open, k) + C
}

const r = await send({ text: `Contact ${NAME}, file ${PATH}`, opts: {} })
if (!r?.text) {
  console.log("FAIL  daemon did not respond (socket " + SOCK + ")")
  process.exit(1)
}
const tag = grab(r.text, "PERSON_")
const pathTag = grab(r.text, "URL_")
check("Name recognized as PERSON", !!tag, r.text)
check("Path recognized as URL", !!pathTag, r.text)
const rev = await send({ resolve: [tag ?? "", pathTag ?? ""] })
check("Name reverse-resolvable", rev?.map?.[tag ?? ""] === NAME, JSON.stringify(rev?.map))
// The URL span may include the leading word ("File /path"), so check inclusion.
check("Path reverse-resolvable", (rev?.map?.[pathTag ?? ""] ?? "").includes(PATH), (pathTag ?? "") + " -> " + rev?.map?.[pathTag ?? ""])

if ((process.argv[2] ?? "a") === "a") {
  console.log("TAG=" + (tag ?? ""))
} else {
  console.log("expected TAG=" + (tag ?? ""))
}
console.log(failures === 0 ? "\n== PHASE OK ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)
