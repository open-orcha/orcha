// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsView, { NOTIFICATION_SETTINGS_PATH } from './SettingsView'

describe('SettingsView › Notifications', () => {
  it('lists Notifications next to Agents and explains that desktop alerts follow the portal settings', () => {
    render(<SettingsView onClose={() => {}} initialSection="notifications" notificationsProject="todo-app" onOpenNotificationSettings={() => {}} />)
    expect(screen.getByTestId('settings-nav-agents')).toHaveTextContent('Agents')
    expect(screen.getByTestId('settings-nav-notifications')).toHaveAttribute('aria-current', 'page')
    const section = screen.getByTestId('settings-notifications')
    expect(section).toHaveTextContent('Desktop alerts follow your Embodent notification settings')
    expect(section).toHaveTextContent('anything that needs you still shows in Needs you')
    expect(section).toHaveTextContent('Opens Settings › Notifications in todo-app.')
    expect(NOTIFICATION_SETTINGS_PATH).toBe('/settings#tab=notifications')
  })

  it('opens the portal preferences for the running project', async () => {
    const open = vi.fn()
    render(<SettingsView onClose={() => {}} initialSection="notifications" notificationsProject="todo-app" onOpenNotificationSettings={open} />)
    await userEvent.click(screen.getByTestId('open-notification-settings'))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('is disabled with a plain hint when no project is running', () => {
    render(<SettingsView onClose={() => {}} initialSection="notifications" />)
    expect(screen.getByTestId('open-notification-settings')).toBeDisabled()
    expect(screen.getByTestId('settings-notifications')).toHaveTextContent('Start a project to change them')
  })
})

describe('SettingsView › Usage', () => {
  it('toggles the menu-bar usage title and opens Stats & Usage', async () => {
    const { snapshot, claude, usageValue } = await import('../usage/fixtures')
    const update = vi.fn()
    const onOpenStats = vi.fn()
    render(<SettingsView onClose={() => {}} initialSection="usage" usage={usageValue(snapshot([claude()]), { update })} onOpenStats={onOpenStats} />)
    expect(screen.getByTestId('settings-nav-usage')).toHaveAttribute('aria-current', 'page')
    await userEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(update).toHaveBeenCalledWith({ op: 'trayTitle', on: false })
    await userEvent.click(screen.getByTestId('settings-open-stats'))
    expect(onOpenStats).toHaveBeenCalledTimes(1)
  })

  it('"Show plan usage" sits at the top, off by default, with Providers disabled until it is on', async () => {
    const { snapshot, claude, usageValue } = await import('../usage/fixtures')
    const setDisplay = vi.fn()
    const display = { show: false, providers: 'both' as const, updatedAt: null }
    const { rerender } = render(
      <SettingsView onClose={() => {}} initialSection="usage" usage={usageValue(snapshot([claude()]), { display, setDisplay })} />
    )
    const block = screen.getByTestId('plan-usage-display')
    expect(screen.getByTestId('settings-usage').querySelector('[data-testid]')).toBe(block)
    expect(block).toHaveTextContent('on every device connected to this Embodent')
    const sw = screen.getByRole('switch', { name: 'Show plan usage' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('plan-usage-providers-claude')).toBeDisabled()
    await userEvent.click(sw)
    expect(setDisplay).toHaveBeenCalledWith({ show: true, providers: 'both' })

    rerender(
      <SettingsView
        onClose={() => {}}
        initialSection="usage"
        usage={usageValue(snapshot([claude()]), { display: { ...display, show: true }, setDisplay })}
      />
    )
    expect(screen.getByRole('switch', { name: 'Show plan usage' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('plan-usage-providers-both')).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByTestId('plan-usage-providers-codex'))
    expect(setDisplay).toHaveBeenLastCalledWith({ show: true, providers: 'codex' })
  })

  it('the switch waits for the setting to load', async () => {
    const { snapshot, claude, usageValue } = await import('../usage/fixtures')
    render(<SettingsView onClose={() => {}} initialSection="usage" usage={usageValue(snapshot([claude()]))} />)
    expect(screen.getByRole('switch', { name: 'Show plan usage' })).toBeDisabled()
  })

  it('hides the Usage section on a preload without the usage bridge', () => {
    render(<SettingsView onClose={() => {}} />)
    expect(screen.queryByTestId('settings-nav-usage')).toBeNull()
  })
})

describe('SettingsView › Usage › billing', () => {
  it('shows a provider on API-key billing as "API key" with today’s spend, the other on its plan', async () => {
    const { snapshot, claude, codex, usageValue, NOW } = await import('../usage/fixtures')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    try {
      render(
        <SettingsView
          onClose={() => {}}
          initialSection="usage"
          usage={usageValue(snapshot([claude({ billing: 'api-key', limits: { status: 'signed-out', windows: [], source: null, fetchedAt: null } }), codex()]))}
        />
      )
      const cl = screen.getByTestId('settings-billing-claude')
      expect(cl).toHaveAttribute('data-billing', 'api-key')
      expect(cl).toHaveTextContent('API key · $2.50 today')
      expect(cl).not.toHaveTextContent(/signed/i)
      expect(screen.getByTestId('settings-billing-codex')).toHaveTextContent('Plus · wk 95% used')
    } finally {
      vi.useRealTimers()
    }
  })
})
