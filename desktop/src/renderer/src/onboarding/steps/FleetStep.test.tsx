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
    { alias: 'Atlas', role: 'Lead', focus: 'Coordination', is_main: true, rationale: 'found ios/ + Package.swift' },
    { alias: 'Sable', role: 'iOS', focus: 'SwiftUI views', is_main: false, rationale: 'found ios/' }
  ]
}

function stubOrchaDesktop(overrides: Partial<typeof window.orchaDesktop> = {}) {
  window.orchaDesktop = {
    portalGet: vi.fn(),
    portalPost: vi.fn(),
    portalPut: vi.fn(),
    analyzeProject: vi.fn().mockResolvedValue({ ok: false, reason: 'claude is not installed on this Mac' }),
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
    render(<FleetStep apiPort={8001} onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Sable')).toBeInTheDocument())
    // Both on by default.
    expect(screen.getByLabelText('Include Atlas')).toBeChecked()
    expect(screen.getByLabelText('Include Sable')).toBeChecked()

    await user.click(screen.getByLabelText('Include Sable'))
    expect(screen.getByLabelText('Include Sable')).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: /create fleet/i }))

    await waitFor(() =>
      expect(portalPost).toHaveBeenCalledWith(8001, '/api/containers/c1/roster/suggest/accept', {
        suggestions: [SUGGEST_PAYLOAD.suggestions[0]],
        actor_agent_id: 'h1'
      })
    )
    await waitFor(() => expect(screen.getByText(/fleet created/i)).toBeInTheDocument())
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
      .mockResolvedValueOnce({ available: false, project_kind: 'unknown', signals: [], suggestions: [] })
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
        { alias: 'sable', role: 'dup-of-heuristic', focus: 'x', rationale: 'dup' }, // dedupe target
        { alias: 'ripple', role: 'Backend', focus: 'API routes', rationale: 'found api/' }
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
      agents: [{ alias: 'ripple', role: 'Backend', focus: 'API routes', rationale: 'found api/' }]
    })
    const portalPut = vi.fn().mockResolvedValue({ ok: true })
    stubRoster({ analyzeProject, portalPut })

    render(<FleetStep apiPort={8001} folder="/proj" onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() =>
      expect(portalPut).toHaveBeenCalledWith(8001, '/api/containers/c1/roster/analysis', {
        summary: 'A native iOS todo app.',
        suggestions: [{ alias: 'ripple', role: 'Backend', focus: 'API routes', rationale: 'found api/' }],
        source: 'claude-local',
        actor_agent_id: 'h1'
      })
    )
  })

  it('does not persist when the analysis fails (ok:false)', async () => {
    const analyzeProject = vi.fn().mockResolvedValue({ ok: false, reason: 'claude is not installed on this Mac' })
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
      agents: [{ alias: 'ripple', role: 'Backend', focus: 'API routes', rationale: 'found api/' }]
    })
    const portalPost = vi.fn().mockResolvedValue({ created: ['Atlas', 'Sable', 'ripple'] })
    const portalPut = vi.fn().mockResolvedValue({ ok: true })
    stubRoster({ analyzeProject, portalPost, portalPut })

    const user = userEvent.setup()
    render(<FleetStep apiPort={8001} folder="/proj" onDone={vi.fn()} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('A native iOS todo app.')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create fleet/i }))

    await waitFor(() =>
      expect(portalPost).toHaveBeenCalledWith(
        8001,
        '/api/containers/c1/roster/suggest/accept',
        expect.objectContaining({
          suggestions: expect.arrayContaining([
            expect.objectContaining({ alias: 'ripple', role: 'Backend' })
          ])
        })
      )
    )
    // the posted suggestions never carry the internal `source` tag
    const posted = portalPost.mock.calls[0][2] as { suggestions: Array<Record<string, unknown>> }
    expect(posted.suggestions.every((s) => !('source' in s))).toBe(true)
  })
})
