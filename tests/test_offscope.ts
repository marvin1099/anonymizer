// Marker semantics: OFF is sticky; FORCED applies to one request.
//  1) Single and double brackets work.
//  2) Marker position does not matter.
//  3) OFF stays active across requests until [[ANON:ON]].
//  4) FORCED applies only to one request.
// Run with: bun test_offscope.ts
import { PLUGIN_DIST } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 30 23125 0."
const TRUSTED_PATH = "/home/example-user/.local/share/anonymizer/x.txt"

let seq = 0
async function fresh() {
  const mod: any = await import(
    `${PLUGIN_DIST}?case=` + ++seq
  )
  const d: any = (mod as any)?.default ?? mod
  const H: Record<string, (e: any) => Promise<void> | void> = {}
  const toasts: string[] = []
  const ctx: any = {
    client: {
      tui: { showToast: (o: any) => { toasts.push(o?.body?.message ?? ""); return Promise.resolve(true) } },
    },
    session: { hook: async (n: string, f: any) => { H[n] = f } },
    tool: { hook: async (n: string, f: any) => { H[n] = f } },
  }
  await (d.setup ?? d.default.setup)(ctx)
  return {
    toasts,
    after: async (content: string, input: unknown = { file_path: "/tmp/x" }) => {
      const ev: any = { tool: "read", input, status: "completed", result: { content } }
      await H["execute.after"](ev)
      return ev.result.content as string
    },
    prompt: async (text: string) => {
      const ev: any = { prompt: { text } }
      await H["prompt"](ev)
      return ev.prompt.text as string
    },
  }
}

let failures = 0
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}
const raw = (s: string) => s === PII
const isAnon = (s: string) => !s.includes("peter.parker@example.com") && s.includes("[")

// 1) Both single and double brackets work.
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] take a look")
  check("single bracket works too", raw(await p.after(PII)))
}
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] take a look")
  check("double bracket works", raw(await p.after(PII)))
}
{
  const p = await fresh()
  const t = await p.prompt("Can you [ANON:OFF] read the file?")
  check("position irrelevant (mid-text)", !t.includes("ANON:OFF") && raw(await p.after(PII)))
}

// 2) OFF ends on the next message without a marker; [[ANON:ON]] is not needed.
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] first request")
  await p.after(PII) // First request: raw.
  await p.prompt("second request, no marker")
  const second = await p.after(PII)
  check("marker-less message re-arms", isAnon(second), second.slice(0, 40))
  await p.prompt("third request, no marker")
  check("stays filtered in third", isAnon(await p.after(PII)))
  check("hint toast on re-arm", p.toasts.some((t) => /re-enabled/.test(t)), p.toasts[0] ?? "-")
}

// 2b) OFF remains active across requests only when repeated.
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] first request")
  await p.prompt("[ANON:OFF] second request, marker repeated")
  check("OFF with repeated marker", raw(await p.after(PII)), raw(await p.after(PII)) ? "raw" : "filtered")
  await p.prompt("third request without marker")
  check("filtered again after", isAnon(await p.after(PII)))
}

// 2c) Show a warning toast while OFF is active.
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] request")
  check("warning toast when OFF active", p.toasts.some((t) => /Anonymization is OFF/.test(t)), p.toasts[0] ?? "-")
  check("OFF text mentions end", p.toasts.some((t) => /marker-less message/.test(t)))
}

// 2d) [[ANON:ON]] immediately re-enables filtering.
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] do something")
  const t = await p.prompt("[ANON:ON] stop, filter again")
  check("ON marker removed", !t.includes("ANON"), JSON.stringify(t))
  check("ON switches in same session", isAnon(await p.after(PII)))
}

// 3) Sticky OFF survives many tool calls (no token budget).
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] long request")
  let stillRaw = true
  for (let i = 0; i < 30; i++) if (!raw(await p.after(PII))) stillRaw = false
  check("OFF lasts 30 tool calls", stillRaw, "no expiry after 20")
}

// 4) FORCED applies to one request.
{
  const p = await fresh()
  await p.prompt("[ANON:FORCED] force request")
  check("FORCED filters internal path", isAnon(await p.after(PII, { file_path: TRUSTED_PATH })))
  await p.prompt("next request without marker")
  const t2 = await p.after(PII, { file_path: TRUSTED_PATH })
  check("FORCED ends with request", raw(t2), raw(t2) ? "trusted path is raw again" : "still filtered -> stale force")
}
{
  const p = await fresh()
  await p.prompt("[ANON:FORCE] without D")
  check("FORCE without D works", isAnon(await p.after(PII, { file_path: TRUSTED_PATH })))
}

// 5) OFF takes precedence over FORCED, but not vice versa.
{
  const p = await fresh()
  await p.prompt("[ANON:FORCED] force")
  await p.prompt("[ANON:OFF] off")
  check("OFF wins even if FORCED before", raw(await p.after(PII, { file_path: TRUSTED_PATH })))
}

// 6) Restarting the plugin re-enables filtering (fail-safe).
{
  const p = await fresh()
  await p.prompt("[ANON:OFF] off")
  check("OFF active", raw(await p.after(PII)))
  const p2 = await fresh() // Simulate a plugin reload with a fresh instance.
  check("filtered again after plugin restart (fail-safe)", isAnon(await p2.after(PII)))
}

console.log(failures === 0 ? "\n== MARKER SEMANTICS CONFIRMED ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)
