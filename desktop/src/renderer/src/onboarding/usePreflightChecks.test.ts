// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { setupIssues, usePreflightChecks, type PreflightChecks } from './usePreflightChecks'

const ALL = { homebrew: false, dockerEngine: false, orcha: true, claude: true, codex: false }

beforeEach(() => {
  window.orchaDesktop = {
    preflight: vi.fn().mockResolvedValue({ docker: 'not-installed', autoStarted: false, hint: null }),
    probePrereqs: vi.fn().mockResolvedValue(ALL)
  } as never
})

function base(over: Partial<PreflightChecks> = {}): PreflightChecks {
  return {
    probe: ALL,
    checking: false,
    probeLoading: false,
    checkError: false,
    check: () => {},
    setProbe: () => {},
    aiOk: true,
    ready: true,
    pending: false,
    ...over
  }
}

describe('usePreflightChecks', () => {
  it('is ready with no Docker and no Homebrew (GH #258: projects run natively)', async () => {
    const { result } = renderHook(() => usePreflightChecks())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.checking).toBe(false)
    expect(window.orchaDesktop.probePrereqs).toHaveBeenCalledTimes(1)
    // Docker is never probed during setup any more
    expect(window.orchaDesktop.preflight).not.toHaveBeenCalled()
  })

  it('does nothing while disabled (first run runs its own visible Setup step)', () => {
    const { result } = renderHook(() => usePreflightChecks(false))
    expect(window.orchaDesktop.probePrereqs).not.toHaveBeenCalled()
    expect(result.current.checking).toBe(false)
  })

  it('reports a failed check as checkError', async () => {
    window.orchaDesktop.probePrereqs = vi.fn().mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => usePreflightChecks())
    await waitFor(() => expect(result.current.checkError).toBe(true))
    expect(result.current.ready).toBe(false)
  })
})

describe('setupIssues', () => {
  it('is empty when everything is present, or while a check is still pending normally', () => {
    expect(setupIssues(base())).toEqual([])
    expect(setupIssues(base({ probe: null, checking: true, pending: true }))).toEqual([])
  })

  it('names each missing requirement with its fix — never Docker or Homebrew', () => {
    const issues = setupIssues(base({ probe: { ...ALL, claude: false, codex: false, orcha: false } }))
    expect(issues.map((i) => i.key)).toEqual(['ai', 'helper'])
    expect(issues[1].title).toMatch(/embodent command-line helper/i)
    expect(setupIssues(base({ checkError: true }))[0].key).toBe('check')
  })
})
