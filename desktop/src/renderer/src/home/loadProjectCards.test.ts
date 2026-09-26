import { describe, it, expect, vi } from 'vitest'
import { loadProjectCards } from './loadProjectCards'
import type { Stack } from '../../../shared/types'

function stack(over: Partial<Stack> = {}): Stack {
  return {
    project: 'orcha-demo',
    projectShort: 'demo',
    apiPort: 8001,
    dbPort: 5432,
    portalStatus: 'Up',
    running: true,
    folder: '/tmp/demo',
    ...over
  }
}

describe('loadProjectCards', () => {
  it('flattens one card per container across all running stacks', async () => {
    const s1 = stack({ project: 'orcha-a', apiPort: 8001 })
    const s2 = stack({ project: 'orcha-b', apiPort: 8002 })
    const portalGet = vi.fn(async (port: number) => {
      if (port === 8001) return { containers: [{ id: 'c1', name: 'A' }] }
      return { containers: [{ id: 'c2', name: 'B1' }, { id: 'c3', name: 'B2' }] }
    })
    const cards = await loadProjectCards([s1, s2], portalGet)
    expect(cards).toHaveLength(3)
    expect(cards.map((c) => c.container.id)).toEqual(['c1', 'c2', 'c3'])
    expect(cards[1].stack.project).toBe('orcha-b')
  })

  it('skips stopped stacks entirely (no fetch)', async () => {
    const running = stack({ project: 'orcha-a', running: true, apiPort: 8001 })
    const stopped = stack({ project: 'orcha-b', running: false, apiPort: null })
    const portalGet = vi.fn().mockResolvedValue({ containers: [{ id: 'c1' }] })
    const cards = await loadProjectCards([running, stopped], portalGet)
    expect(portalGet).toHaveBeenCalledTimes(1)
    expect(portalGet).toHaveBeenCalledWith(8001, '/api/containers')
    expect(cards).toHaveLength(1)
  })

  it('never throws — a failing stack contributes no cards, others still resolve', async () => {
    const ok = stack({ project: 'orcha-a', apiPort: 8001 })
    const bad = stack({ project: 'orcha-b', apiPort: 8002 })
    const portalGet = vi.fn(async (port: number) => {
      if (port === 8002) throw new Error('portal not ready')
      return { containers: [{ id: 'c1' }] }
    })
    const cards = await loadProjectCards([ok, bad], portalGet)
    expect(cards).toHaveLength(1)
    expect(cards[0].container.id).toBe('c1')
  })

  it('returns [] when there are no running stacks', async () => {
    const portalGet = vi.fn()
    const cards = await loadProjectCards([stack({ running: false, apiPort: null })], portalGet)
    expect(cards).toEqual([])
    expect(portalGet).not.toHaveBeenCalled()
  })

  it('treats a missing/malformed containers field as empty', async () => {
    const s = stack()
    const portalGet = vi.fn().mockResolvedValue({})
    expect(await loadProjectCards([s], portalGet)).toEqual([])
  })
})
