// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UsagePopover, { popoverProviders } from './UsagePopover'
import UsageIndicator from './UsageIndicator'
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

  it('lists installed or tracked providers only', () => {
    expect(popoverProviders([claude(), gemini(), codex({ enabled: false, state: 'off' })]).map((p) => p.id)).toEqual(['claude'])
  })
})

describe('UsageIndicator', () => {
  it('shows the busiest window with its provider logo and tone', async () => {
    vi.useRealTimers()
    const onToggle = vi.fn()
    render(<UsageIndicator snapshot={snapshot([claude(), codex()])} open={false} collapsed={false} onToggle={onToggle} />)
    const b = screen.getByTestId('usage-indicator')
    expect(b.textContent).toContain('95%')
    expect(b.querySelector('[data-logo="codex"]')).not.toBeNull()
    expect(b.querySelector('[role="meter"]')?.getAttribute('data-tone')).toBe('danger')
    await userEvent.click(b)
    expect(onToggle).toHaveBeenCalled()
  })
  it('no known windows: a plain "Usage" entry', () => {
    render(<UsageIndicator snapshot={snapshot([gemini()])} open={false} collapsed onToggle={vi.fn()} />)
    expect(screen.getByTestId('usage-indicator').getAttribute('aria-label')).toBe('Usage')
  })
})
