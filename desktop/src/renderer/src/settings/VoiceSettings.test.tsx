// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MicApi } from '../../../shared/mic'
import { readVoicePrefs } from '../dictation/prefs'
import VoiceSettings from './VoiceSettings'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const api = (status: MicApi['status'] extends () => Promise<infer S> ? S : never, ask: 'granted' | 'denied' = 'granted'): MicApi => ({
  status: vi.fn(async () => status),
  request: vi.fn(async () => ask),
  openSettings: vi.fn(async () => true)
})

describe('Settings › Voice (desktop)', () => {
  it('asks macOS for the microphone when not yet asked', async () => {
    const a = api('not-determined')
    render(<VoiceSettings api={a} project="todo-app" />)
    expect(await screen.findByText('Not asked yet')).toBeTruthy()
    fireEvent.click(screen.getByTestId('voice-mic-allow'))
    await waitFor(() => expect(screen.getByTestId('voice-mic-status').textContent).toContain('Allowed'))
    expect(a.request).toHaveBeenCalled()
  })

  it('blocked → opens System Settings › Microphone', async () => {
    const a = api('denied')
    render(<VoiceSettings api={a} />)
    fireEvent.click(await screen.findByTestId('voice-mic-open'))
    expect(a.openSettings).toHaveBeenCalled()
  })

  it('turns dictation off for this app, changes the shortcut, and links to the project voice settings', async () => {
    const open = vi.fn()
    render(<VoiceSettings api={api('granted')} project="todo-app" onOpenProjectVoice={open} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(readVoicePrefs().engine).toBe('off')
    fireEvent.change(screen.getByLabelText('Dictation shortcut'), { target: { value: 'ctrl+shift+space' } })
    expect(readVoicePrefs().shortcut).toBe('ctrl+shift+space')
    fireEvent.click(screen.getByTestId('voice-open-project'))
    expect(open).toHaveBeenCalled()
    expect(screen.getByText(/Audio is never stored/)).toBeTruthy()
  })
})
