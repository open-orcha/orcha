// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FleetStep from './FleetStep'
import type { RosterSuggestResponse } from '../../../../shared/types'

const SUGGEST_PAYLOAD: RosterSuggestResponse = {
  available: true,
  project_kind: 'ios',
  signals: ['ios/', 'Package.swift'],
  suggestions: [
    {
      alias: 'Atlas',
      role: 'Lead',
      focus: 'Coordination',
      is_main: true,
      rationale: 'found ios/ + Package.swift'
    },
    {
      alias: 'Sable',
      role: 'iOS',
      focus: 'SwiftUI views',
      is_main: false,
      rationale: 'found ios/'
    }
  ]
}

function stubOrchaDesktop(overrides: Partial<typeof window.orchaDesktop> = {}) {
  window.orchaDesktop = {
    portalGet: vi.fn(),
    portalPost: vi.fn(),
    portalPut: vi.fn(),
    analyzeProject: vi.fn().mockResolvedValue({
      ok: false,
      reason: 'claude is not installed on this Mac'
    }),
    ...overrides
  } as never
}

describe('FleetStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders suggestions from a stubbed suggest payload, Atlas leads with the crown affordance', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] }) // resolveContainerId
      .mockResolvedValueOnce(SUGGEST_PAYLOAD) // roster/suggest
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human' }] }) // resolveHumanAgentId
    stubOrchaDesktop({ portalGet })

    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Atlas')).toBeInTheDocument())
    expect(screen.getByText('Sable')).toBeInTheDocument()
    expect(screen.getByText(/found ios\/ \+ package\.swift/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Lead agent')).toBeInTheDocument()
  })

  it('toggles suggestions and posts accept with only the selected ones', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(SUGGEST_PAYLOAD)
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human' }] })
    const portalPost = vi.fn().mockResolvedValue({ created: ['Atlas'] })
    stubOrchaDesktop({ portalGet, portalPost })

    const user = userEvent.setup()
    const onDone = vi.fn()
    render(<FleetStep apiPort={8001} onDone={onDone} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Sable')).toBeInTheDocument())
    // Both on by default.
    expect(screen.getByLabelText('Include Atlas')).toBeChecked()
    expect(screen.getByLabelText('Include Sable')).toBeChecked()

    await user.click(screen.getByLabelText('Include Sable'))
    expect(screen.getByLabelText('Include Sable')).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: /create \d+ agents?/i }))

    await waitFor(() =>
      expect(portalPost).toHaveBeenCalledWith(8001, '/api/containers/c1/roster/suggest/accept', {
        suggestions: [SUGGEST_PAYLOAD.suggestions[0]],
        actor_agent_id: 'h1'
      })
    )
    // No "Fleet created" interstitial — straight on with the created aliases.
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(['Atlas']))
  })

  it('keeps the user on the step with a readable error when accept fails, then retries', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(SUGGEST_PAYLOAD)
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human' }] })
    const portalPost = vi
      .fn()
      .mockRejectedValueOnce({ code: 'PORTAL_REQUEST_FAILED', status: 500 })
      .mockResolvedValue({
        created: [
          { agent_id: 'a1', alias: 'Atlas' },
          { agent_id: 'a2', alias: 'Sable' }
        ]
      })
    stubOrchaDesktop({ portalGet, portalPost })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} onDone={onDone} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Sable')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create 2 agents/i }))
    expect(await screen.findByText(/couldn.t be created/i)).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(['Atlas', 'Sable']))
  })

  it('D-19b: a batch that failed part-way keeps what it created; the retry only sends the rest', async () => {
    const payload: RosterSuggestResponse = {
      ...SUGGEST_PAYLOAD,
      suggestions: [
        { alias: 'newbie1', role: 'Lead', focus: 'x', is_main: true, rationale: '' },
        { alias: 'newbie2', role: 'Dev', focus: 'y', is_main: false, rationale: '' },
        { alias: 'stripe-guru', role: 'Payments', focus: 'z', is_main: false, rationale: '' }
      ]
    }
    const human = { id: 'h1', kind: 'human', alias: 'owner' }
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ agents: [human] })
      // after the failed batch: newbie1 got created before the server gave up
      .mockResolvedValueOnce({ agents: [human, { id: 'n1', kind: 'ai', alias: 'newbie1' }] })
    const portalPost = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ created: [{ agent_id: 'n2', alias: 'newbie2' }] })
    stubOrchaDesktop({ portalGet, portalPost })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} onDone={onDone} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('stripe-guru')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create 3 agents/i }))
    expect(await screen.findByText(/“newbie1” was created\. Try again to create the rest\./)).toBeInTheDocument()
    // newbie1 is locked in as created and no longer counted
    expect(screen.getByRole('checkbox', { name: /include newbie1/i })).toBeDisabled()
    expect(screen.getByText('Created')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /include stripe-guru/i }))
    await user.click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(['newbie1', 'newbie2']))
    const retried = portalPost.mock.calls[1][2] as { suggestions: Array<{ alias: string }> }
    expect(retried.suggestions.map((s) => s.alias)).toEqual(['newbie2'])
  })

  it('D-19f: a name taken by someone else between load and Create is "taken", never "created"', async () => {
    const payload: RosterSuggestResponse = {
      ...SUGGEST_PAYLOAD,
      suggestions: [
        { alias: 'newbie1', role: 'Lead', focus: 'x', is_main: true, rationale: '' },
        { alias: 'racer', role: 'Dev', focus: 'y', is_main: false, rationale: '' },
        { alias: 'newbie2', role: 'QA', focus: 'z', is_main: false, rationale: '' }
      ]
    }
    const human = { id: 'h1', kind: 'human', alias: 'owner' }
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ agents: [human] })
      // a concurrent user registered 'racer' just before our accept
      .mockResolvedValueOnce({ agents: [human, { id: 'r1', kind: 'ai', alias: 'racer' }] })
    const portalPost = vi
      .fn()
      .mockRejectedValueOnce({
        status: 409,
        detail: "alias already registered in this project: 'racer' — nothing was created; uncheck or rename those and try again"
      })
      .mockResolvedValueOnce({ created: [{ agent_id: 'n1', alias: 'newbie1' }, { agent_id: 'n2', alias: 'newbie2' }] })
    stubOrchaDesktop({ portalGet, portalPost })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} onDone={onDone} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('racer')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create 3 agents/i }))
    expect(await screen.findByText(/“racer” is already taken in this project\. Uncheck it and try again\./)).toBeInTheDocument()
    expect(screen.queryByText(/“racer” was created/)).toBeNull()
    expect(screen.queryByText('Created')).toBeNull()
    expect(screen.getByRole('checkbox', { name: /include racer/i })).not.toBeDisabled()

    await user.click(screen.getByRole('checkbox', { name: /include racer/i }))
    await user.click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(['newbie1', 'newbie2']))
    const retried = portalPost.mock.calls[1][2] as { suggestions: Array<{ alias: string }> }
    expect(retried.suggestions.map((s) => s.alias)).toEqual(['newbie1', 'newbie2'])
  })

  it('D-21: agents already on the roster (reconnect) are not offered or preselected; only new ones are sent', async () => {
    const payload: RosterSuggestResponse = {
      ...SUGGEST_PAYLOAD,
      suggestions: [
        { alias: 'atlas', role: 'Lead', focus: 'x', is_main: true, rationale: '' },
        { alias: 'nova', role: 'Dev', focus: 'y', is_main: false, rationale: '' },
        { alias: 'ripple', role: 'Backend', focus: 'z', is_main: false, rationale: '' }
      ]
    }
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({
        agents: [
          { id: 'h1', kind: 'human', alias: 'me' },
          { id: 'a', kind: 'ai', alias: 'Atlas' },
          { id: 'n', kind: 'ai', alias: 'Nova' }
        ]
      })
    const portalPost = vi.fn().mockResolvedValue({ created: [{ agent_id: 'r', alias: 'ripple' }] })
    const analyzeProject = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'An app.',
      agents: [
        { alias: 'NOVA', role: 'dup', focus: 'x', rationale: '' },
        { alias: 'sentry', role: 'Ops', focus: 'y', rationale: '' }
      ]
    })
    stubOrchaDesktop({ portalGet, portalPost, analyzeProject, portalPut: vi.fn().mockResolvedValue({}) })
    const onDone = vi.fn()
    const onUnavailable = vi.fn()
    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} folder="/proj" onDone={onDone} onUnavailable={onUnavailable} />)

    await waitFor(() => expect(screen.getByText('sentry')).toBeInTheDocument())
    expect(screen.getByText('ripple')).toBeInTheDocument()
    expect(screen.queryByLabelText(/include atlas/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/include nova/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Include ripple')).toBeChecked()
    await waitFor(() => expect(screen.getByLabelText('Include sentry')).toBeChecked())
    await user.click(screen.getByRole('button', { name: /create 2 agents/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const sent = portalPost.mock.calls[0][2] as { suggestions: Array<{ alias: string }> }
    expect(sent.suggestions.map((s) => s.alias).sort()).toEqual(['ripple', 'sentry'])
    expect(onUnavailable).not.toHaveBeenCalled()
  })

  it('D-21: when every suggestion is already on the roster, the step skips itself', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(SUGGEST_PAYLOAD)
      .mockResolvedValueOnce({
        agents: [
          { id: 'h1', kind: 'human', alias: 'me' },
          { id: 'a', kind: 'ai', alias: 'atlas' },
          { id: 's', kind: 'ai', alias: 'SABLE' }
        ]
      })
    const portalPost = vi.fn()
    stubOrchaDesktop({ portalGet, portalPost })
    const onUnavailable = vi.fn()
    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={onUnavailable} />)
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: /create/i })).not.toBeInTheDocument()
    expect(portalPost).not.toHaveBeenCalled()
  })

  it('D-19e: an over-cap 422 names the cap, never a "taken" message, and nothing is marked created', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(SUGGEST_PAYLOAD)
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human', alias: 'me' }] })
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human', alias: 'me' }] })
    const portalPost = vi.fn().mockRejectedValueOnce({ status: 422, detail: 'List should have at most 13 items' })
    stubOrchaDesktop({ portalGet, portalPost })
    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Sable')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create 2 agents/i }))
    expect(await screen.findByText(/can create at most 13 agents at once/)).toBeInTheDocument()
    expect(screen.queryByText(/already taken/)).not.toBeInTheDocument()
    expect(screen.queryByText('Created')).not.toBeInTheDocument()
  })

  it('D-19b: when everything left was already created, the step offers Continue instead of a doomed retry', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(SUGGEST_PAYLOAD)
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human', alias: 'me' }] })
      .mockResolvedValueOnce({
        agents: [
          { id: 'h1', kind: 'human', alias: 'me' },
          { id: 'a', kind: 'ai', alias: 'Atlas' },
          { id: 'b', kind: 'ai', alias: 'Sable' }
        ]
      })
    const portalPost = vi.fn().mockRejectedValueOnce({ status: 500 })
    stubOrchaDesktop({ portalGet, portalPost })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} onDone={onDone} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Sable')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create 2 agents/i }))
    await user.click(await screen.findByRole('button', { name: /^continue$/i }))
    expect(onDone).toHaveBeenCalledWith(['Atlas', 'Sable'])
    expect(portalPost).toHaveBeenCalledTimes(1)
  })

  it('Skip for now finishes with no agents', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(SUGGEST_PAYLOAD)
      .mockResolvedValueOnce({ agents: [] })
    stubOrchaDesktop({ portalGet })
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} onDone={onDone} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Sable')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    expect(onDone).toHaveBeenCalledWith([])
  })

  it('auto-skips silently when the suggest endpoint 404s (older/open CLI portal)', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockRejectedValueOnce({ code: 'PORTAL_REQUEST_FAILED', status: 404 })
    stubOrchaDesktop({ portalGet })

    const onUnavailable = vi.fn()
    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={onUnavailable} />)

    await waitFor(() => expect(onUnavailable).toHaveBeenCalled())
  })

  it('auto-skips when available is false', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce({
        available: false,
        project_kind: 'unknown',
        signals: [],
        suggestions: []
      })
    stubOrchaDesktop({ portalGet })

    const onUnavailable = vi.fn()
    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={onUnavailable} />)

    await waitFor(() => expect(onUnavailable).toHaveBeenCalled())
  })
})

describe('FleetStep — project analysis integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function stubRoster(extra: Partial<typeof window.orchaDesktop> = {}) {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce(SUGGEST_PAYLOAD)
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human' }] })
    stubOrchaDesktop({ portalGet, ...extra })
    return portalGet
  }

  it('shows the "Analyzing…" shimmer while the analysis is pending, folder given', async () => {
    let resolveAnalysis: (v: unknown) => void = () => {}
    const analyzeProject = vi.fn(() => new Promise((resolve) => (resolveAnalysis = resolve)))
    stubRoster({ analyzeProject: analyzeProject as never })

    render(<FleetStep apiPort={8001} folder="/proj" onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/analyzing your project with claude/i)).toBeInTheDocument())
    // resolve so the effect doesn't leak into the next test
    resolveAnalysis({ ok: false, reason: 'x' })
  })

  it('skips the analysis entirely (no shimmer, no call) when folder is null/absent', async () => {
    const analyzeProject = vi.fn()
    stubRoster({ analyzeProject })

    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Sable')).toBeInTheDocument())
    expect(screen.queryByText(/analyzing your project with claude/i)).not.toBeInTheDocument()
    expect(analyzeProject).not.toHaveBeenCalled()
  })

  it('merges analysis agents into the card grid with a "Claude" badge, dedupes by alias', async () => {
    const analyzeProject = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'A native iOS todo app.',
      agents: [
        {
          alias: 'sable',
          role: 'dup-of-heuristic',
          focus: 'x',
          rationale: 'dup'
        }, // dedupe target
        {
          alias: 'ripple',
          role: 'Backend',
          focus: 'API routes',
          rationale: 'found api/'
        }
      ]
    })
    const portalPut = vi.fn().mockResolvedValue({ ok: true })
    stubRoster({ analyzeProject, portalPut })

    render(<FleetStep apiPort={8001} folder="/proj" onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('A native iOS todo app.')).toBeInTheDocument())
    expect(screen.getByText('ripple')).toBeInTheDocument()
    // dedupe: only one Sable card, and it's the heuristic's own role (not the analysis dup's)
    expect(screen.getAllByText('Sable')).toHaveLength(1)
    expect(screen.getByText('iOS')).toBeInTheDocument() // heuristic's role for Sable survived
    // "Claude" badge appears exactly once — only for the non-duplicate analysis entry (ripple)
    expect(screen.getAllByText('Claude')).toHaveLength(1)
  })

  it('persists the analysis via PUT roster/analysis once cid + a successful analysis are known', async () => {
    const analyzeProject = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'A native iOS todo app.',
      agents: [
        {
          alias: 'ripple',
          role: 'Backend',
          focus: 'API routes',
          rationale: 'found api/'
        }
      ]
    })
    const portalPut = vi.fn().mockResolvedValue({ ok: true })
    stubRoster({ analyzeProject, portalPut })

    render(<FleetStep apiPort={8001} folder="/proj" onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() =>
      expect(portalPut).toHaveBeenCalledWith(8001, '/api/containers/c1/roster/analysis', {
        summary: 'A native iOS todo app.',
        suggestions: [
          {
            alias: 'ripple',
            role: 'Backend',
            focus: 'API routes',
            rationale: 'found api/'
          }
        ],
        source: 'claude-local',
        actor_agent_id: 'h1'
      })
    )
  })

  it('does not persist when the analysis fails (ok:false)', async () => {
    const analyzeProject = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'claude is not installed on this Mac'
    })
    const portalPut = vi.fn()
    stubRoster({ analyzeProject, portalPut })

    render(<FleetStep apiPort={8001} folder="/proj" onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Sable')).toBeInTheDocument())
    expect(portalPut).not.toHaveBeenCalled()
  })

  it('tolerates a 404 on the persist PUT (feature-detect skip, never throws/blocks)', async () => {
    const analyzeProject = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'A native iOS todo app.',
      agents: [{ alias: 'ripple', role: 'Backend', focus: 'x', rationale: 'y' }]
    })
    const portalPut = vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 })
    stubRoster({ analyzeProject, portalPut })

    render(<FleetStep apiPort={8001} folder="/proj" onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(portalPut).toHaveBeenCalled())
    // step remains usable — Sable (heuristic) is still there, no crash
    expect(screen.getByText('Sable')).toBeInTheDocument()
  })

  it('accept posts the merged (heuristic + Claude) selection, stripping the internal source tag', async () => {
    const analyzeProject = vi.fn().mockResolvedValue({
      ok: true,
      summary: 'A native iOS todo app.',
      agents: [
        {
          alias: 'ripple',
          role: 'Backend',
          focus: 'API routes',
          rationale: 'found api/'
        }
      ]
    })
    const portalPost = vi.fn().mockResolvedValue({ created: ['Atlas', 'Sable', 'ripple'] })
    const portalPut = vi.fn().mockResolvedValue({ ok: true })
    stubRoster({ analyzeProject, portalPost, portalPut })

    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} folder="/proj" onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('A native iOS todo app.')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create \d+ agents?/i }))

    await waitFor(() =>
      expect(portalPost).toHaveBeenCalledWith(
        8001,
        '/api/containers/c1/roster/suggest/accept',
        expect.objectContaining({
          suggestions: expect.arrayContaining([expect.objectContaining({ alias: 'ripple', role: 'Backend' })])
        })
      )
    )
    // the posted suggestions never carry the internal `source` tag
    const posted = portalPost.mock.calls[0][2] as {
      suggestions: Array<Record<string, unknown>>
    }
    expect(posted.suggestions.every((s) => !('source' in s))).toBe(true)
  })
})
