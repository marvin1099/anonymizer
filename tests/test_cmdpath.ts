// Command paths resolve [TAG] while keeping [[TAG]] literal. Also test
// different shell tool names ("shell", "bash", and others).
// Run with: bun test_cmdpath.ts
import { PLUGIN_DIST } from "./helpers"
const def0: any = await import(PLUGIN_DIST)

const PII = "Peter Parker aus Berlin, peter.parker@example.com, Telefon +49 30 23125 0."

let seq = 0
async function fresh() {
  const mod: any = await import(
    `${PLUGIN_DIST}?case=` + ++seq
  )
  const d: any = (mod as any)?.default ?? mod
  const H: Record<string, (e: any) => Promise<void> | void> = {}
  const ctx: any = {
    client: { tui: { showToast: () => Promise.resolve(true) } },
    session: { hook: async (n: string, f: any) => { H[n] = f } },
    tool: { hook: async (n: string, f: any) => { H[n] = f } },
  }
  await (d.setup ?? d.default.setup)(ctx)
  return {
    after: async (content: string) => {
      const ev: any = { tool: "read", input: { file_path: "/tmp/x" }, status: "completed", result: { content } }
      await H["execute.after"](ev)
      return ev.result.content as string
    },
    before: async (tool: string, input: any) => {
      const ev: any = { tool, input }
      await H["execute.before"](ev)
      return ev.input
    },
  }
}

let failures = 0
const check = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  -> " + info : ""}`)
  if (!ok) failures++
}
const S = String.fromCharCode(91)
const C = String.fromCharCode(93)
// Tags already include brackets. Use the bare name to make a double-bracket
// escape, otherwise the test would produce triple brackets.
const bare = (t: string) => t.slice(1, -1)
const dbl = (t: string) => S + S + bare(t) + C + C // [[TAG]]

// Get a tag from an actual anonymization result.
const p = await fresh()
const anon = await p.after(PII)
const tag = anon.match(/\[PERSON_\d+\]/)?.[0] ?? ""
const emailTag = anon.match(/\[EMAIL_\d+\]/)?.[0] ?? ""
check("tag created", !!tag, `${tag} / ${emailTag}`)

// 1) Resolve [TAG] to the original.
for (const tool of ["shell", "bash", "run_command"]) {
  const inp = await p.before(tool, { command: `grep "${tag}" /tmp/pii.txt` })
  check(`[TAG] resolved (${tool})`, inp.command.includes("Peter Parker"), inp.command)
}

// 2) Keep [[TAG]] literal; do not resolve it.
for (const tool of ["shell", "bash"]) {
  const inp = await p.before(tool, { command: `grep "${dbl(tag)}" /tmp/pii.txt` })
  check(`[[TAG]] stays literal (${tool})`, inp.command.includes(tag) && !inp.command.includes("Peter Parker"), inp.command)
}

// 3) Resolve multiple tags in one command.
{
  const inp = await p.before("shell", {
    command: `grep -c "${tag}" file.txt && grep -o "${emailTag}" file.txt`,
  })
  check(
    "two tags in same command",
    inp.command.includes("Peter Parker") && inp.command.includes("peter.parker@example.com"),
    inp.command,
  )
}

// 4) Keep one tag literal and resolve another in the same command.
{
  const inp = await p.before("shell", {
    command: `echo "${tag}" "${dbl(tag)}"`,
  })
  check("mixed: one resolved and one literal", inp.command === `echo "Peter Parker" "${tag}"`, "")
}

// 5) Resolve a path argument and keep a placeholder filename literal.
{
  const inp = await p.before("shell", { command: `cat "/tmp/${dbl(tag)}.txt"` })
  const inp2 = await p.before("read", { filePath: `/tmp/${tag}.txt` })
  check("filename from [[TAG]] stays literal", inp.command === `cat "/tmp/${tag}.txt"`, "")
  check("path argument resolves [TAG]", inp2.filePath === "/tmp/Peter Parker.txt", "")
}

// 6) A command without tags stays unchanged.
{
  const inp = await p.before("shell", { command: "ls -la /tmp | head -20" })
  check("command without tag unchanged", inp.command === "ls -la /tmp | head -20", inp.command)
}

console.log(failures === 0 ? "\n== COMMAND PATH CONFIRMED ==" : `\n== ${failures} FAILURES ==`)
process.exit(failures === 0 ? 0 : 1)
