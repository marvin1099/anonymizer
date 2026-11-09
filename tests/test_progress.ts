// Progress feedback: large outputs show progress toasts; small outputs stay
// quiet. The client is mocked, but the daemon is real.
// Run with: bun test_progress.ts
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

// 1) Small text produces no toast.
toasts.length = 0
const small = await run("Peter Parker aus Berlin, peter.parker@example.com, Tel +49 30 23125 0")
check("small: no toasts", toasts.length === 0, `${small.ms}ms, ${toasts.length} Toasts`)
check("small: still anonymized", small.out.includes("["), small.out.slice(0, 70))

// 2) Large text (~60 KB) shows progress toasts. Unique text avoids an immediate
// cache hit, which is expected behavior but would make this test uninformative.
const uniq = Math.random().toString(36).slice(2, 10)
const unit = `Contact Nico Example, Tel +49 30 23125 0, Email nico.example@example.com, Location Berlin; Device example laptop, 256 GB, IT warehouse 2, Ticket ${uniq}-${Math.random().toString(36).slice(2, 8)}. `
const bigText = unit.repeat(Math.ceil(60000 / unit.length))
toasts.length = 0
const big = await run(bigText)
const progressToasts = toasts.filter((t) => /\d+\/\d+ sections/.test(t.message))
const doneToast = toasts.filter((t) => t.variant === "success")
check("large: takes noticeably (>3s)", big.ms > 3000, `${big.ms}ms`)
check("large: progress toasts", progressToasts.length >= 2, `${progressToasts.length} Toasts, z.B. "${progressToasts[0]?.message ?? "-"}"`)
check("large: completion toast", doneToast.length === 1, doneToast[0]?.message ?? "-")
// The model is context-dependent and may not mark every repeated name. Most
// occurrences should still be removed.
const occurrences = (bigText.match(/Nico Example/g) ?? []).length
const left = (big.out.match(/Nico Example/g) ?? []).length
const ratio = 1 - left / occurrences
check("gross: names mostly replaced (>80 %)", ratio > 0.8, `${occurrences - left}/${occurrences} ersetzt (${(ratio * 100).toFixed(1)} %)`)
check("gross: toast count moderate (<40)", toasts.length < 40, `${toasts.length}`)

// 3) Progress is monotonic.
const pcts = progressToasts.map((t) => Number(t.message.match(/(\d+) %/)![1]))
const monotonic = pcts.every((p, i) => i === 0 || p >= pcts[i - 1])
check("gross: progress monotonic", monotonic, pcts.join(" -> "))

console.log(failures === 0 ? "\n== ALL PROGRESS TESTS PASSED ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)
