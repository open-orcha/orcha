// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UsagePopover, { popoverProviders } from './UsagePopover'
import UsageIndicator, { shownProviders, usageRowVisible } from './UsageIndicator'
import { DEFAULT_PLAN_USAGE_DISPLAY, type PlanUsageDisplay, type PlanUsageProviders } from '../../../shared/usage'
import { claude, codex, gemini, NOW, snapshot, usageValue } from './fixtures'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('UsagePopover', () => {
  it('Detailed: logo, plan, reset countdown and one bar per window (per-model included)', () => {
    render(<UsagePopover usage={usageValue(snapshot([claude(), codex()]))} onOpenDetails={vi.fn()} onManageAccounts={vi.fn()} />)
    const row = screen.getByTestId('usage-row-claude')
    expect(row.querySelector('[data-logo="claude"]')).not.toBeNull()
    expect(within(row).getByText('Max')).toBeTruthy()
    expect(within(row).getByText('5h resets in 1h 45m')).toBeTruthy()
    // every window says what is left and when it refills; weekly shows its own reset
    const wk = row.querySelector('[data-window-remain="wk"]')!.textContent!
    expect(wk).toMatch(/^23% left · resets .+ · in 3d$/)
    expect(row.querySelector('[data-window-remain="5h"]')!.textContent).toMatch(/^90% left · resets .+ · in 1h 45m$/)
    // a window whose reset the provider didn't give shows only what is left
    expect(row.querySelector('[data-window-remain="wk:fable"]')!.textContent).toBe('76% left')
    const meters = within(row).getAllByRole('meter')
    expect(meters.map((m) => m.getAttribute('aria-valuenow'))).toEqual(['10', '77', '24'])
    expect(meters.map((m) => m.getAttribute('data-tone'))).toEqual(['neutral', 'warn', 'neutral'])
    expect(within(row).getByText('Fable')).toBeTruthy()
    // Codex weekly at 95 % is red
    const cx = within(screen.getByTestId('usage-row-codex')).getAllByRole('meter')
    expect(cx[1].getAttribute('data-tone')).toBe('danger')
  })

  it('Compact: one line per provider with its windows, and toggling saves the mode', async () => {
    vi.useRealTimers()
    const update = vi.fn()
    const s = snapshot([claude(), codex()], { prefs: { version: 1, trayTitle: true, popoverMode: 'compact', providers: {} } })
    render(<UsagePopover usage={usageValue(s, { update })} onOpenDetails={vi.fn()} onManageAccounts={vi.fn()} />)
    expect(within(screen.getByTestId('usage-row-claude')).getByText('5h 10% · wk 77%')).toBeTruthy()
    expect(within(screen.getByTestId('usage-row-claude')).getAllByRole('meter')).toHaveLength(1)
    await userEvent.click(screen.getByTestId('usage-mode-detailed'))
    expect(update).toHaveBeenCalledWith({ op: 'popoverMode', mode: 'detailed' })
  })

  it('provider states: sign-in expired, limits off (Enable → details), not installed hidden', async () => {
    vi.useRealTimers()
    const onOpenDetails = vi.fn()
    const s = snapshot([
      claude({ limits: { status: 'expired', windows: [], source: 'x', fetchedAt: NOW, note: 'Sign-in expired — run `claude` once to refresh it.' } }),
      codex({ limits: { status: 'unavailable', windows: [], source: 'Codex session log', fetchedAt: null, note: 'No rate-limit record in the Codex logs yet — run Codex once.' } }),
      gemini()
    ])
    const { rerender } = render(<UsagePopover usage={usageValue(s)} onOpenDetails={onOpenDetails} onManageAccounts={vi.fn()} />)
    expect(within(screen.getByTestId('usage-row-claude')).getByText('Sign-in expired')).toBeTruthy()
    expect(screen.queryByTestId('usage-row-gemini')).toBeNull()
    const off = snapshot([claude({ limitsEnabled: false, limits: { status: 'off', windows: [], source: null, fetchedAt: null, note: 'Off' } })])
    rerender(<UsagePopover usage={usageValue(off)} onOpenDetails={onOpenDetails} onManageAccounts={vi.fn()} />)
    await userEvent.click(screen.getByTestId('usage-enable-limits-claude'))
    expect(onOpenDetails).toHaveBeenCalledWith('claude')
  })

  it('refresh, chevron, "Usage details & history" and "Manage Accounts…"', async () => {
    vi.useRealTimers()
    const refresh = vi.fn()
    const onOpenDetails = vi.fn()
    const onManageAccounts = vi.fn()
    render(<UsagePopover usage={usageValue(snapshot([claude()]), { refresh })} onOpenDetails={onOpenDetails} onManageAccounts={onManageAccounts} />)
    await userEvent.click(screen.getByTestId('usage-refresh'))
    expect(refresh).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Claude usage details' }))
    expect(onOpenDetails).toHaveBeenLastCalledWith('claude')
    await userEvent.click(screen.getByTestId('usage-open-details'))
    expect(onOpenDetails).toHaveBeenLastCalledWith()
    await userEvent.click(screen.getByTestId('usage-manage-accounts'))
    expect(onManageAccounts).toHaveBeenCalled()
  })

  it('says so when nothing is known yet', () => {
    render(<UsagePopover usage={usageValue(null)} onOpenDetails={vi.fn()} onManageAccounts={vi.fn()} />)
    expect(screen.getByText('Reading usage…')).toBeTruthy()
  })

  it('API-key billing: "API key · $X today" instead of windows or sign-in state', () => {
    const s = snapshot([
      claude({ billing: 'api-key', limits: { status: 'signed-out', windows: [], source: 'x', fetchedAt: NOW, note: 'No Claude Code sign-in found on this Mac' } }),
      codex()
    ])
    render(<UsagePopover usage={usageValue(s)} onOpenDetails={vi.fn()} onManageAccounts={vi.fn()} />)
    const row = screen.getByTestId('usage-row-claude')
    expect(row.getAttribute('data-billing')).toBe('api-key')
    expect(within(row).getByText('API key · $2.50 today')).toBeTruthy()
    expect(within(row).queryByRole('meter')).toBeNull()
    expect(row.textContent).not.toMatch(/sign-in|Not signed in|Max/)
    // the header peak ignores the API-billed provider (Codex 95 % stays)
    expect(screen.getByLabelText('Highest window 95 percent')).toBeTruthy()
    expect(screen.getByTestId('usage-row-codex').getAttribute('data-billing')).toBe('plan')
  })

  it('API-key billing, compact: the same one line', () => {
    const s = snapshot([codex({ billing: 'api-key' })], { prefs: { version: 1, trayTitle: true, popoverMode: 'compact', providers: {} } })
    render(<UsagePopover usage={usageValue(s)} onOpenDetails={vi.fn()} onManageAccounts={vi.fn()} />)
    expect(within(screen.getByTestId('usage-row-codex')).getByText('API key · $2.50 today')).toBeTruthy()
    expect(within(screen.getByTestId('usage-row-codex')).queryByRole('meter')).toBeNull()
  })

  it('lists installed or tracked providers only', () => {
    expect(popoverProviders([claude(), gemini(), codex({ enabled: false, state: 'off' })]).map((p) => p.id)).toEqual(['claude'])
  })
})

const shown = (providers: PlanUsageProviders = 'both'): PlanUsageDisplay => ({ show: true, providers, updatedAt: '2026-09-30T14:00:00Z' })

describe('UsageIndicator', () => {
  it('is hidden by default: the setting off, or not known yet', () => {
    const s = snapshot([claude(), codex()])
    const { rerender } = render(<UsageIndicator snapshot={s} display={null} open={false} collapsed={false} onToggle={vi.fn()} />)
    expect(screen.queryByTestId('usage-indicator')).toBeNull()
    rerender(<UsageIndicator snapshot={s} display={DEFAULT_PLAN_USAGE_DISPLAY} open={false} collapsed={false} onToggle={vi.fn()} />)
    expect(screen.queryByTestId('usage-indicator')).toBeNull()
    rerender(<UsageIndicator snapshot={s} display={DEFAULT_PLAN_USAGE_DISPLAY} open={false} collapsed onToggle={vi.fn()} />)
    expect(screen.queryByTestId('usage-indicator')).toBeNull()
    expect(usageRowVisible(null)).toBe(false)
    expect(usageRowVisible(DEFAULT_PLAN_USAGE_DISPLAY)).toBe(false)
    expect(usageRowVisible(shown())).toBe(true)
  })

  it('both: each provider’s logo and percent side by side, toned, no bar — the label lists both', async () => {
    vi.useRealTimers()
    const onToggle = vi.fn()
    render(<UsageIndicator snapshot={snapshot([claude(), codex()])} display={shown('both')} open={false} collapsed={false} onToggle={onToggle} />)
    const b = screen.getByTestId('usage-indicator')
    expect(b.getAttribute('aria-label')).toBe('Usage: Claude 77%, Codex 95%')
    expect(b.textContent).toContain('Usage')
    const cl = b.querySelector('[data-usage-provider="claude"]')!
    const cx = b.querySelector('[data-usage-provider="codex"]')!
    expect(cl.querySelector('[data-logo="claude"]')).not.toBeNull()
    expect(cl.textContent).toBe('77%')
    expect(cl.querySelector('.text-warning')).not.toBeNull()
    expect(cx.querySelector('[data-logo="codex"]')).not.toBeNull()
    expect(cx.textContent).toBe('95%')
    expect(cx.querySelector('.text-danger')).not.toBeNull()
    expect(b.querySelector('[role="meter"]')).toBeNull()
    await userEvent.click(b)
    expect(onToggle).toHaveBeenCalled()
  })

  it('both, one without data: only the provider with data shows', () => {
    const s = snapshot([claude(), codex({ limits: { status: 'unavailable', windows: [], source: null, fetchedAt: null } })])
    render(<UsageIndicator snapshot={s} display={shown('both')} open={false} collapsed={false} onToggle={vi.fn()} />)
    const b = screen.getByTestId('usage-indicator')
    expect(b.getAttribute('aria-label')).toBe('Usage: Claude 77%')
    expect(b.querySelector('[data-logo="codex"]')).toBeNull()
  })

  it('one provider: only that provider — logo, thin bar and percent — even when the other is busier', () => {
    const s = snapshot([claude(), codex()])
    const { rerender } = render(<UsageIndicator snapshot={s} display={shown('claude')} open={false} collapsed={false} onToggle={vi.fn()} />)
    let b = screen.getByTestId('usage-indicator')
    expect(b.getAttribute('aria-label')).toBe('Usage: Claude 77%')
    expect(b.querySelector('[data-logo="claude"]')).not.toBeNull()
    expect(b.querySelector('[data-logo="codex"]')).toBeNull()
    expect(b.querySelector('[role="meter"]')?.getAttribute('data-tone')).toBe('warn')
    expect(b.textContent).toContain('77%')
    rerender(<UsageIndicator snapshot={s} display={shown('codex')} open={false} collapsed={false} onToggle={vi.fn()} />)
    b = screen.getByTestId('usage-indicator')
    expect(b.getAttribute('aria-label')).toBe('Usage: Codex 95%')
    expect(b.querySelector('[data-logo="claude"]')).toBeNull()
    expect(b.querySelector('[role="meter"]')?.getAttribute('data-tone')).toBe('danger')
  })

  it('collapsed: the gauge with the peak of the chosen providers', () => {
    const s = snapshot([claude(), codex()])
    const { rerender } = render(<UsageIndicator snapshot={s} display={shown('both')} open={false} collapsed onToggle={vi.fn()} />)
    expect(screen.getByTestId('usage-indicator').textContent).toBe('95')
    expect(screen.getByTestId('usage-indicator').getAttribute('aria-label')).toBe('Usage: Claude 77%, Codex 95%')
    rerender(<UsageIndicator snapshot={s} display={shown('claude')} open={false} collapsed onToggle={vi.fn()} />)
    expect(screen.getByTestId('usage-indicator').textContent).toBe('77')
  })

  it('no known windows: a plain "Usage" entry', () => {
    render(<UsageIndicator snapshot={snapshot([gemini()])} display={shown()} open={false} collapsed onToggle={vi.fn()} />)
    expect(screen.getByTestId('usage-indicator').getAttribute('aria-label')).toBe('Usage')
  })

  it('API-key billing, one provider: logo + "$X today", no bar', () => {
    const s = snapshot([claude({ billing: 'api-key' }), codex()])
    render(<UsageIndicator snapshot={s} display={shown('claude')} open={false} collapsed={false} onToggle={vi.fn()} />)
    const b = screen.getByTestId('usage-indicator')
    expect(b.querySelector('[data-logo="claude"]')).not.toBeNull()
    expect(b.querySelector('[data-billing="api-key"]')!.textContent).toBe('$2.50 today')
    expect(b.querySelector('[role="meter"]')).toBeNull()
    expect(b.getAttribute('aria-label')).toBe('Usage: Claude API key, $2.50 today')
  })

  it('API-key billing, both: the key provider shows its spend next to the other’s percent', () => {
    const s = snapshot([claude(), codex({ billing: 'api-key', limits: null })])
    const { rerender } = render(<UsageIndicator snapshot={s} display={shown('both')} open={false} collapsed={false} onToggle={vi.fn()} />)
    const b = screen.getByTestId('usage-indicator')
    expect(b.querySelector('[data-usage-provider="claude"]')!.textContent).toBe('77%')
    const cx = b.querySelector('[data-usage-provider="codex"]')!
    expect(cx.getAttribute('data-billing')).toBe('api-key')
    expect(cx.querySelector('[data-logo="codex"]')).not.toBeNull()
    expect(cx.textContent).toBe('$2.50 today')
    // collapsed: the gauge's number is the plan provider's percent only
    rerender(<UsageIndicator snapshot={s} display={shown('both')} open={false} collapsed onToggle={vi.fn()} />)
    expect(screen.getByTestId('usage-indicator').textContent).toBe('77')
  })

  it('shownProviders: Claude first, chosen ones only, missing data left out', () => {
    const s = snapshot([codex(), claude(), gemini()])
    expect(shownProviders(s, 'both').map((x) => [x.p.id, x.pct])).toEqual([
      ['claude', 77],
      ['codex', 95]
    ])
    expect(shownProviders(s, 'codex').map((x) => x.p.id)).toEqual(['codex'])
    expect(shownProviders(null, 'both')).toEqual([])
  })
})
