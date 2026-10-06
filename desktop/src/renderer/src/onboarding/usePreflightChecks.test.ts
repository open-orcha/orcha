// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { setupIssues, usePreflightChecks, type PreflightChecks } from './usePreflightChecks'

const ALL = { homebrew: true, dockerEngine: true, orcha: true, claude: true, codex: false }

beforeEach(() => {
  window.orchaDesktop = {
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    probePrereqs: vi.fn().mockResolvedValue(ALL)
  } as never
})

function base(over: Partial<PreflightChecks> = {}): PreflightChecks {
  return {
    report: { docker: 'ok', autoStarted: false, hint: null },
    probe: ALL,
    checking: false,
    probeLoading: false,
    slow: false,
    stuck: false,
    waitedS: 0,
    checkError: false,
    check: () => {},
    setProbe: () => {},
    dockerOk: true,
    aiOk: true,
    brewOk: true,
    ready: true,
    pending: false,
    ...over
  } as PreflightChecks
}

describe('usePreflightChecks', () => {
  it('probes both checks and reports ready', async () => {
    const { result } = renderHook(() => usePreflightChecks())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.checking).toBe(false)
    expect(window.orchaDesktop.preflight).toHaveBeenCalledTimes(1)
  })

  it('does nothing while disabled (first run runs its own visible Setup step)', () => {
    const { result } = renderHook(() => usePreflightChecks(false))
    expect(window.orchaDesktop.preflight).not.toHaveBeenCalled()
    expect(result.current.checking).toBe(false)
  })
})

describe('setupIssues', () => {
  it('is empty when everything is present, or while a check is still pending normally', () => {
    expect(setupIssues(base())).toEqual([])
    expect(setupIssues(base({ report: null, checking: true, pending: true }))).toEqual([])
  })

  it('names each missing requirement with its fix', () => {
    const issues = setupIssues(
      base({
        report: { docker: 'daemon-down', autoStarted: false, hint: null },
        probe: { ...ALL, homebrew: false, claude: false, codex: false, orcha: false }
      })
    )
    expect(issues.map((i) => i.key)).toEqual(['docker', 'homebrew', 'ai', 'helper'])
    expect(issues[0].title).toMatch(/isn.t running/)
    expect(issues[3].title).toMatch(/embodent command-line helper/i)
  })

  it('distinguishes not installed, not responding and a stuck check', () => {
    expect(setupIssues(base({ report: { docker: 'not-installed', autoStarted: false, hint: null } }))[0].title).toMatch(
      /isn.t installed/
    )
    expect(
      setupIssues(base({ report: { docker: 'daemon-down', autoStarted: false, hint: null, unresponsive: true } }))[0].title
    ).toMatch(/isn.t responding/)
    expect(setupIssues(base({ report: null, stuck: true, checking: true }))[0].title).toMatch(/isn.t responding/)
    expect(setupIssues(base({ checkError: true }))[0].key).toBe('check')
  })
})
