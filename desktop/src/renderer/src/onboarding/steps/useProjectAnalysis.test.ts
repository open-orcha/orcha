// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mergeSuggestions } from './useProjectAnalysis'
import type { RosterSuggestion } from '../../../../shared/types'

const heuristic: RosterSuggestion[] = [
  {
    alias: 'atlas',
    role: 'Lead',
    focus: 'Coordination',
    is_main: true,
    rationale: 'lead'
  },
  {
    alias: 'sable',
    role: 'iOS',
    focus: 'SwiftUI views',
    is_main: false,
    rationale: 'found ios/'
  }
]

describe('mergeSuggestions', () => {
  it('tags heuristic entries source:"heuristic"', () => {
    const merged = mergeSuggestions(heuristic, [])
    expect(merged).toEqual(heuristic.map((s) => ({ ...s, source: 'heuristic' })))
  })

  it('appends analysis-only agents tagged source:"claude"', () => {
    const merged = mergeSuggestions(heuristic, [
      {
        alias: 'ripple',
        role: 'Backend',
        focus: 'API routes',
        rationale: 'found api/'
      }
    ])
    expect(merged).toHaveLength(3)
    const claudeEntry = merged.find((s) => s.alias === 'ripple')
    expect(claudeEntry).toEqual({
      alias: 'ripple',
      role: 'Backend',
      focus: 'API routes',
      rationale: 'found api/',
      is_main: false,
      source: 'claude'
    })
  })

  it('dedupes by alias case-insensitively — heuristic wins the slot', () => {
    const merged = mergeSuggestions(heuristic, [
      { alias: 'Sable', role: 'duplicate', focus: 'dup', rationale: 'dup' },
      { alias: 'ripple', role: 'Backend', focus: 'API routes', rationale: 'x' }
    ])
    expect(merged).toHaveLength(3)
    const sable = merged.find((s) => s.alias === 'sable')
    expect(sable?.source).toBe('heuristic')
    expect(sable?.role).toBe('iOS') // heuristic's own role/focus/rationale survive, not the duplicate's
  })

  it('handles an empty heuristic list', () => {
    const merged = mergeSuggestions([], [{ alias: 'ripple', role: 'Backend', focus: 'x', rationale: 'y' }])
    expect(merged).toEqual([
      {
        alias: 'ripple',
        role: 'Backend',
        focus: 'x',
        rationale: 'y',
        is_main: false,
        source: 'claude'
      }
    ])
  })

  it('handles no analysis agents', () => {
    expect(mergeSuggestions(heuristic, [])).toEqual(heuristic.map((s) => ({ ...s, source: 'heuristic' })))
  })
})

describe('useProjectAnalysis', () => {
  it('applies the result under React StrictMode and starts the analysis only once', async () => {
    const { renderHook, waitFor } = await import('@testing-library/react')
    const { StrictMode, createElement } = await import('react')
    const { vi } = await import('vitest')
    const { useProjectAnalysis } = await import('./useProjectAnalysis')
    const analyzeProject = vi.fn().mockResolvedValue({ ok: true, summary: 's', agents: [] })
    window.orchaDesktop = { analyzeProject } as never
    const { result } = renderHook(() => useProjectAnalysis('/proj'), {
      wrapper: ({ children }) => createElement(StrictMode, null, children)
    })
    await waitFor(() => expect(result.current.kind).toBe('done'))
    expect(analyzeProject).toHaveBeenCalledTimes(1)
  })
})
