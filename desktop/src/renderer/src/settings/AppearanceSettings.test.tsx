// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AppearanceSettings from './AppearanceSettings'
import SettingsView from './SettingsView'
import type { ThemeApi, ThemeState } from '../../../shared/theme'

function fakeApi(initial: ThemeState) {
  let cb: ((s: ThemeState) => void) | null = null
  const api: ThemeApi & { emit(s: ThemeState): void } = {
    get: vi.fn(async () => initial),
    set: vi.fn(async (mode) => ({ mode, resolved: mode === 'light' ? 'light' : 'dark' }) as ThemeState),
    onChanged: vi.fn((f) => {
      cb = f
      return () => {
        cb = null
      }
    }),
    emit: (s) => cb?.(s)
  }
  return api
}

afterEach(() => {
  delete (window as { orchaDesktop?: unknown }).orchaDesktop
})

describe('Settings › Appearance', () => {
  it('shows System / Light / Dark as one radio group with the stored mode checked', async () => {
    render(<AppearanceSettings api={fakeApi({ mode: 'dark', resolved: 'dark' })} />)
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(group).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true'))
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false')
    // roving tabindex: only the checked option is in the tab order
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('tabindex', '-1')
  })

  it('choosing Light sends it to main and checks it', async () => {
    const api = fakeApi({ mode: 'dark', resolved: 'dark' })
    render(<AppearanceSettings api={api} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Light' })).toBeEnabled())
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(api.set).toHaveBeenCalledWith('light')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true'))
  })

  it('arrow keys move the choice (radio-group keyboard model)', async () => {
    const api = fakeApi({ mode: 'system', resolved: 'light' })
    render(<AppearanceSettings api={api} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true'))
    screen.getByRole('radio', { name: 'System' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(api.set).toHaveBeenLastCalledWith('light')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus()
  })

  it('System says what macOS resolves to now, and follows a live change from main', async () => {
    const api = fakeApi({ mode: 'system', resolved: 'dark' })
    render(<AppearanceSettings api={api} />)
    await waitFor(() => expect(screen.getByTestId('settings-appearance')).toHaveTextContent('Follows macOS — dark right now.'))
    act(() => api.emit({ mode: 'system', resolved: 'light' }))
    expect(screen.getByTestId('settings-appearance')).toHaveTextContent('Follows macOS — light right now.')
  })

  it('reports a failed save instead of pretending', async () => {
    const api = fakeApi({ mode: 'dark', resolved: 'dark' })
    api.set = vi.fn(async () => {
      throw { code: 'INVALID_THEME' }
    })
    render(<AppearanceSettings api={api} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Light' })).toBeEnabled())
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t save the appearance')
  })

  it('is a Settings section when the preload has the theme bridge, hidden otherwise', async () => {
    const { unmount } = render(<SettingsView onClose={() => {}} />)
    expect(screen.queryByTestId('settings-nav-appearance')).toBeNull()
    unmount()
    ;(window as { orchaDesktop?: unknown }).orchaDesktop = { theme: fakeApi({ mode: 'light', resolved: 'light' }) }
    render(<SettingsView onClose={() => {}} />)
    await userEvent.click(screen.getByTestId('settings-nav-appearance'))
    expect(screen.getByTestId('settings-nav-appearance')).toHaveAttribute('aria-current', 'page')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true'))
  })
})
