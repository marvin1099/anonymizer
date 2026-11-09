// Test: Progress-Feedback. grosse Ausgabe -> Toasts mit Fortschritt,
// kleine Ausgabe -> stumm. Mocked client, echter Daemon.
// Aufruf: bun test_progress.ts
import { PLUGIN_DIST } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const toasts: Array<{ message: string; variant: string }> = []
const H: Record<string, (e: any) => Promise<void> | void> = {}
const ctx: any = {
  client: {
    tui: {
      showToast: (opts: any) => {
        toasts.push({ message: opts?.body?.message ?? "", variant: opts?.body?.variant ?? "" })
        return Promise.resolve(true)
      },
    },
  },
  session: { hook: async (n: string, f: any) => { H[n] = f } },
  tool: { hook: async (n: string, f: any) => { H[n] = f } },
}

const d: any = (def0 as any)?.default ?? def0
await (d.setup ?? d.default.setup)(ctx)

let failures = 0
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}

const run = async (text: string) => {
  const ev: any = { tool: "read", input: { file_path: "/tmp/x.csv" }, status: "completed", result: { content: text } }
  const t0 = Date.now()
  await H["execute.after"](ev)
  return { ms: Date.now() - t0, out: ev.result.content as string }
}

// 1) kleiner Text -> kein Toast
toasts.length = 0
const small = await run("Peter Parker aus Berlin, peter.parker@example.com, Tel 01701234567")
check("small: no toasts", toasts.length === 0, `${small.ms}ms, ${toasts.length} Toasts`)
check("small: still anonymized", small.out.includes("["), small.out.slice(0, 70))

// 2) grosser Text (~60 KB) -> Fortschritts-Toasts sichtbar.
// EIGENTUM im Text, sonst liefert der Daemon-Cache sofort (3 ms, kein
// Fortschritt) -- das ist gewolltes Verhalten, fuer diesen Test aber unbrauchbar.
const uniq = Math.random().toString(36).slice(2, 10)
const unit = `Contact Nico Jacobs, Tel 01701234567, Mail nico.jacobs@firma.de, Ort Berlin; Gerät MacBookPro, 256 GB, IT-Lager 2, Vorgang ${uniq}-${Math.random().toString(36).slice(2, 8)}. `
const bigText = unit.repeat(Math.ceil(60000 / unit.length))
toasts.length = 0
const big = await run(bigText)
const progressToasts = toasts.filter((t) => /\d+\/\d+ sections/.test(t.message))
const doneToast = toasts.filter((t) => t.variant === "success")
check("large: takes noticeably (>3s)", big.ms > 3000, `${big.ms}ms`)
check("large: progress toasts", progressToasts.length >= 2, `${progressToasts.length} Toasts, z.B. "${progressToasts[0]?.message ?? "-"}"`)
check("large: completion toast", doneToast.length === 1, doneToast[0]?.message ?? "-")
// Bei 60 KB identischem Text erwarten wir keine 100 %-Quote: das Modell ist
// kontextabhaengig und markiert nicht jede Wiederholung. Massstab: der
// weitaus groesste Teil muss weg sein.
const occurrences = (bigText.match(/Nico Jacobs/g) ?? []).length
const left = (big.out.match(/Nico Jacobs/g) ?? []).length
const ratio = 1 - left / occurrences
check("gross: names mostly replaced (>80 %)", ratio > 0.8, `${occurrences - left}/${occurrences} ersetzt (${(ratio * 100).toFixed(1)} %)`)
check("gross: toast count moderate (<40)", toasts.length < 40, `${toasts.length}`)

// 3) Fortschritt ist monoton
const pcts = progressToasts.map((t) => Number(t.message.match(/(\d+) %/)![1]))
const monotonic = pcts.every((p, i) => i === 0 || p >= pcts[i - 1])
check("gross: progress monotonic", monotonic, pcts.join(" -> "))

console.log(failures === 0 ? "\n== ALL PROGRESS TESTS PASSED ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)