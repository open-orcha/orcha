// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DesktopDictation, { NO_PROJECT_MESSAGE, desktopDictationDeps, firstContainerId } from './DesktopDictation'

describe('desktop dictation goes through a running project', () => {
  it('finds the container id in either /api/containers shape', () => {
    expect(firstContainerId([{ id: 'c1' }])).toBe('c1')
    expect(firstContainerId({ containers: [{ container_id: 'c2' }] })).toBe('c2')
    expect(firstContainerId({})).toBeNull()
  })

  it('status + clean-up use the portal IPC; audio goes to that portal’s origin', async () => {
    const portalGet = vi.fn(async (_p: number, path: string) => (path === '/api/containers' ? [{ id: 'c9' }] : { cloud_available: true }))
    const portalPost = vi.fn(async () => ({ text: 'Tidy.' }))
    const d = desktopDictationDeps(8123, null, { portalGet, portalPost })
    await expect(d.getCid!()).resolves.toBe('c9')
    expect(d.getBaseUrl!()).toBe('http://localhost:8123')
    await d.getStatus('c9')
    expect(portalGet).toHaveBeenCalledWith(8123, '/api/containers/c9/voice/status')
    await expect(d.cleanup('c9', 'tidy', true, 'en')).resolves.toBe('Tidy.')
    expect(portalPost).toHaveBeenCalledWith(8123, '/api/containers/c9/voice/cleanup', { text: 'tidy', single_line: true, language: 'en' })
    expect(d.deviceSupported!()).toBe(false)
  })

  it('a known container id skips the lookup', async () => {
    const portalGet = vi.fn()
    const d = desktopDictationDeps(8123, 'c1', { portalGet })
    await expect(d.getCid!()).resolves.toBe('c1')
    expect(portalGet).not.toHaveBeenCalled()
  })

  it('no running project → no cid and a plain message', () => {
    const d = desktopDictationDeps(null, null, {})
    expect(d.getCid!()).toBeNull()
    expect(d.noEngineMessage!()).toBe(NO_PROJECT_MESSAGE)
  })
})


describe('DesktopDictation in the app shell', () => {
  it('with no running project, ⌥Space in a desktop field explains plainly (never opens the mic)', async () => {
    const getUserMedia = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    render(
      <DesktopDictation apiPort={null}>
        <input aria-label="Project description" />
      </DesktopDictation>
    )
    const input = screen.getByLabelText('Project description')
    act(() => input.focus())
    await act(async () => {
      fireEvent.keyDown(input, { key: ' ', code: 'Space', altKey: true })
      fireEvent.keyUp(input, { key: 'Alt', code: 'AltLeft' })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect((await screen.findByRole('group', { name: 'Dictation' })).textContent).toContain('Start a project to dictate here')
    expect(getUserMedia).not.toHaveBeenCalled()
    cleanup()
  })
})
