/** Event-driven session status from agent lifecycle hooks (Claude Code hooks, Codex `notify`).
 *
 *  Heuristics (termMeta.ts: title spinner, output recency) can't tell "finished a turn" from
 *  "thinking quietly", so agents that report their own lifecycle drive the sidebar instead:
 *
 *    UserPromptSubmit / PreToolUse / PostToolUse(Failure) → working
 *    PermissionRequest / Notification (permission, question) → attention
 *    Stop / Codex agent-turn-complete                        → done   (✓ until the next prompt)
 *    StopFailure                                             → error
 *    SessionStart                                            → idle
 *
 *  The mapping follows Orca's hook listener (github.com/stablyai/orca, MIT © Lovecast Inc. —
 *  shared/agent-hook-listener/providers/claude-events.ts, codex-events.ts), simplified to one
 *  lead agent per pane: a SubagentStop never completes the lead's turn, a tool FAILURE keeps
 *  the turn working (the agent carries on; only StopFailure ends it in error), and Claude's
 *  60-second "waiting for your input" idle notification never overrides a finished turn.
 *
 *  Pure — agentStatus.test.ts. */
import type { TermStatus } from '../shared/terminal'

/** Events the hook script may report. `TurnComplete` is Codex's `notify` (agent-turn-complete). */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'TurnComplete'
] as const
export type HookEventName = (typeof HOOK_EVENTS)[number]

export interface HookEvent {
  event: HookEventName
  /** Claude Notification's `notification_type` (idle_prompt, permission_prompt, …), else null. */
  detail: string | null
  /** The agent's own conversation id (Claude `session_id` on a prompt / Stop, Codex
   *  `thread-id` on a finished turn) — a UUID, so a relaunch can resume exactly this
   *  conversation (main/sessionRestore.ts). Absent when the event carried none. */
  session?: string
}

/** How much of a session's lifecycle its agent reports:
 *  - 'lifecycle':     prompt submit … stop (Claude Code hooks) — hooks own the status entirely.
 *  - 'turn-complete': only the end of a turn (Codex `notify`) — ✓ after a turn, output-recency
 *                     heuristics while it works (the next Enter hands back to them). */
export type HookMode = 'lifecycle' | 'turn-complete'

const DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/
/** Agent conversation ids are UUIDs (Claude session_id, Codex thread id) — nothing else is
 *  ever accepted, stored or passed to a CLI. */
export const AGENT_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isAgentSessionId(v: unknown): v is string {
  return typeof v === 'string' && AGENT_SESSION_RE.test(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate a hook POST body: `{"event": <HookEventName>, "detail"?: <snake_case word>}` and
 *  nothing else. Anything malformed is rejected, never coerced. */
export function parseHookEvent(raw: unknown): HookEvent | null {
  if (!isRecord(raw)) return null
  if (!Object.keys(raw).every((k) => k === 'event' || k === 'detail' || k === 'session')) return null
  const event = raw.event
  if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) return null
  const detail = raw.detail ?? null
  if (detail !== null && (typeof detail !== 'string' || (detail !== '' && !DETAIL_RE.test(detail)))) return null
  const rawSession = raw.session ?? ''
  if (typeof rawSession !== 'string') return null
  const session = rawSession.toLowerCase()
  if (session !== '' && !isAgentSessionId(session)) return null
  return { event: event as HookEventName, detail: detail === '' ? null : detail, ...(session ? { session } : {}) }
}

/** Next hook-reported state (null = no hook evidence yet) for one event. */
export function nextHookState(state: TermStatus | null, e: HookEvent): TermStatus | null {
  switch (e.event) {
    case 'SessionStart':
      return 'idle'
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'working'
    case 'PermissionRequest':
      return 'attention'
    case 'Notification':
      if (e.detail === 'auth_success') return state
      if (e.detail === 'idle_prompt') {
        // "Claude is waiting for your input" (after ~60 s at the prompt). A finished turn stays
        // ✓; a turn still marked working ended without a Stop (interrupted) — it's idle now.
        return state === 'working' ? 'idle' : state
      }
      return 'attention' // permission_prompt, elicitation_dialog, or an older CLI's untyped one
    case 'Stop':
    case 'TurnComplete':
      return 'done'
    case 'StopFailure':
      return 'error'
    case 'SubagentStop':
      // A child finishing hands control back to the lead, it doesn't end the lead's turn; a
      // background child finishing after the lead's Stop leaves the ✓ alone.
      return state === 'done' || state === 'error' || state === 'idle' ? state : 'working'
  }
}

/** One per hooked session: the last hook-reported state and when it was entered. */
export class HookStatus {
  state: TermStatus | null = null
  /** Epoch ms the current state was entered (a ✓'s "2m ago"). */
  since: number | null = null
  /** Epoch ms of the last hook event of any kind. */
  lastEventAt: number | null = null
  /** The user has pressed Enter at least once (a turn-complete agent can't be working before
   *  its first prompt — its idle TUI redraws would otherwise read as output-recency "working"). */
  submitted = false

  constructor(readonly mode: HookMode) {}

  /** Apply an event; true when the reported state changed. */
  apply(e: HookEvent, now: number): boolean {
    this.lastEventAt = now
    const next = nextHookState(this.state, e)
    if (next === this.state) return false
    this.state = next
    this.since = now
    return true
  }

  /** The user pressed Enter in the terminal. A turn-complete-only agent (Codex) has no
   *  "prompt submitted" event, so Enter after a finished turn hands the status back to the
   *  output heuristics until the next turn completes. Lifecycle agents wait for their own
   *  UserPromptSubmit — typing alone never clears a ✓. */
  userSubmitted(): boolean {
    if (this.mode !== 'turn-complete') return false
    if (!this.submitted) {
      this.submitted = true
      return true
    }
    if (this.state !== 'done' && this.state !== 'error') return false
    this.state = null
    this.since = null
    return true
  }
}
