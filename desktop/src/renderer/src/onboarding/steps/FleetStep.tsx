import { useEffect, useRef, useState } from 'react'
import { Crown, Sparkles, UsersRound } from 'lucide-react'
import type { RosterSuggestResponse } from '../../../../shared/types'
import { Avatar, Notice, ObButton, StatusGlyph, StepFooter, StepHeader } from '../ui'
import { fetchAgentAliases, resolveContainerId, resolveRosterIdentity } from '../portalIdentity'
import ProjectAnalysisCard from './ProjectAnalysisCard'
import { useProjectAnalysis, mergeSuggestions, type MergedSuggestion } from './useProjectAnalysis'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unavailable' } // feature-detect: non-200/404 on the suggest GET → auto-skip
  | {
      kind: 'ready'
      cid: string
      humanAgentId: string | null
      data: RosterSuggestResponse
    }
  | {
      kind: 'creating'
      cid: string
      humanAgentId: string | null
      data: RosterSuggestResponse
    }

/** "Meet your suggested fleet" — shown after a successful provision (first-run AND
 *  add-project). Feature-detects the roster/suggest endpoint: any non-200 (older/open CLI
 *  portals without it, most commonly 404) skips this step entirely and silently via
 *  `onUnavailable`, so the wizard's walker treats it like it was never there.
 *
 *  Alongside the instant heuristic suggestions, a deep analysis of the project via the
 *  user's own local Claude Code sign-in (a Claude or ChatGPT subscription, or an API key)
 *  runs in the background (see
 *  onboarding/steps/useProjectAnalysis.ts) — its suggested agents get merged into the same
 *  card grid (badged "Claude"), and its summary appears in a card above them once it
 *  resolves. The step is fully usable before/without it: accept is enabled immediately, and
 *  a late analysis result just appends more cards. */
/** How the created agents are billed (user-visible, under the cards). */
export const FLEET_BILLING_COPY =
  'Agents run on a Claude or ChatGPT subscription, or an API key (Settings › API keys).'

export interface AcceptError {
  message: string
  detail?: string
}

/** Turn a failed roster-accept call into words the user can act on. */
export function describeAcceptError(err: unknown): AcceptError {
  const e = (err && typeof err === 'object' ? err : {}) as { status?: number; detail?: string }
  const detail = typeof e.detail === 'string' && e.detail ? e.detail : undefined
  const cap = detail ? /at most (\d+)/i.exec(detail) : null
  if (e.status === 422 && cap)
    return {
      message: `This project can create at most ${cap[1]} agents at once. Uncheck some, create them, then add the rest from the project’s Agents tab.`,
      detail
    }
  if (e.status === 401 || e.status === 403)
    return { message: 'You don’t have permission to add agents to this project.', detail }
  if (e.status === 409)
    return { message: 'One of these names is already taken in this project. Uncheck it and try again.', detail }
  return { message: 'The project is fine. Try again, or skip and add agents from the project later.', detail }
}

/** After a failed accept, sort the attempted aliases by what the roster now holds: `created`
 *  = on the roster now but not before this step loaded (an earlier, partly-applied batch made
 *  them — retrying would 409 on them forever), `taken` = on the roster before we started (the
 *  user has to uncheck those). Case-insensitive, like the server's alias uniqueness. */
export function partialAcceptOutcome(
  attempted: readonly string[],
  before: ReadonlySet<string>,
  after: ReadonlySet<string>
): { created: string[]; taken: string[] } {
  const created: string[] = []
  const taken: string[] = []
  for (const alias of attempted) {
    const k = alias.toLowerCase()
    if (before.has(k)) taken.push(alias)
    else if (after.has(k)) created.push(alias)
  }
  return { created, taken }
}

/** D-19f: the accept route validates every alias up front and answers ONE 409
 *  ("… — nothing was created; …") before creating anything. After that 409, an attempted
 *  alias that is on the roster now was made by someone else (a concurrent user), never by
 *  us — so it is "taken", not "created". */
export function acceptCreatedNothing(status: number | undefined, detail: string | undefined): boolean {
  return status === 409 && /nothing was created/i.test(detail ?? '')
}

const quoteList = (xs: readonly string[]): string => xs.map((x) => `“${x}”`).join(', ')

/** Drop suggestions whose alias is already on the project's roster (case-insensitive, like
 *  the server's alias uniqueness). Reconnecting an existing project must never re-offer its
 *  own agents — accepting them could only 409 (D-21). */
export function withoutExisting<T extends { alias: string }>(xs: readonly T[], existing: ReadonlySet<string>): T[] {
  return xs.filter((s) => !existing.has(s.alias.toLowerCase()))
}

/** The message for a failed accept, given what the roster says now. A 401/403/422 is about
 *  the whole request (permission, batch cap) — its own reason always stays, even when some
 *  attempted aliases were on the roster before (D-19e); only a 409 is about a taken name. */
export function acceptFailureMessage(
  base: AcceptError,
  status: number | undefined,
  outcome: { created: readonly string[]; taken: readonly string[] }
): AcceptError {
  const { created, taken } = outcome
  const createdLine = created.length
    ? `${quoteList(created)} ${created.length === 1 ? 'was' : 'were'} created.`
    : ''
  if (status === 401 || status === 403 || status === 422) {
    return createdLine ? { ...base, message: `${createdLine} ${base.message}` } : base
  }
  const parts: string[] = []
  if (createdLine) parts.push(createdLine)
  if (status === 409 && taken.length)
    parts.push(
      `${quoteList(taken)} ${taken.length === 1 ? 'is' : 'are'} already taken in this project. Uncheck ${taken.length === 1 ? 'it' : 'them'} and try again.`
    )
  else if (created.length) parts.push('Try again to create the rest.')
  return parts.length ? { ...base, message: parts.join(' ') } : base
}

export default function FleetStep({
  apiPort,
  folder = null,
  onDone,
  onUnavailable
}: {
  apiPort: number
  /** The just-provisioned project's folder — kicks off the background analysis. null/absent
   *  skips the analysis entirely (no shimmer), e.g. if the wizard never resolved a folder. */
  folder?: string | null
  /** Called with the aliases actually created ([] when the user skipped). */
  onDone: (created: string[]) => void
  onUnavailable: () => void
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const analysis = useProjectAnalysis(folder)
  const [persisted, setPersisted] = useState(false)
  const [acceptError, setAcceptError] = useState<AcceptError | null>(null)
  /** Aliases on the roster when this step loaded (lower-cased). */
  const existingRef = useRef<Set<string>>(new Set())
  /** Suggestions an earlier, partly-failed batch already created: kept, never re-sent. */
  const [createdSoFar, setCreatedSoFar] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const cid = await resolveContainerId(apiPort)
        if (!cid) {
          if (!cancelled) onUnavailable()
          return
        }
        const data = (await window.orchaDesktop.portalGet(
          apiPort,
          `/api/containers/${cid}/roster/suggest`
        )) as RosterSuggestResponse
        if (cancelled) return
        if (!data.available || data.suggestions.length === 0) {
          onUnavailable()
          return
        }
        const { humanAgentId, aliases } = await resolveRosterIdentity(apiPort, cid)
        if (cancelled) return
        existingRef.current = aliases
        // Reconnect / an older portal that doesn't filter: agents already on the roster are
        // never offered again; nothing new left → skip the step like an empty suggest (D-21).
        const fresh = withoutExisting(data.suggestions, aliases)
        if (fresh.length === 0) {
          onUnavailable()
          return
        }
        const offered = { ...data, suggestions: fresh }
        setSelected(new Set(fresh.map((s) => s.alias)))
        setState({ kind: 'ready', cid, humanAgentId, data: offered })
      } catch {
        // Any failure (404 from an older portal, network hiccup, malformed body) — skip
        // rather than block the wizard on a step that isn't load-bearing.
        if (!cancelled) onUnavailable()
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiPort])

  // Once BOTH the container id and a successful analysis are known, persist it to the
  // portal (feature-detected: a 404 — older/open CLI portal without the route — is silently
  // swallowed). Fires once per mount via the `persisted` guard.
  useEffect(() => {
    if (persisted) return
    if (state.kind !== 'ready' && state.kind !== 'creating') return
    if (analysis.kind !== 'done' || !analysis.result.ok) return
    setPersisted(true)
    const { cid, humanAgentId } = state
    const { summary, agents } = analysis.result
    void window.orchaDesktop
      .portalPut(apiPort, `/api/containers/${cid}/roster/analysis`, {
        summary,
        suggestions: agents,
        source: 'claude-local',
        actor_agent_id: humanAgentId
      })
      .catch(() => {
        // Feature-detect: no such route (older/open portal) or any other failure — this is
        // a nice-to-have persist, never worth surfacing to the user.
      })
  }, [analysis, state, apiPort, persisted])

  // Once the analysis resolves, default its NEW (non-duplicate) aliases to selected too —
  // same as the heuristic list's initial seed — without touching any selection the user
  // already toggled. Written into real `selected` state (not just a render-time display
  // default) so accept — which filters by `selected` — actually includes them.
  useEffect(() => {
    if (state.kind !== 'ready') return
    if (analysis.kind !== 'done' || !analysis.result.ok) return
    const heuristicAliases = new Set(state.data.suggestions.map((s) => s.alias.toLowerCase()))
    const newAliases = withoutExisting(analysis.result.agents, existingRef.current)
      .map((a) => a.alias)
      .filter((alias) => !heuristicAliases.has(alias.toLowerCase()))
    if (newAliases.length === 0) return
    setSelected((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const alias of newAliases) {
        if (!next.has(alias)) {
          next.add(alias)
          changed = true
        }
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, state])

  function toggle(alias: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }

  async function createFleet(): Promise<void> {
    if (state.kind !== 'ready') return
    const { cid, humanAgentId, data } = state
    setState({ kind: 'creating', cid, humanAgentId, data })
    setAcceptError(null)
    const analysisAgents =
      analysis.kind === 'done' && analysis.result.ok ? withoutExisting(analysis.result.agents, existingRef.current) : []
    const merged = mergeSuggestions(data.suggestions, analysisAgents)
    const done = new Set(createdSoFar.map((a) => a.toLowerCase()))
    const chosen = merged
      .filter((s) => selected.has(s.alias) && !done.has(s.alias.toLowerCase()))
      .map(({ source: _source, ...s }) => s)
    try {
      const res = (await window.orchaDesktop.portalPost(apiPort, `/api/containers/${cid}/roster/suggest/accept`, {
        suggestions: chosen,
        actor_agent_id: humanAgentId
      })) as { created?: Array<string | { alias?: string }> }
      // The accept API returns [{agent_id, alias}] rows — surface ALIASES, never
      // stringified objects ("[object Object]" bug).
      const createdAliases = (res.created ?? chosen)
        .map((c) => (typeof c === 'string' ? c : (c.alias ?? '')))
        .filter(Boolean)
      onDone([...createdSoFar, ...(createdAliases.length ? createdAliases : chosen.map((s) => s.alias))])
    } catch (err) {
      // Not fatal to onboarding, but never silent: say WHY and offer Try again / Skip.
      const base = describeAcceptError(err)
      // A batch can fail part-way (the server creates one by one): whatever it already made
      // is kept and dropped from the selection, so Try again only sends the rest (D-19b).
      const now = await fetchAgentAliases(apiPort, cid)
      const status = (err && typeof err === 'object' ? (err as { status?: number }).status : undefined)
      if (now) {
        const { created, taken } = partialAcceptOutcome(
          chosen.map((s) => s.alias),
          // D-19f: an all-or-nothing 409 created none of ours — every attempted alias on
          // the roster now is someone else's (taken), never "created".
          acceptCreatedNothing(status, base.detail) ? now : existingRef.current,
          now
        )
        if (created.length) {
          setCreatedSoFar((prev) => [...prev, ...created])
          setSelected((prev) => {
            const next = new Set(prev)
            for (const a of created) next.delete(a)
            return next
          })
        }
        setAcceptError(acceptFailureMessage(base, status, { created, taken }))
      } else setAcceptError(base)
      setState({ kind: 'ready', cid, humanAgentId, data })
    }
  }

  if (state.kind === 'loading') {
    return (
      <>
        <StepHeader
          icon={<UsersRound className="h-4 w-4" aria-hidden="true" />}
          title="Suggested agents"
          subtitle="Looking at your project to suggest a team…"
        />
        <div className="flex items-center gap-2 text-[13px] text-text-2">
          <StatusGlyph state="running" /> Reading the project…
        </div>
        <div className="ob-agent-grid" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="ob-agent-card ob-agent-ghost ob-breathe" style={{ animationDelay: `${i * 160}ms` }}>
              <span className="ob-ghost-avatar" />
              <span className="flex flex-1 flex-col gap-2 pt-1">
                <span className="ob-ghost-line" style={{ width: '46%' }} />
                <span className="ob-ghost-line" style={{ width: '78%' }} />
              </span>
            </span>
          ))}
        </div>
      </>
    )
  }

  if (state.kind === 'unavailable') return null

  const { data } = state
  const analysisAgents =
    analysis.kind === 'done' && analysis.result.ok ? withoutExisting(analysis.result.agents, existingRef.current) : []
  const merged = mergeSuggestions(data.suggestions, analysisAgents)
  const sorted = [...merged].sort((a, b) => Number(b.is_main) - Number(a.is_main))
  const creating = state.kind === 'creating'
  const createdKeys = new Set(createdSoFar.map((a) => a.toLowerCase()))
  const count = sorted.filter((s) => selected.has(s.alias) && !createdKeys.has(s.alias.toLowerCase())).length
  // Everything still wanted was created by an earlier partial batch: nothing left to send.
  const onlyContinue = count === 0 && createdSoFar.length > 0
  const shown = data.signals.slice(0, 3)
  const more = data.signals.length - shown.length
  const basis = shown.length ? `Based on ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}. ` : ''

  return (
    <>
      <StepHeader
        icon={<UsersRound className="h-4 w-4" aria-hidden="true" />}
        title="Suggested agents"
        subtitle={`${basis}Pick who joins the project — you can change the team any time.`}
      />

      {analysis.kind === 'pending' && (
        <p className="ob-breathe m-0 flex items-center gap-2 text-xs text-text-3">
          <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
          Analyzing your project with Claude…
        </p>
      )}
      {analysis.kind === 'done' && analysis.result.ok && <ProjectAnalysisCard summary={analysis.result.summary} />}

      <div className="ob-agent-grid" role="group" aria-label="Suggested agents">
        {sorted.map((s, i) => (
          <FleetRow
            key={s.alias}
            index={i}
            suggestion={s}
            checked={selected.has(s.alias) || createdKeys.has(s.alias.toLowerCase())}
            created={createdKeys.has(s.alias.toLowerCase())}
            disabled={creating || createdKeys.has(s.alias.toLowerCase())}
            onToggle={() => toggle(s.alias)}
          />
        ))}
      </div>
      <p className="m-0 text-xs text-text-3" data-testid="fleet-billing">
        {FLEET_BILLING_COPY}
      </p>

      {acceptError && (
        <Notice tone="danger" title="The agents couldn’t be created">
          {acceptError.message}
          {acceptError.detail ? <span className="mt-1 block text-[12px] text-text-3">Details: {acceptError.detail}</span> : null}
        </Notice>
      )}

      <StepFooter
        left={
          <ObButton variant="ghost" onClick={() => onDone(createdSoFar)} disabled={creating}>
            Skip for now
          </ObButton>
        }
      >
        <ObButton
          variant="primary"
          data-onb-primary="true"
          onClick={() => (onlyContinue ? onDone(createdSoFar) : void createFleet())}
          disabled={creating || (count === 0 && !onlyContinue)}
        >
          {creating
            ? 'Creating…'
            : onlyContinue
              ? 'Continue'
              : acceptError
                ? 'Try again'
                : `Create ${count} ${count === 1 ? 'agent' : 'agents'}`}
        </ObButton>
      </StepFooter>
    </>
  )
}

function FleetRow({
  suggestion,
  index = 0,
  checked,
  created = false,
  disabled,
  onToggle
}: {
  suggestion: MergedSuggestion
  /** Position in the grid — staggers the card's entrance. */
  index?: number
  checked: boolean
  /** Already created by an earlier, partly-failed batch. */
  created?: boolean
  disabled: boolean
  onToggle: () => void
}) {
  const fromClaude = suggestion.source === 'claude'
  return (
    <label
      className="ob-agent-card"
      data-checked={checked}
      data-lead={suggestion.is_main || undefined}
      style={{ '--i': Math.min(index, 8) } as React.CSSProperties}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        aria-label={`Include ${suggestion.alias}`}
        className="ob-agent-check h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
      />
      <span className="ob-agent-avatar">
        <Avatar
          name={suggestion.alias}
          size={32}
          badge={fromClaude ? <Sparkles className="h-2 w-2" aria-hidden="true" /> : undefined}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-col">
          <span className="ob-row-title pr-5">{suggestion.alias}</span>
          <span className="truncate text-xs text-text-3">{suggestion.role}</span>
        </span>
        {(suggestion.is_main || created || fromClaude) && (
          <span className="flex flex-wrap items-center gap-1.5">
            {suggestion.is_main && (
              <span className="ob-chip" aria-label="Lead agent">
                <Crown className="h-3 w-3 text-accent" aria-hidden="true" />
                Lead
              </span>
            )}
            {created && <span className="ob-chip">Created</span>}
            {fromClaude && (
              <span className="ob-chip">
                <Sparkles className="h-3 w-3 text-accent" aria-hidden="true" />
                Claude
              </span>
            )}
          </span>
        )}
        {suggestion.focus && <span className="text-[12.5px] leading-snug text-text-2">{suggestion.focus}</span>}
        {suggestion.rationale && <span className="ob-row-sub">{suggestion.rationale}</span>}
      </span>
    </label>
  )
}
