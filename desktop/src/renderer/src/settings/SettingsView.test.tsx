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

  it('hides the Usage section on a preload without the usage bridge', () => {
    render(<SettingsView onClose={() => {}} />)
    expect(screen.queryByTestId('settings-nav-usage')).toBeNull()
  })
})
