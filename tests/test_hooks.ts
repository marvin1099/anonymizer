// Unit test for the anonymizer plugin hooks (mocked ctx, real daemon).
// Usage: bun test_hooks.ts <mode>
// Prints only PASS/FAIL + placeholder snippets — never raw PII.
import def0 from "/Users/example-user/.config/opencode/plugins/anonymizer/dist/index.js"

const PII =
  "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 170 1234567, IBAN DE89 3704 0044 0532 0130 00."

const H: Record<string, (e: any) => Promise<void> | void> = {}
const ctx: any = {
  session: { hook: async (n: string, f: any) => { H[n] = f } },
  tool: { hook: async (n: string, f: any) => { H[n] = f } },
}

const d: any = (def0 as any)?.default ?? def0
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
const ph = (s: string) => (s.match(/\[[A-Z][A-Z_]*_\d+\]/g) ?? []).slice(0, 4).join(" ")
const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 90)

const mode = process.argv[2]
let ok = false
let note = ""

if (mode === "strip-off") {
  // Marker must be removed, prompt itself raw (default).
  const t = await prompt(`[ANON:OFF] ${PII}`)
  ok = !t.includes("[ANON:") && t.includes("Peter Parker")
  note = clean(t)
} else if (mode === "strip-forced") {
  // Marker removed; prompt itself STAYS raw (forcing targets tool paths,
  // never the typed prompt — anonymizing it would corrupt file paths).
  const t = await prompt(`[ANON:FORCED] ${PII}`)
  ok = !t.includes("[ANON:") && t.includes("Peter Parker")
  note = clean(t)
} else if (mode === "base-untrusted") {
  // Default: untrusted tool output anonymized.
  const out = await after("read", { file_path: "/tmp/pii.txt" }, PII)
  ok = out !== PII && !out.includes("peter.parker@example.com")
  note = clean(out)
} else if (mode === "base-trusted") {
  // Default: trusted path stays raw.
  const out = await after("read", { file_path: "/Users/example-user/.local/share/anonymizer/x.txt" }, PII)
  ok = out === PII
  note = "trusted -> roh"
} else if (mode === "forced-trusted") {
  // FORCED overrides trusted exemption -> anonymized.
  await prompt("[ANON:FORCED] test")
  const out = await after("read", { file_path: "/Users/example-user/.local/share/anonymizer/x.txt" }, PII)
  ok = out !== PII && !out.includes("peter.parker@example.com")
  note = clean(out)
} else if (mode === "off") {
  // OFF bypasses tool-output filtering (the main leak path).
  await prompt("[ANON:OFF] test")
  const out = await after("read", { file_path: "/tmp/pii.txt" }, PII)
  ok = out === PII
  note = "OFF -> roh"
} else if (mode === "reverse") {
  // Bash command with placeholder gets reverse-mapped (write path).
  const anon = await after("read", { file_path: "/tmp/pii.txt" }, PII)
  const p = anon.match(/\[PERSON_\d+\]/)?.[0]
  const inp: any = await before("bash", { command: `grep "${p}" /tmp/pii.txt` })
  ok = !!p && inp.command.includes("Peter Parker")
  note = `${p} -> ${clean(inp.command)}`
} else if (mode === "reverse-off") {
  // OFF suppresses output filtering, but placeholders in tool INPUTS are still
  // resolved: the model may use a tag it saw earlier, and an unresolved tag in
  // a command or path would fail ("File not found: /Users/[USERNAME_1]/...").
  const anon = await after("read", { file_path: "/tmp/pii.txt" }, PII)
  const p = anon.match(/\[PERSON_\d+\]/)?.[0]
  await prompt("[ANON:OFF] test")
  const inp: any = await before("bash", { command: `grep "${p}" /tmp/pii.txt` })
  const outOff = await after("read", { file_path: "/tmp/pii.txt" }, PII)
  ok = !!p && inp.command.includes("Peter Parker") && outOff === PII
  note = `Input aufgeloest (${clean(inp.command)}), Output roh trotz OFF`
} else if (mode === "reverse-stale") {
  // Plugin-Reload: zweite, frisch geladene Instanz mit LEERER In-Memory-Map
  // bekommt einen Tag, den eine fruehere Instanz vergeben hat. Aufloesen muss
  // ueber den Daemon gelingen (sonst "File not found: /Users/[PERSON_9]/...").
  const ev: any = { tool: "read", input: { file_path: "/tmp/pii.txt" }, status: "completed", result: { content: PII } }
  await H["execute.after"](ev)
  const p = ev.result.content.match(/\[PERSON_\d+\]/)?.[0]
  const fresh: any = await import("/Users/example-user/.config/opencode/plugins/anonymizer/dist/index.js?reload=1")
  const d2: any = (fresh as any)?.default ?? fresh
  const H2: Record<string, (e: any) => Promise<void>> = {}
  const ctx2: any = {
    session: { hook: async (n: string, f: any) => { H2[n] = f } },
    tool: { hook: async (n: string, f: any) => { H2[n] = f } },
  }
  await (d2.setup ?? d2.default.setup)(ctx2)
  const w: any = { tool: "write", input: { filePath: "/tmp/out.txt", content: `${p} hat angerufen` } }
  await H2["execute.before"](w)
  ok = !!p && w.input.content.includes("Peter Parker")
  note = `${p} -> ${clean(w.input.content)} (nur via Daemon)`
} else if (mode === "reverse-path") {
  // Pfad-Argument bei read: Agent sieht Pfade aus anonymisierter Ausgabe.
  const text = "Bitte Datei /Users/example-user/.config/opencode/opencode.jsonc ansehen"
  const ev: any = { tool: "read", input: { file_path: "/tmp/pii.txt" }, status: "completed", result: { content: text } }
  await H["execute.after"](ev)
  const anonPath = ev.result.content.match(/\/Users\/\S+/)?.[0] ?? ""
  const r: any = { tool: "read", input: { filePath: anonPath } }
  await H["execute.before"](r)
  ok = r.input.filePath === "/Users/example-user/.config/opencode/opencode.jsonc"
  note = `Pfad-Arg -> ${r.input.filePath}`
} else if (mode === "reverse-pathspan") {
  // GLiNER spannt manchmal ein Wort mit vor den Pfad ("Datei /Users/x.json"
  // -> Datei /Users/example-user/y.json). Aufgeloest muss ein BENUTZBARER Pfad herauskommen.
  const text = "Kontakt: Datei /Users/example-user/Downloads/x.json bitte oeffnen"
  const ev: any = { tool: "read", input: { file_path: "/tmp/pii.txt" }, status: "completed", result: { content: text } }
  await H["execute.after"](ev)
  const anonPath = ev.result.content.match(/\/Users\/\S+/)?.[0] ?? ""
  const r: any = { tool: "read", input: { filePath: anonPath } }
  await H["execute.before"](r)
  ok = r.input.filePath === "/Users/example-user/Downloads/x.json"
  note = `Span-mit-Wort -> ${r.input.filePath}`
} else {
  console.log(`FAIL: unknown mode ${mode}`)
  process.exit(1)
}

console.log(`${ok ? "PASS" : "FAIL"} ${mode} — ${note}`)
process.exit(ok ? 0 : 1)
