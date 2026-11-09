// Unit test for the anonymizer plugin hooks (mocked ctx, real daemon).
// Usage: bun test_hooks.ts <mode>   (runs one mode)
//        bun test_hooks.ts          (runs ALL modes, fresh instance per mode)
// Prints only PASS/FAIL + placeholder snippets — never raw PII.
import { PLUGIN_DIST, HOME_DIR } from "./helpers"

const PII =
  "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567, IBAN DE89 3704 0044 0532 0130 00."

const MODES = [
  "strip-off",
  "strip-forced",
  "base-untrusted",
  "base-trusted",
  "forced-trusted",
  "off",
  "reverse",
  "reverse-off",
  "reverse-stale",
  "reverse-path",
  "reverse-pathspan",
]

type Inst = {
  H: Record<string, (e: any) => Promise<void> | void>
  after: (tool: string, input: unknown, content: string) => Promise<string>
  before: (tool: string, input: any) => Promise<any>
  prompt: (text: string) => Promise<string>
}

async function makeInstance(): Promise<Inst> {
  const mod: any = await import(`${PLUGIN_DIST}?case=${Math.random()}`)
  const d: any = (mod as any)?.default ?? mod
  const H: Record<string, (e: any) => Promise<void> | void> = {}
  const ctx: any = {
    session: { hook: async (n: string, f: any) => { H[n] = f } },
    tool: { hook: async (n: string, f: any) => { H[n] = f } },
  }
  const setup = d?.setup ?? d?.default?.setup
  if (!setup) {
    console.log(`FAIL: no setup found, keys=${Object.keys(d ?? {})}`)
    process.exit(1)
  }
  await setup(ctx)
  if (!H["prompt"] || !H["execute.before"] || !H["execute.after"]) {
    console.log(`FAIL: hooks missing: ${Object.keys(H).join(",")}`)
    process.exit(1)
  }
  const after = async (tool: string, input: unknown, content: string) => {
    const ev: any = { tool, input, status: "completed", result: { content } }
    await H["execute.after"](ev)
    return ev.result.content as string
  }
  const before = async (tool: string, input: any) => {
    const ev: any = { tool, input }
    await H["execute.before"](ev)
    return ev.input
  }
  const prompt = async (text: string) => {
    const ev: any = { prompt: { text } }
    await H["prompt"](ev)
    return ev.prompt.text as string
  }
  return { H, after, before, prompt }
}

function clean(s: string) { return s.replace(/\s+/g, " ").trim().slice(0, 90) }

async function runMode(mode: string): Promise<{ ok: boolean; note: string }> {
  const inst = await makeInstance()
  const { after, before, prompt, H } = inst
  let ok = false
  let note = ""

  if (mode === "strip-off") {
    const t = await prompt(`[ANON:OFF] ${PII}`)
    ok = !t.includes("[ANON:") && t.includes("Peter Parker")
    note = clean(t)
  } else if (mode === "strip-forced") {
    const t = await prompt(`[ANON:FORCED] ${PII}`)
    ok = !t.includes("[ANON:") && t.includes("Peter Parker")
    note = clean(t)
  } else if (mode === "base-untrusted") {
    const out = await after("read", { file_path: "/tmp/pii.txt" }, PII)
    ok = out !== PII && !out.includes("peter.parker@example.com")
    note = clean(out)
  } else if (mode === "base-trusted") {
    const out = await after("read", { file_path: `${HOME_DIR}/.local/share/anonymizer/x.txt` }, PII)
    ok = out === PII
    note = "trusted -> roh"
  } else if (mode === "forced-trusted") {
    await prompt("[ANON:FORCED] test")
    const out = await after("read", { file_path: `${HOME_DIR}/.local/share/anonymizer/x.txt` }, PII)
    ok = out !== PII && !out.includes("peter.parker@example.com")
    note = clean(out)
  } else if (mode === "off") {
    await prompt("[ANON:OFF] test")
    const out = await after("read", { file_path: "/tmp/pii.txt" }, PII)
    ok = out === PII
    note = "OFF -> roh"
  } else if (mode === "reverse") {
    const anon = await after("read", { file_path: "/tmp/pii.txt" }, PII)
    const p = anon.match(/\[PERSON_\d+\]/)?.[0]
    const inp: any = await before("bash", { command: `grep "${p}" /tmp/pii.txt` })
    ok = !!p && inp.command.includes("Peter Parker")
    note = `${p} -> ${clean(inp.command)}`
  } else if (mode === "reverse-off") {
    const anon = await after("read", { file_path: "/tmp/pii.txt" }, PII)
    const p = anon.match(/\[PERSON_\d+\]/)?.[0]
    await prompt("[ANON:OFF] test")
    const inp: any = await before("bash", { command: `grep "${p}" /tmp/pii.txt` })
    const outOff = await after("read", { file_path: "/tmp/pii.txt" }, PII)
    ok = !!p && inp.command.includes("Peter Parker") && outOff === PII
    note = `Input aufgeloest (${clean(inp.command)}), Output roh trotz OFF`
  } else if (mode === "reverse-stale") {
    const ev: any = { tool: "read", input: { file_path: "/tmp/pii.txt" }, status: "completed", result: { content: PII } }
    await H["execute.after"](ev)
    const p = ev.result.content.match(/\[PERSON_\d+\]/)?.[0]
    const inst2 = await makeInstance()
    const w: any = { tool: "write", input: { filePath: "/tmp/out.txt", content: `${p} hat angerufen` } }
    await inst2.H["execute.before"](w)
    ok = !!p && w.input.content.includes("Peter Parker")
    note = `${p} -> ${clean(w.input.content)} (nur via Daemon)`
  } else if (mode === "reverse-path") {
    const text = `Bitte Datei ${HOME_DIR}/.config/opencode/opencode.jsonc ansehen`
    const ev: any = { tool: "read", input: { file_path: "/tmp/pii.txt" }, status: "completed", result: { content: text } }
    await H["execute.after"](ev)
    const anonPath = ev.result.content.match(/\/Users\/\S+/)?.[0] ?? ""
    const r: any = { tool: "read", input: { filePath: anonPath } }
    await H["execute.before"](r)
    ok = r.input.filePath === `${HOME_DIR}/.config/opencode/opencode.jsonc`
    note = `Pfad-Arg -> ${r.input.filePath}`
  } else if (mode === "reverse-pathspan") {
    const text = `Kontakt: Datei ${HOME_DIR}/Downloads/x.json bitte oeffnen`
    const ev: any = { tool: "read", input: { file_path: "/tmp/pii.txt" }, status: "completed", result: { content: text } }
    await H["execute.after"](ev)
    const anonPath = ev.result.content.match(/\/Users\/\S+/)?.[0] ?? ""
    const r: any = { tool: "read", input: { filePath: anonPath } }
    await H["execute.before"](r)
    ok = r.input.filePath === `${HOME_DIR}/Downloads/x.json`
    note = `Span-mit-Wort -> ${r.input.filePath}`
  } else {
    throw new Error(`unknown mode ${mode}`)
  }
  return { ok, note }
}

const mode = process.argv[2]
if (mode && !MODES.includes(mode)) {
  console.log(`FAIL: unknown mode ${mode}`)
  process.exit(1)
}

if (mode) {
  const res = await runMode(mode)
  console.log(`${res.ok ? "PASS" : "FAIL"} ${mode} — ${res.note}`)
  process.exit(res.ok ? 0 : 1)
} else {
  let failures = 0
  for (const m of MODES) {
    const res = await runMode(m)
    console.log(`${res.ok ? "PASS" : "FAIL"} ${m} — ${res.note}`)
    if (!res.ok) failures++
  }
  process.exit(failures === 0 ? 0 : 1)
}
PY