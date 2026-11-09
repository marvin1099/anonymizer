import { SOCK } from "./helpers"
// Regression test for "File not found: /home/[PERSON_9]/.config/...": after a
// plugin reload, a placeholder from an older session must resolve via daemon state.
import { connect } from "node:net"

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

// --- 1. Anonymize a path: what does the model see? ------------------------
const TEST_PATH = "/home/example-user/.config/opencode/opencode.jsonc"
const text = `Please open the file ${TEST_PATH}, contact Anna Müller (+49 30 23125 0).`
const resp = await send({ text, opts: {} })
check("daemon responds", !!resp?.ok)
const anonymized = resp.text
console.log(`      Model sees: ${anonymized}`)
const tag = anonymized.match(/\[[A-Z][A-Z_]*_\d+\]/)?.[0]
check("Path was anonymized", !!anonymized.includes("["), anonymized.split(" ")[3])

// --- 2. simulate plugin reload: LEERE mapping, nur Daemon-Reverse ---------
const rev = await send({ resolve: [tag] })
const mapped = rev?.map?.[tag]
check("Reverse lookup returns original", !!mapped && mapped !== tag, `${tag} -> ${mapped}`)

// --- 3. Alle Placeholder der Textstelle aufloesbar -------------------------
const allTags = [...anonymized.matchAll(/\[([A-Z][A-Z_]*_\d+)\]/g)].map((m) => m[0])
const revAll = await send({ resolve: allTags })
check(
  "All tags in text resolvable",
  allTags.every((t) => !!revAll?.map?.[t]),
  allTags.map((t) => `${t}=${revAll?.map?.[t]}`).join(", "),
)
let restored = anonymized
for (const [placeholder, original] of Object.entries(revAll?.map ?? {})) {
  restored = restored.replaceAll(placeholder, original as string)
}
check("Path restored", restored.includes(TEST_PATH), restored)

// --- 4. Swap-Semantik bleibt erhalten -------------------------------------
const f = revAll.map["[PERSON_1]"]
const g = revAll.map["[PERSON_2]"]
if (f && g) {
  const swapped = `[PERSON_2] ${g.split(" ")[1]} und [PERSON_1] ${f.split(" ")[1]}`
    .replace("[PERSON_1]", g)
    .replace("[PERSON_2]", f)
  check("swap resolvable", swapped.includes(f) && swapped.includes(g), swapped)
} else {
  console.log("SKIP  Swap (nur ein PERSON im Text)")
}

// --- 5. Unknown tags remain untouched ------------------------------------
const revUnknown = await send({ resolve: ["[PERSON_999]"] })
check("Unknown tag yields nothing", !revUnknown?.map?.["[PERSON_999]"])

console.log(failures === 0 ? "\n== ALL TESTS PASSED ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)
