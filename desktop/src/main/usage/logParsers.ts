/** Line parsers for the agents' own local session logs — READ-ONLY inputs:
 *
 *  - Claude Code: `~/.claude/projects/<project>/<session>.jsonl`. One JSON object per line;
 *    `type: "assistant"` lines carry `message.{id, model, usage}` + `requestId`; a streamed
 *    response is written as SEVERAL lines sharing `message.id`+`requestId` whose later copies
 *    can carry a larger `output_tokens`, so each key is counted once at the MAX of every field
 *    (Orca's rule). `type: "user"` lines that are a person's prompt (not a tool result, not a
 *    meta/sidechain line) are turns.
 *  - Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. `turn_context.payload.model`
 *    (or `thread_settings_applied.thread_settings.model`) sets the model; `task_started`
 *    (older CLIs: `user_message`) marks a turn; `event_msg` / `token_count` carries `info.total_token_usage` (cumulative
 *    per session) and `info.last_token_usage`, plus `rate_limits` (the subscription windows).
 *    `cached_input_tokens` is a SUBSET of `input_tokens`; `reasoning_output_tokens` a subset
 *    of `output_tokens` (total_tokens = input + output). Deltas come from the cumulative total
 *    (a repeated total counts nothing; a total that goes backwards starts a new baseline and
 *    counts `last_token_usage`).
 *
 *  Adapted from Orca's usage scanner (github.com/stablyai/orca, MIT © Lovecast Inc.:
 *  usage-scan-worker — dedup key, max-merge, cumulative→delta, long-context tagging).
 *
 *  Everything here is pure: state lives in plain serialisable objects so the incremental
 *  cache (scanner.ts) can persist it and resume a file where it stopped. */

import { localDay } from '../../shared/usage'

/** Bucket vector: [input(new), output, cacheRead, cacheWrite, reasoning, cacheWrite1h, events]. */
export type Vec = number[]
export const VEC_LEN = 7

/** Per-file aggregate. Bucket keys are `${YYYY-MM-DD}\t${modelKey}`. */
export interface FileAgg {
  b: Record<string, Vec>
  turns: number
  prs: number
  sessions: string[]
  first: number | null
  last: number | null
  /** Sum of gaps between consecutive usage events ≤ ACTIVE_GAP_MS. */
  activeMs: number
  lastTs: number | null
}

export function emptyAgg(): FileAgg {
  return { b: {}, turns: 0, prs: 0, sessions: [], first: null, last: null, activeMs: 0, lastTs: null }
}

/** Gaps longer than this between an agent's events are idle time, not work. */
export const ACTIVE_GAP_MS = 5 * 60_000
/** Codex prices input above this per-response size at long-context rates (Orca/OpenAI). */
export const CODEX_LONG_INPUT = 272_000
/** Sonnet 4 / 4.5 price requests above 200K input at the long-context tier. */
export const CLAUDE_LONG_INPUT = 200_000
const CLAUDE_LONG_MODELS = /^claude-sonnet-4(?:-5)?(?:$|-\d{8})/

/** Model key suffix for responses billed at long-context rates (pricing.ts reads it). */
export const LONG_SUFFIX = '#long'

/** A `gh pr create` in an agent's shell command. */
export const PR_CREATE_RE = /\bgh\s+pr\s+create\b/

/** 53-bit FNV-1a → base36: compact dedup keys (collisions are negligible at our scale). */
export function hashKey(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return (h1 * 0x200000 + (h2 & 0x1fffff)).toString(36)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function tsOf(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const t = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(t) ? t : null
}

function addVec(agg: FileAgg, day: string, model: string, v: Vec): void {
  const k = `${day}\t${model}`
  const cur = agg.b[k] ?? (agg.b[k] = new Array<number>(VEC_LEN).fill(0))
  for (let i = 0; i < VEC_LEN; i++) cur[i] += v[i]
}

function touch(agg: FileAgg, ts: number): void {
  if (agg.first === null || ts < agg.first) agg.first = ts
  if (agg.last === null || ts > agg.last) agg.last = ts
  if (agg.lastTs !== null) {
    const gap = ts - agg.lastTs
    if (gap > 0 && gap <= ACTIVE_GAP_MS) agg.activeMs += gap
  }
  if (agg.lastTs === null || ts > agg.lastTs) agg.lastTs = ts
}

function addSession(agg: FileAgg, id: unknown): void {
  if (typeof id === 'string' && id && id.length <= 128 && !agg.sessions.includes(id)) agg.sessions.push(id)
}

/** Cross-file dedup: keys claimed by any file (the first file to claim a key owns it). */
export interface SeenKeys {
  has(k: string): boolean
  add(k: string): void
}

// ---------------------------------------------------------------------------------------
// Claude Code

/** Keys still open for max-merge (a streamed response's later lines), newest last. */
export interface ClaudeState {
  open: { k: string; day: string; model: string; v: Vec }[]
}
export const CLAUDE_OPEN_MAX = 64

export function emptyClaudeState(): ClaudeState {
  return { open: [] }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** True when a user line is a person's prompt (not a tool result / meta / sidechain). */
function isHumanPrompt(o: Record<string, unknown>): boolean {
  if (o.isMeta === true || o.isSidechain === true || o.isCompactSummary === true) return false
  const msg = o.message
  if (!isRecord(msg)) return false
  const c = msg.content
  if (typeof c === 'string') return c.trim().length > 0 && !c.startsWith('<command-') && !c.startsWith('<local-command')
  if (Array.isArray(c)) {
    let text = false
    for (const block of c) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_result') return false
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) text = true
    }
    return text
  }
  return false
}

/** Feed one Claude Code log line. `own` collects the keys this file claimed. */
export function claudeLine(line: string, agg: FileAgg, st: ClaudeState, seen: SeenKeys, own: string[]): void {
  // Cheap pre-filter: most lines are tool results / progress, never JSON-parse those.
  const isAssistant = line.includes('"type":"assistant"')
  const isUser = !isAssistant && line.includes('"type":"user"') && !line.includes('"tool_result"')
  if (!isAssistant && !isUser) return
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  if (!isRecord(o)) return
  const ts = tsOf(o.timestamp)
  if (o.type === 'user') {
    if (isHumanPrompt(o)) {
      agg.turns++
      addSession(agg, o.sessionId)
    }
    return
  }
  if (o.type !== 'assistant' || ts === null) return
  const msg = o.message
  if (!isRecord(msg)) return
  // PRs the agent opened: a Bash tool call running `gh pr create` (counted once per tool id).
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!isRecord(block) || block.type !== 'tool_use' || block.name !== 'Bash' || !isRecord(block.input)) continue
      const cmd = block.input.command
      if (typeof cmd !== 'string' || !PR_CREATE_RE.test(cmd)) continue
      const tk = hashKey(`tool:${typeof block.id === 'string' ? block.id : cmd + ts}`)
      if (seen.has(tk)) continue
      seen.add(tk)
      own.push(tk)
      agg.prs++
    }
  }
  const u = msg.usage
  const model = typeof msg.model === 'string' ? msg.model : ''
  if (!isRecord(u) || !model || model === '<synthetic>') return
  const cc = isRecord(u.cache_creation) ? u.cache_creation : null
  const v: Vec = [
    num(u.input_tokens),
    num(u.output_tokens),
    num(u.cache_read_input_tokens),
    num(u.cache_creation_input_tokens),
    0,
    cc ? num(cc.ephemeral_1h_input_tokens) : 0,
    1
  ]
  if (v[0] + v[1] + v[2] + v[3] === 0) return
  const id = typeof msg.id === 'string' ? msg.id : null
  const req = typeof o.requestId === 'string' ? o.requestId : null
  const rawKey = id && req ? `${id}:${req}` : id ? `msg:${id}` : typeof o.uuid === 'string' ? `uuid:${o.uuid}` : null
  if (!rawKey) return
  const k = hashKey(rawKey)
  const open = st.open.find((e) => e.k === k)
  if (open) {
    // A later copy of a response already counted: add only what grew (max-merge).
    const grow: Vec = new Array<number>(VEC_LEN).fill(0)
    let any = false
    for (let i = 0; i < 6; i++) {
      if (v[i] > open.v[i]) {
        grow[i] = v[i] - open.v[i]
        open.v[i] = v[i]
        any = true
      }
    }
    if (any) addVec(agg, open.day, open.model, grow)
    return
  }
  if (seen.has(k)) return
  seen.add(k)
  own.push(k)
  addSession(agg, o.sessionId)
  touch(agg, ts)
  const day = localDay(ts)
  const long = CLAUDE_LONG_MODELS.test(model) && v[0] + v[2] + v[3] > CLAUDE_LONG_INPUT
  const modelKey = long ? model + LONG_SUFFIX : model
  addVec(agg, day, modelKey, v)
  st.open.push({ k, day, model: modelKey, v: v.slice() })
  if (st.open.length > CLAUDE_OPEN_MAX) st.open.shift()
}

// ---------------------------------------------------------------------------------------
// Codex

export interface CodexWindowRecord {
  usedPercent: number
  windowMinutes: number | null
  /** Epoch ms. */
  resetsAt: number | null
}

export interface CodexLimitsRecord {
  /** Epoch ms of the token_count event. */
  at: number
  primary: CodexWindowRecord | null
  secondary: CodexWindowRecord | null
  plan: string | null
}

export interface CodexState {
  /** This rollout marks turns with `task_started` (then `user_message` is not counted). */
  taskTurns?: boolean
  /** Last cumulative [input, cached, output, reasoning, total]. */
  prev: number[] | null
  model: string | null
  limits: CodexLimitsRecord | null
}

export function emptyCodexState(): CodexState {
  return { prev: null, model: null, limits: null }
}

function usageVec(u: unknown): number[] | null {
  if (!isRecord(u)) return null
  const input = num(u.input_tokens)
  const cached = Math.min(num(u.cached_input_tokens) || num(u.cache_read_input_tokens), input)
  const output = num(u.output_tokens)
  const total = num(u.total_tokens) || input + output
  return [input, cached, output, num(u.reasoning_output_tokens), total]
}

function codexWindow(w: unknown): CodexWindowRecord | null {
  if (!isRecord(w)) return null
  const p = typeof w.used_percent === 'number' && Number.isFinite(w.used_percent) ? w.used_percent : null
  if (p === null) return null
  const mins = typeof w.window_minutes === 'number' && w.window_minutes > 0 ? w.window_minutes : null
  let resetsAt: number | null = null
  if (typeof w.resets_at === 'number' && w.resets_at > 0) resetsAt = w.resets_at < 1e10 ? w.resets_at * 1000 : w.resets_at
  return { usedPercent: Math.max(0, Math.min(100, p)), windowMinutes: mins, resetsAt }
}

/** `rate_limits` of the Codex plan itself (`limit_id` "codex", or absent on older CLIs) —
 *  other ids (`premium`, experimental model pools) are separate meters. */
export function parseCodexRateLimits(rl: unknown, at: number, eventAtMs?: number): CodexLimitsRecord | null {
  if (!isRecord(rl)) return null
  const id = rl.limit_id
  if (id !== undefined && id !== null && id !== 'codex') return null
  const primary = codexWindow(rl.primary)
  const secondary = codexWindow(rl.secondary)
  if (!primary && !secondary) return null
  // Older CLIs report `resets_in_seconds` instead of an absolute time.
  for (const [w, raw] of [
    [primary, rl.primary],
    [secondary, rl.secondary]
  ] as const) {
    if (w && w.resetsAt === null && isRecord(raw) && typeof raw.resets_in_seconds === 'number')
      w.resetsAt = (eventAtMs ?? at) + raw.resets_in_seconds * 1000
  }
  return { at, primary, secondary, plan: typeof rl.plan_type === 'string' ? rl.plan_type : null }
}

export function codexLine(line: string, agg: FileAgg, st: CodexState, seen: SeenKeys, own: string[]): void {
  const isToken = line.includes('"token_count"')
  const isCtx = !isToken && line.includes('"turn_context"')
  const isMeta = !isToken && !isCtx && line.includes('"session_meta"')
  const isSettings = !isToken && !isCtx && !isMeta && line.includes('"thread_settings_applied"')
  const isUser = !isToken && !isCtx && !isMeta && !isSettings && (line.includes('"task_started"') || line.includes('"user_message"'))
  const isPr = !isToken && !isCtx && !isMeta && !isSettings && !isUser && line.includes('"function_call"') && PR_CREATE_RE.test(line)
  if (!isToken && !isCtx && !isMeta && !isSettings && !isUser && !isPr) return
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  if (!isRecord(o) || !isRecord(o.payload)) return
  const p = o.payload
  const ts = tsOf(o.timestamp)
  if (o.type === 'session_meta') {
    addSession(agg, p.id)
    return
  }
  if (o.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) st.model = p.model
    return
  }
  if (o.type === 'event_msg' && p.type === 'thread_settings_applied') {
    const m = isRecord(p.thread_settings) ? p.thread_settings.model : null
    if (typeof m === 'string' && m) st.model = m
    return
  }
  // A turn: `task_started` (current CLIs) or `user_message` (older ones, which have no
  // task_started) — a CLI writes one or the other per prompt, so counting both is safe…
  // except that some versions write both: a user_message right after its task_started.
  if (o.type === 'event_msg' && (p.type === 'task_started' || p.type === 'user_message')) {
    if (p.type === 'task_started') {
      st.taskTurns = true
      agg.turns++
    } else if (!st.taskTurns) agg.turns++
    return
  }
  if (o.type === 'response_item' && p.type === 'function_call') {
    const args = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? '')
    if (!PR_CREATE_RE.test(args)) return
    const tk = hashKey(`codex-call:${typeof p.call_id === 'string' ? p.call_id : args + ts}`)
    if (seen.has(tk)) return
    seen.add(tk)
    own.push(tk)
    agg.prs++
    return
  }
  if (o.type !== 'event_msg' || p.type !== 'token_count' || ts === null) return
  const limits = parseCodexRateLimits(p.rate_limits, ts)
  if (limits && (!st.limits || limits.at >= st.limits.at)) st.limits = limits
  const info = p.info
  if (!isRecord(info)) return
  const total = usageVec(info.total_token_usage)
  const last = usageVec(info.last_token_usage)
  let delta: number[] | null = null
  if (total) {
    if (st.prev && total[4] === st.prev[4]) return // a repeated total (Codex re-emits it)
    if (st.prev && total[4] > st.prev[4]) delta = total.map((x, i) => Math.max(0, x - (st.prev as number[])[i]))
    else delta = st.prev ? last : last ?? total // first event or a new baseline
    st.prev = total
  } else delta = last
  if (!delta || delta[0] + delta[2] === 0) return
  // The same response copied into another rollout (a forked/resumed session) counts once.
  const k = hashKey(`codex:${o.timestamp}|${total ? total.join(',') : delta.join(',')}`)
  if (seen.has(k)) return
  seen.add(k)
  own.push(k)
  touch(agg, ts)
  const model = (typeof p.model === 'string' && p.model) || (typeof info.model === 'string' && info.model) || st.model || 'unknown'
  const long = delta[0] > CODEX_LONG_INPUT
  const cached = Math.min(delta[1], delta[0])
  addVec(agg, localDay(ts), long ? model + LONG_SUFFIX : model, [delta[0] - cached, delta[2], cached, 0, delta[3], 0, 1])
}
