import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { scrubWorkerEnv } from './hostWorker'
import type { AnalyzeAgentSuggestion, AnalyzeProjectResult } from '../shared/types'

/** Deep roster analysis of a project via the user's own local Claude Code SUBSCRIPTION (not
 *  an API key) — the flagship of the desktop onboarding wave. Builds a compact prompt from
 *  the project's README + a shallow tree listing, spawns the host `claude` CLI once
 *  (`-p <prompt> --output-format json --max-turns 1`), and parses its answer into a plain
 *  summary + suggested fleet. Everything here is best-effort: on ANY failure (claude not on
 *  PATH, timeout, malformed output) the caller gets {ok:false, reason} — this never throws
 *  and never blocks the wizard, which stays fully usable without it. */

const README_CAP_BYTES = 8 * 1024
const TREE_ENTRY_CAP = 200
const SUMMARY_CAP_CHARS = 600
const TIMEOUT_MS = 90_000
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'vendor'])

export type { AnalyzeAgentSuggestion, AnalyzeProjectResult }

// ---- Pure: README loading (capped) ------------------------------------------------------

/** Read <folder>/README.md (case-sensitive first, then a couple common casings), capped at
 *  README_CAP_BYTES. Returns '' when there's no README — never throws. Pure given the fs
 *  reads passed in via the `read`/`exists` injectables so this stays unit-testable without
 *  a real filesystem. */
export function loadReadme(
  folder: string,
  fsAdapter: { exists: (p: string) => boolean; readFile: (p: string) => string } = {
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8')
  }
): string {
  const candidates = ['README.md', 'Readme.md', 'README.MD', 'readme.md']
  for (const name of candidates) {
    const p = path.join(folder, name)
    if (fsAdapter.exists(p)) {
      try {
        const content = fsAdapter.readFile(p)
        return content.length > README_CAP_BYTES ? content.slice(0, README_CAP_BYTES) : content
      } catch {
        return ''
      }
    }
  }
  return ''
}

// ---- Pure: shallow tree listing (capped, skip noise dirs) --------------------------------

export interface DirLister {
  /** List immediate entries of `dir` as {name, isDirectory}, or [] if unreadable. */
  list: (dir: string) => Array<{ name: string; isDirectory: boolean }>
}

export const nodeDirLister: DirLister = {
  list: (dir) => {
    try {
      return readdirSync(dir).map((name) => {
        let isDirectory = false
        try {
          isDirectory = statSync(path.join(dir, name)).isDirectory()
        } catch {
          isDirectory = false
        }
        return { name, isDirectory }
      })
    } catch {
      return []
    }
  }
}

/** A `ls`-style top-2-level tree listing: every top-level entry, plus one level into each
 *  top-level DIRECTORY, skipping SKIP_DIR_NAMES and dotfiles/dirs other than the ones the
 *  caller explicitly wants (we skip all dotfiles here — noise, not signal, for a project
 *  overview). Capped at TREE_ENTRY_CAP total lines; stops as soon as the cap is hit. Pure
 *  given the injected DirLister. */
export function buildTreeListing(folder: string, lister: DirLister = nodeDirLister): string[] {
  const lines: string[] = []
  const top = lister
    .list(folder)
    .filter((e) => !SKIP_DIR_NAMES.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of top) {
    if (lines.length >= TREE_ENTRY_CAP) break
    lines.push(entry.isDirectory ? `${entry.name}/` : entry.name)
    if (!entry.isDirectory) continue
    const nested = lister
      .list(path.join(folder, entry.name))
      .filter((e) => !SKIP_DIR_NAMES.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const child of nested) {
      if (lines.length >= TREE_ENTRY_CAP) break
      lines.push(`  ${entry.name}/${child.name}${child.isDirectory ? '/' : ''}`)
    }
  }
  return lines.slice(0, TREE_ENTRY_CAP)
}

// ---- Pure: prompt builder -----------------------------------------------------------------

/** The exact instruction/shape contract sent to `claude -p`. Kept as one exported constant
 *  (rather than inlined in buildAnalysisPrompt) so tests — and anyone reading a bug report
 *  that includes the prompt — see precisely what we asked for. */
export const ANALYSIS_INSTRUCTION =
  'Return STRICT JSON only, no markdown fences, no commentary, matching exactly this shape: ' +
  '{"summary": "<=600 chars, plain-language description of what this project is, for a ' +
  'non-engineer">, "agents": [{"alias": "<lowercase single-word>", "role": "<short role>", ' +
  '"focus": "<what they would work on>", "rationale": "<short reason, tied to what you saw>"}, ' +
  '...]}. agents must have between 2 and 5 entries. Do not include an agent named "atlas" or ' +
  'any lead/coordinator role — the lead is implied and handled separately.'

/** Compact prompt from README + tree, capped per the deliverable's spec. Pure — no I/O. */
export function buildAnalysisPrompt(readme: string, treeLines: string[]): string {
  const treeBlock = treeLines.length > 0 ? treeLines.join('\n') : '(empty or unreadable)'
  const readmeBlock = readme.trim() ? readme.trim() : '(no README.md found)'
  return [
    'You are looking at a software project on disk. Here is its README and a shallow directory listing.',
    '',
    '--- README.md (may be truncated) ---',
    readmeBlock,
    '',
    '--- Directory listing (top 2 levels, some noise directories omitted) ---',
    treeBlock,
    '',
    ANALYSIS_INSTRUCTION
  ].join('\n')
}

// ---- Pure: response parsing ----------------------------------------------------------------

/** Strip a ```json ... ``` or ``` ... ``` fence if the model wrapped its JSON in one;
 *  otherwise returns the input unchanged. Pure. */
export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

/** Parse the `claude --output-format json` envelope's result/content text, then parse the
 *  model's own JSON out of THAT (tolerating a markdown fence around it), then validate +
 *  clamp the shape. Returns a failure reason string on any parse/shape problem — never
 *  throws. Pure. */
export function parseAnalysisOutput(rawStdout: string): AnalyzeProjectResult {
  let envelope: unknown
  try {
    envelope = JSON.parse(rawStdout)
  } catch {
    return { ok: false, reason: 'claude did not return valid JSON output' }
  }
  const inner = extractResultText(envelope)
  if (inner === null) {
    return { ok: false, reason: 'claude output JSON had no result/content text field' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripMarkdownFence(inner))
  } catch {
    return { ok: false, reason: 'could not parse JSON out of the model\'s response' }
  }
  return validateAnalysisShape(parsed)
}

/** `claude --output-format json` wraps the answer as {..., result: "<text>"} in the CLI's
 *  documented single-shot JSON mode; some versions/configs instead nest it as
 *  {..., content: "<text>"} or an array of content blocks (matching the Messages API shape).
 *  Try each in order; null if none match a plain string. */
function extractResultText(envelope: unknown): string | null {
  if (typeof envelope !== 'object' || envelope === null) return null
  const obj = envelope as Record<string, unknown>
  if (typeof obj.result === 'string') return obj.result
  if (typeof obj.content === 'string') return obj.content
  if (Array.isArray(obj.content)) {
    const text = obj.content.find(
      (b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string'
    )
    if (text) return text.text
  }
  return null
}

function validateAnalysisShape(parsed: unknown): AnalyzeProjectResult {
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'model JSON was not an object' }
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.summary !== 'string' || !Array.isArray(obj.agents)) {
    return { ok: false, reason: 'model JSON missing summary/agents' }
  }
  const summary = obj.summary.slice(0, SUMMARY_CAP_CHARS)
  const agents: AnalyzeAgentSuggestion[] = []
  for (const raw of obj.agents) {
    if (typeof raw !== 'object' || raw === null) continue
    const a = raw as Record<string, unknown>
    if (typeof a.alias !== 'string' || !a.alias.trim()) continue
    const alias = a.alias.trim().toLowerCase()
    if (alias === 'atlas') continue // the lead is implied — never let the model sneak one in
    agents.push({
      alias,
      role: typeof a.role === 'string' ? a.role : '',
      focus: typeof a.focus === 'string' ? a.focus : '',
      rationale: typeof a.rationale === 'string' ? a.rationale : ''
    })
    if (agents.length >= 5) break
  }
  if (agents.length < 2) {
    return { ok: false, reason: 'model returned fewer than 2 usable agent suggestions' }
  }
  return { ok: true, summary, agents }
}

// ---- Impure: which/spawn ------------------------------------------------------------------

export interface AnalyzeProjectDeps {
  /** Resolve `claude` on the scrubbed host-tool PATH, or null if absent. */
  which: (cmd: string) => Promise<string | null>
  /** Run `claude -p <prompt> --output-format json --max-turns 1` in `folder`, resolving with
   *  raw stdout on a clean exit. Rejects (with .stderr when available) on a non-zero exit,
   *  spawn error, or timeout — the timeout path also kills the child. */
  runClaude: (folder: string, prompt: string) => Promise<string>
}

/** Real deps: PATH-scrubbed (subscription auth — see scrubWorkerEnv) `which`/spawn. `pathEnv`
 *  mirrors hostWorker's own resolution so `claude` is found the same way the worker finds it. */
export function nodeAnalyzeProjectDeps(pathEnv: string): AnalyzeProjectDeps {
  return {
    which: (cmd) =>
      new Promise((resolve) => {
        execFile('/usr/bin/which', [cmd], { env: { ...scrubWorkerEnv(process.env), PATH: pathEnv } }, (err, stdout) =>
          resolve(err ? null : stdout.trim() || null)
        )
      }),
    runClaude: (folder, prompt) =>
      new Promise((resolve, reject) => {
        const child = spawn('claude', ['-p', prompt, '--output-format', 'json', '--max-turns', '1'], {
          cwd: folder,
          env: { ...scrubWorkerEnv(process.env), PATH: pathEnv }
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGKILL')
          reject(Object.assign(new Error('claude analysis timed out'), { stderr, timedOut: true }))
        }, TIMEOUT_MS)
        child.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
        child.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
        child.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(Object.assign(err, { stderr }))
        })
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (code === 0) resolve(stdout)
          else reject(Object.assign(new Error(`claude exited ${code}`), { stderr }))
        })
      })
  }
}

/** Orchestrates the whole analysis: skip entirely (ok:false, no shimmer-worthy attempt) when
 *  `claude` isn't on PATH; otherwise build the prompt from README + tree and run it. Never
 *  throws — every failure mode collapses to {ok:false, reason}. */
export async function analyzeProject(
  folder: string,
  deps: AnalyzeProjectDeps,
  fsAdapter?: { exists: (p: string) => boolean; readFile: (p: string) => string },
  lister?: DirLister
): Promise<AnalyzeProjectResult> {
  try {
    const claudePath = await deps.which('claude')
    if (!claudePath) return { ok: false, reason: 'claude is not installed on this Mac' }

    const readme = loadReadme(folder, fsAdapter)
    const tree = buildTreeListing(folder, lister)
    const prompt = buildAnalysisPrompt(readme, tree)

    const stdout = await deps.runClaude(folder, prompt)
    return parseAnalysisOutput(stdout)
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr
    const message = (err as Error).message ?? String(err)
    return { ok: false, reason: stderr ? `${message}: ${stderr.slice(-400).trim()}` : message }
  }
}
