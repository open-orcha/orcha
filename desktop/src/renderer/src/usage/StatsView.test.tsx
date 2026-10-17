// @vitest-environment jsdom
// Local-calendar maths below assume UTC (works under both the node and web tsconfigs).
;(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'UTC'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StatsView from './StatsView'
import { claude, codex, gemini, NOW, snapshot, usageValue } from './fixtures'

// Pin "today" so the 6-week heatmap window is stable.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('StatsView', () => {
  it('top cards: agents spawned, time worked, PRs, tracking since', () => {
    render(<StatsView usage={usageValue(snapshot([claude(), codex()]))} onClose={vi.fn()} />)
    expect(within(screen.getByTestId('stat-spawned')).getByText('7')).toBeTruthy()
    expect(within(screen.getByTestId('stat-time')).getByText('4h 0m')).toBeTruthy() // 2 × 7200 s from logs
    expect(within(screen.getByTestId('stat-prs')).getByText('6')).toBeTruthy()
    expect(within(screen.getByTestId('stat-since')).getByText('Aug 1, 2026')).toBeTruthy()
  })

  it('Overview cards sum providers; the dropdown narrows to one provider', async () => {
    render(<StatsView usage={usageValue(snapshot([claude(), codex()]))} onClose={vi.fn()} />)
    expect(within(screen.getByTestId('card-cost')).getByText('$25.00')).toBeTruthy()
    expect(within(screen.getByTestId('card-days')).getByText('2')).toBeTruthy()
    expect(within(screen.getByTestId('card-cache')).getByText('84%')).toBeTruthy()
    await userEvent.selectOptions(screen.getByTestId('usage-view-select'), 'claude')
    expect(within(screen.getByTestId('card-cost')).getByText('$12.50')).toBeTruthy()
    expect(screen.getByText('Claude usage')).toBeTruthy()
  })

  it('heatmap, best day, token mix with a reasoning chip', () => {
    render(<StatsView usage={usageValue(snapshot([claude()]))} onClose={vi.fn()} />)
    expect(screen.getByTestId('usage-heatmap').querySelectorAll('[role="gridcell"]').length).toBe(42)
    expect(screen.getByTestId('usage-best-day').textContent).toMatch(/^Best: Sep 28/)
    expect(screen.getByTestId('usage-reasoning-chip')).toBeTruthy()
  })

  it('provider cards: Enable / Off persist through update; not-installed shown honestly', async () => {
    const update = vi.fn()
    render(<StatsView usage={usageValue(snapshot([claude(), codex(), gemini()]), { update })} onClose={vi.fn()} />)
    expect(screen.getByTestId('usage-provider-gemini').getAttribute('data-state')).toBe('not-installed')
    expect(within(screen.getByTestId('usage-provider-gemini')).getByText(/Not installed on this Mac/)).toBeTruthy()
    await userEvent.click(screen.getByTestId('usage-provider-toggle-codex'))
    expect(update).toHaveBeenCalledWith({ op: 'provider', id: 'codex', enabled: false })
    await userEvent.click(screen.getByTestId('usage-limits-toggle-claude'))
    expect(update).toHaveBeenCalledWith({ op: 'limits', id: 'claude', enabled: false })
    expect(within(screen.getByTestId('usage-limits-claude')).getByText(/Keychain/)).toBeTruthy()
  })

  it('Embodent projects list each stack’s est. spend from its metrics API', async () => {
    const portalGet = vi.fn().mockResolvedValue({ totals: { runs: 12, est_cost_usd: 4.2, tokens_in: 1000, tokens_out: 500, runs_with_cost: 10 } })
    render(
      <StatsView
        usage={usageValue(snapshot([claude()]))}
        projects={[{ key: 'k', name: 'quantal-ehr', apiPort: 8001, cid: '11111111-2222-3333-4444-555555555555' }]}
        portalGet={portalGet}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(within(screen.getByTestId('usage-projects')).getByText('$4.20')).toBeTruthy())
    expect(portalGet).toHaveBeenCalledWith(8001, '/api/containers/11111111-2222-3333-4444-555555555555/metrics')
  })

  it('Esc closes', async () => {
    const onClose = vi.fn()
    render(<StatsView usage={usageValue(snapshot([claude()]))} onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})
