import { Plugin } from "@opencode/plugin"
import { connect } from "node:net"
import { spawn } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"

// Derive paths from $HOME rather than hard-coding a developer-specific path.
// Environment variables can override them so tests can use an isolated sandbox.
const HOME = homedir()
const ANON = process.env.ANON_BIN ?? `${HOME}/.local/bin/anon`
const SOCK = process.env.ANON_SOCK ?? `${HOME}/.local/share/anonymizer/anon.sock`

// Directories whose content contains no personal data (source code, config).
// Reads/writes touching these skip anonymization so code is never mangled.
const TRUSTED_BUILTIN = [
  "/.local/share/anonymizer/",
  "/.config/opencode/plugins/",
  "/.config/opencode/skills/",
  // Keep the config file readable so its paths are not anonymized.
  "/.config/opencode/anonymizer.json",
]

// The user adds their own exempt folders (own project dirs, notes, …) here:
//   ~/.config/opencode/anonymizer.json  ->  { "trustedPaths": ["~/Projects/my-project"] }
// Re-read whenever the file changes, so adding a folder needs no restart.
// WARNING: everything under a trusted path is passed through UNFILTERED.
const TRUSTED_CONFIG = process.env.ANON_CONFIG ?? `${HOME}/.config/opencode/anonymizer.json`
let trustedCache = { mtime: 0, extra: [] as string[] }

function normalizeTrusted(p: string): string {
  let s = String(p ?? "").trim()
  if (!s) return ""
  if (s.startsWith("~/")) s = HOME + s.slice(1)
  return s.endsWith("/") ? s : s + "/"
}

function trustedPaths(): string[] {
  try {
    const st = statSync(TRUSTED_CONFIG)
    if (st.mtimeMs !== trustedCache.mtime) {
      const raw = JSON.parse(readFileSync(TRUSTED_CONFIG, "utf8")) as { trustedPaths?: unknown }
      const list = Array.isArray(raw?.trustedPaths) ? raw.trustedPaths : []
      trustedCache = { mtime: st.mtimeMs, extra: list.map(normalizeTrusted).filter(Boolean) }
    }
  } catch {
    // Missing or invalid config: clear the cache (fail closed) so a stale
    // allowlist cannot remain active until the next restart.
    trustedCache = { mtime: 0, extra: [] }
  }
  return [...TRUSTED_BUILTIN, ...trustedCache.extra]
}

// These files are never trusted, no matter how broadly the user extends the
// allowlist. They include credentials, conversation history, and state.json,
// which contains the complete placeholder-to-original mapping.
const NEVER_TRUSTED = [
  "/.local/share/anonymizer/state.json",
  "/.local/share/anonymizer/anon.sock",
  "/.local/share/opencode/storage/",
  "/.local/share/opencode/session/",
  "/.local/share/opencode/log/",
  "/.local/share/opencode/shell/",
  "/.local/share/opencode/tool-output/",
  "/.local/share/opencode/snapshot/",
  "/.local/share/opencode/opencode.db",
  "/.config/opencode/service",
  "/.config/opencode/auth",
  "/.config/opencode/cli.json",
]

// Tools whose INPUT may carry placeholders that must be resolved back to
// originals before execution (write path: agent works with [PERSON_1], disk
// gets "Anna Mueller").
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch", "notebookedit"])

// Trust is an ALLOWLIST: only these file tools may skip filtering, and only for
// the directories below. Everything else -- including shell tools whose real
// name is "shell" (not "bash"!) and every MCP tool -- is filtered. Fail-closed
// beats guessing tool names: the runtime can and does rename tools.
const FILE_TOOLS = new Set(["read", "write", "edit", "multiedit", "patch", "notebookedit"])

// Overrides (see SKILL.md):
//   [[ANON:OFF]]    -> anonymization off for this request; it STAYS off until the
//                      next user message arrives that carries no marker (a plain
//                      message re-arms it -- no [[ANON:ON]] needed).
//   [[ANON:ON]]     -> switch back explicitly, also within the same message.
//   [[ANON:FORCED]] -> force filtering on trusted paths, this request only.
//   [[ANON:S-OFF]]  -> raw output for exactly ONE tool result, then normal again.
//   [[ANON:S-FORCE]]-> force filtering for exactly ONE tool result.
// All of them work with single OR double brackets ([ANON:OFF] and [[ANON:OFF]]).
// The S-markers stay in the chat text on purpose -- the user should be able to
// see that they typed one. The others are extracted before the model sees them.
// Plain booleans/counters, no token budget: a budget erodes after ~20 tool
// results and silently re-arms filtering in the middle of a long task.
// Marker states. `strip` means remove the marker before the model sees it.
// Only single brackets activate markers. Double brackets are escaped literal
// text: they remain visible (and collapse to one bracket pair) without effect.
// The negative lookbehind prevents matching inside `[[...]]`.
const MARKERS: Array<{ re: RegExp; strip: boolean }> = [
  { re: /(?<!\[)\[ANON:S-OFF\](?!\])/g, strip: false }, // Keep exactly one tool result raw.
  { re: /(?<!\[)\[ANON:S-FORCE\](?!\])/g, strip: false }, // Filter exactly one tool result.
  { re: /(?<!\[)\[ANON:RAW\](?!\])/g, strip: false }, // Make blocked paths readable.
  { re: /(?<!\[)\[ANON:OFF\](?!\])/g, strip: true },
  { re: /(?<!\[)\[ANON:ON\](?!\])/g, strip: true },
  { re: /(?<!\[)\[ANON:FORCE(D)?\](?!\])/g, strip: true },
]

let anonOff = false // sticky user switch: no filtering until the next marker-less message
let rawPaths = false // [ANON:RAW]: only blocked paths are readable.
let forceTokens = 0 // consume one per tool event -> anonymize even trusted paths
let singleOff = 0 // [[ANON:S-OFF]]: raw for this many upcoming tool results
let singleForce = 0 // [[ANON:S-FORCE]]: filter for this many upcoming tool results

// TUI client (progress toasts). Set in setup(); headless runs simply have no
// TUI -- every call is guarded.
let tui: any = null

function toast(
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
  title = "Anonymizer",
  duration = 1400,
): void {
  try {
    const p = tui?.tui?.showToast?.({ body: { title, message, variant, duration } })
    if (p && typeof p.catch === "function") p.catch(() => {})
  } catch {
    /* No TUI (headless mode): do nothing. */
  }
}

// placeholder -> original, filled from every daemon response.
const mapping = new Map<string, string>()

function stringifyInput(input: unknown): string {
  try {
    return typeof input === "string" ? input : JSON.stringify(input) ?? ""
  } catch {
    return ""
  }
}

/** "trusted" -> file tool under an allowlisted path -> raw
 *  "denied"  -> file tool on the denylist -> raw only with [ANON:RAW]
 *  "normal"  -> everything else (shell, MCP, other paths) -> always filter */
function pathDecision(tool: string, input: unknown): "trusted" | "denied" | "normal" {
  if (!FILE_TOOLS.has(tool)) return "normal" // Never exempt shell or MCP tools.
  const s = stringifyInput(input)
  if (!s) return "normal"
  // Block path traversal so `..` segments cannot bypass the allowlist.
  if (/(^|\/|\\)\.\.(\/|\\|$)/.test(s)) return "denied"
  if (NEVER_TRUSTED.some((p) => s.includes(p))) return "denied"
  if (trustedPaths().some((p) => s.includes(p))) return "trusted"
  return "normal"
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function tryConnect(timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(SOCK)
    const done = (ok: boolean) => {
      s.removeAllListeners()
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.on("connect", () => done(true))
    s.on("error", () => done(false))
  })
}

async function ensureDaemon(): Promise<boolean> {
  if (await tryConnect()) return true
  try {
    const child = spawn(ANON, ["--serve"], { detached: true, stdio: "ignore" })
    child.unref()
  } catch {
    return false
  }
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    if (await tryConnect()) return true
  }
  return false
}

interface DaemonResp {
  ok?: boolean
  text?: string
  replacements?: Array<{ placeholder: string; original: string }>
  map?: Record<string, string>
  error?: string
}

/** Newline-delimited JSON over the Unix socket. null = daemon unreachable. */
function send(payload: unknown, timeoutMs = 240_000): Promise<DaemonResp | null> {
  return new Promise((resolve) => {
    const s = connect(SOCK)
    let buf = ""
    const finish = (v: DaemonResp | null) => {
      s.removeAllListeners()
      s.destroy()
      resolve(v)
    }
    s.setTimeout(timeoutMs, () => finish(null))
    s.on("error", () => finish(null))
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const nl = buf.indexOf("\n")
      if (nl === -1) return
      try {
        finish(JSON.parse(buf.slice(0, nl)))
      } catch {
        finish(null)
      }
    })
    s.on("connect", () => {
      s.write(JSON.stringify(payload) + "\n")
    })
  })
}

/** Like send(), but tolerates progress lines before the final answer:
 *  {"p":done,"n":total} ... {"ok":true,...}. Long runs then show progress
 *  instead of looking like a hang. */
function requestStreaming(
  text: string,
  onProgress?: (done: number, total: number) => void,
  timeoutMs = 240_000,
): Promise<DaemonResp | null> {
  return new Promise((resolve) => {
    const s = connect(SOCK)
    let buf = ""
    let final: DaemonResp | null = null
    const finish = () => {
      s.removeAllListeners()
      s.destroy()
      resolve(final)
    }
    s.setTimeout(timeoutMs, finish)
    s.on("error", finish)
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      for (;;) {
        const nl = buf.indexOf("\n")
        if (nl === -1) return
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (obj && typeof obj.p === "number") onProgress?.(obj.p, obj.n ?? 0)
          else if (obj && typeof obj.ok === "boolean") {
            final = obj
            finish()
            return
          }
        } catch {
          /* unvollstaendige Zeile verwerfen */
        }
      }
    })
    s.on("connect", () => {
      s.write(JSON.stringify({ text, opts: {}, progress: !!onProgress }) + "\n")
    })
  })
}

/** Ask the daemon for its placeholder -> original table. Needed after a plugin
 *  reload (in-memory map empty) and for placeholders minted in an earlier
 *  session: without it a model that saw "/Users/[USERNAME_1]/..." could not
 *  write/edit that file ("File not found"). */
async function syncMapping(tags: string[]): Promise<void> {
  const missing = [...new Set(tags)].filter((t) => !mapping.has(t))
  if (!missing.length) return
  const resp = await send({ resolve: missing })
  if (!resp?.ok || !resp.map) return
  for (const [k, v] of Object.entries(resp.map)) {
    if (typeof v === "string" && v) mapping.set(k, v)
  }
}

/** Anonymize text via the daemon (warm GLiNER, persistent numbering).
 *  Fails closed: raw text never passes through.
 *
 *  Long runs are announced in the TUI. NER on a big file takes ~25 s; without
 *  any feedback that looks like the request is doing nothing, so from ~700 ms
 *  on a progress toast appears and is refreshed (throttled) until it is done. */
async function anonymize(text: string): Promise<string> {
  if (!text) return text
  const t0 = Date.now()
  const big = text.length > 20_000
  let shown = false
  let lastAt = 0
  const armTimer = setTimeout(() => {
    shown = true
    lastAt = Date.now()
    toast(big ? "Analyzing large text…" : "Anonymizing…", "info")
  }, 700)

  const resp = await requestStreaming(text, (done, total) => {
    const now = Date.now()
    if (!shown) {
      // Show the first progress value only after the delay, to avoid flicker
      // for small outputs.
      if (now - t0 < 700) return
      shown = true
      lastAt = now
      toast("Anonymizing…", "info")
      return
    }
    if (now - lastAt < 900) return // Avoid flicker.
    lastAt = now
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
    toast(`${done}/${total} sections · ${pct} %`, "info")
  })
  clearTimeout(armTimer)

  if (!resp || !resp.ok || typeof resp.text !== "string") return "[ANON_ERROR]"
  for (const r of resp.replacements ?? []) {
    if (!r.placeholder || !r.original) continue
    // Longest original wins: alias entries (short form "Anna") must not
    // overwrite the full name ("Anna Mueller") used on the write path.
    const prev = mapping.get(r.placeholder)
    if (prev === undefined || r.original.length > prev.length) {
      mapping.set(r.placeholder, r.original)
    }
  }
  const secs = (Date.now() - t0) / 1000
  if (secs > 2) {
    const n = (resp.replacements ?? []).length
    toast(`${n} matches in ${secs.toFixed(1)} s`, "success")
  }
  return resp.text
}

/** Resolve placeholders back to originals (write path). Unknown placeholders
 *  are looked up at the daemon (survives plugin reload / daemon restart).
 *  Natural for swaps: each tag resolves independently, so exchanging
 *  [PERSON_1]/[PERSON_2] in content swaps the real names on disk.
 *  Escape for LITERAL placeholder text (docs/examples): write [[PERSON_1]] ->
 *  stays "[PERSON_1]" on disk, never resolved. */
async function reverseMap(text: string): Promise<string> {
  const OPEN = "\x00L\x00"
  const CLOSE = "\x00T\x00"
  // Escapes ALWAYS collapse (even with an empty mapping after a reload);
  // only resolution depends on the mapping.
  let out = text.replace(/\[\[([A-Z][A-Z_]*_\d+)\]\]/g, `${OPEN}$1${CLOSE}`)
  const wanted = [...out.matchAll(/\[([A-Z][A-Z_]*_\d+)\]/g)].map((m) => m[0])
  if (wanted.length) await syncMapping(wanted)
  if (mapping.size) {
    out = out.replace(/\[([A-Z][A-Z_]*_\d+)\]/g, (m) => mapping.get(m) ?? m)
  }
  return out.replace(new RegExp(`${OPEN}([A-Z][A-Z_]*_\\d+)${CLOSE}`, "g"), "[$1]")
}

/** Resolve a path-shaped argument. The model only ever knows the tag, so the
 *  mapped value must be a usable path. GLiNER sometimes spans a word in front
 *  of the path ("File /home/example/y.json" -> [URL_2]); mapped back verbatim that
 *  would be an invalid path -> "File not found". In that case take the path
 *  part only.
 *  Careful: only when the result does NOT start with "/". A resolved name may
 *  legitimately contain a space ("Peter Parker"), and so may a filename --
 *  truncating at the first space produced "/tmp/Peter" from
 *  "/tmp/Peter Parker.txt". */
async function resolvePathArg(text: string): Promise<string> {
  const out = await reverseMap(text)
  if (out.startsWith("/")) return out // Already a path; leave it unchanged.
  // If the detected span included a leading word, keep the path from the first
  // slash onward. Paths may contain spaces, so do not split on whitespace.
  const idx = out.indexOf("/")
  if (idx > 0) return out.slice(idx)
  return out
}

/** Recursively reverse-map every string in a tool input object. */
async function reverseMapDeep(value: unknown, key?: string): Promise<unknown> {
  if (typeof value === "string") {
    return key && /path$/i.test(key) ? await resolvePathArg(value) : await reverseMap(value)
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await reverseMapDeep(item))
    return out
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await reverseMapDeep(v, k)
    }
    return out
  }
  return value
}

/** Anonymize a Tool.Result's content in place (string or Content[] form). */
async function anonymizeResult(result: { content?: unknown }): Promise<void> {
  const c = result.content
  if (typeof c === "string") {
    ;(result as { content?: unknown }).content = await anonymize(c)
  } else if (Array.isArray(c)) {
    for (let i = 0; i < c.length; i++) {
      const part = c[i] as { type?: string; text?: string }
      if (part && part.type === "text" && typeof part.text === "string") {
        c[i] = { ...part, text: await anonymize(part.text) }
      }
    }
  }
}

export default Plugin.define({
  id: "anonymizer",
  async setup(ctx) {
    tui = ctx.client
    // Warm daemon up front (GLiNER ~8s cold, ~80ms warm afterwards).
    void ensureDaemon()

    // 1. The user's own chat input stays RAW — also with [[ANON:FORCED]]:
    //    forcing targets TOOL paths/outputs (trusted-path exemption), never
    //    the typed prompt, because anonymizing it corrupts file paths in it.
    //    [[ANON:OFF]]    -> bypass tool filtering for exactly this request.
    await ctx.session.hook("prompt", (event) => {
      let text: string | undefined = event.prompt?.text
      // Re-evaluate state for every user request: reset first, then apply its
      // markers. A message without markers re-enables filtering, and one-shot
      // markers expire so no unmonitored raw-data window remains open.
      if (anonOff) toast("Anonymization re-enabled (no marker)", "success")
      anonOff = false
      rawPaths = false
      forceTokens = 0
      singleOff = 0
      singleForce = 0
      if (!text || !event.prompt) return
      // 1) Evaluate markers (single-bracket forms only).
      const originalText = text
      for (const m of MARKERS) {
        const hits = text.match(m.re)
        if (!hits) continue
        const label = hits[0].replace(/\[\[?|\]\]?/g, "").toUpperCase()
        if (m.strip) text = text.replace(m.re, "").trimStart()
        if (label === "ANON:S-OFF") {
          singleOff += hits.length
          toast(`S-OFF: next ${hits.length} tool result(s) raw`, "warning")
        } else if (label === "ANON:S-FORCE") {
          singleForce += hits.length
        } else if (label === "ANON:RAW") {
          rawPaths = true
          toast("Blocked paths readable (this request only)", "warning", "Anonymizer", 6000)
        } else if (label === "ANON:OFF") {
          anonOff = true
        } else if (label === "ANON:ON") {
          anonOff = false
          toast("Anonymization re-enabled", "success")
        } else if (label === "ANON:FORCE" || label === "ANON:FORCED") {
          forceTokens += hits.length
        }
      }
      // 2) Warn about unknown markers. Check the original text after removing
      //    known forms so visible S-markers are not reported as unknown. The
      //    Form verlangt ein sauberes ']' -- "/[/[ANON:S-FORCE/]/]" ist Absicht
      //    closing-bracket check leaves intentionally malformed text untouched.
      let scan = originalText
      for (const m of MARKERS) scan = scan.replace(m.re, " ")
      const unknown = scan.match(/(?<!\[)\[ANON:[A-Z][A-Z:-]*\](?!\])/g)
      if (unknown?.length) {
        toast(
          `Unknown marker ${unknown[0]} — possible: [[ANON:OFF]], [[ANON:ON]], [[ANON:FORCED]], [[ANON:S-OFF]], [[ANON:S-FORCE]] or [[ANON:RAW]]`,
          "warning",
          "Anonymizer",
          7000,
        )
      }
      // 3) Collapse escaped brackets: [[PERSON_1]] -> [PERSON_1] and
      //    [[ANON:OFF]] -> [ANON:OFF]. The marker is consumed for this request
      //    while remaining visible. To write double-bracket text literally,
      //    use [[[PERSON_1]]].
      text = text.replace(/\[\[([A-Z][A-Z0-9_:-]*)\]\]/g, "[$1]")
      if (anonOff) {
        toast("Anonymization is OFF — ends with the next marker-less message", "warning", "Anonymizer", 5000)
      }
      event.prompt.text = text
    })

    // 2a. Reverse-map placeholders -> originals in WRITE inputs, and in bash
    //     commands (e.g. `grep "[PERSON_1]" file`). The model never sees raw
    //     PII; only the actual operation uses it.
    //     NOTE: this runs even with [[ANON:OFF]] -- the model may still use
    //     placeholders it saw earlier, and an unresolved tag in a path would
    //     mean "File not found: /Users/[USERNAME_1]/...". Resolving a tag only
    //     ever helps the filesystem call; it does not leak anything to the model.
    await ctx.tool.hook("execute.before", async (event) => {
      const input = event.input as Record<string, unknown> | undefined
      if (!input) return
      // 1) Resolve path arguments for all tools. The agent may see paths in
      //    anonymized output (directory listings, errors, etc.) and must be able
      //    to open them with read/edit/shell.
      for (const k of Object.keys(input)) {
        if (/path$/i.test(k) && typeof input[k] === "string") {
          input[k] = await resolvePathArg(input[k] as string)
        }
      }
      // 2) For write tools, also reverse-map the content (swaps and escapes).
      if (WRITE_TOOLS.has(event.tool)) {
        event.input = (await reverseMapDeep(input)) as typeof event.input
      } else if (!FILE_TOOLS.has(event.tool) && typeof input.command === "string") {
        // Shell tools may have different names ("bash", "shell", "terminal");
        // reverse-map any input that has a command field.
        input.command = await reverseMap(input.command)
      }
    })

    // 2b. Anonymize every successful tool result (read, shell, browser, ...)
    //     before it reaches the model. This is the main PII leak path.
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed" || !event.result) return
      // Priority order:
      //   1) Global filtering is off -> leave everything raw.
      //   2) [ANON:S-OFF] -> leave this one result raw.
      //   3) [ANON:S-FORCE] / FORCED -> filter even trusted paths.
      //   4) Trusted path -> leave raw.
      if (anonOff) return
      if (singleOff > 0) {
        singleOff--
        return
      }
      if (singleForce > 0) {
        singleForce--
        await anonymizeResult(event.result as { content?: unknown })
        return
      }
      const decision = pathDecision(event.tool, event.input)
      // Denied files (credentials, logs, sessions, state.json) are readable
      // only with [ANON:RAW]. All other content remains filtered.
      if (decision === "denied" && rawPaths) return
      if (decision === "trusted") {
        if (forceTokens > 0) forceTokens--
        else return
      }
      await anonymizeResult(event.result as { content?: unknown })
    })

    console.log("[anonymizer] prompt + tool hooks registered (daemon mode)")
  },
})
