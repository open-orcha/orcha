import { describe, it, expect, vi } from 'vitest'
import { AttentionPoller } from './attentionPoller'
import type { StackAttention } from './attention'
import type { AttentionItem, Stack } from '../shared/types'

const stackUp: Stack = {
  project: 'orcha-demo',
  projectShort: 'demo',
  apiPort: 8001,
  dbPort: 5433,
  portalStatus: 'Up 1 hour',
  running: true,
  folder: null,
  runtime: 'docker',
  health: 'ok'
}
const stackDown: Stack = { ...stackUp, running: false, apiPort: null, portalStatus: 'Exited (0)' }

const item = (id: string): AttentionItem => ({
  project: 'orcha-demo',
  projectShort: 'demo',
  kind: 'request_answer',
  id,
  title: `item ${id}`,
  path: `/requests?req=${id}`
})

/** A stack's fetch result carrying the given items (empty roster/counts). */
const detail = (items: AttentionItem[] = []): StackAttention => ({
  items,
  agents: [],
  tasks: { ready: 0, inProgress: 0, needsVerification: 0 }
})

function makePoller(overrides: Partial<{
  listStacks: () => Promise<Stack[]>
  fetchStackAttention: (s: Stack) => Promise<StackAttention>
}> = {}) {
  const notify = vi.fn()
  const onUpdate = vi.fn()
  const deps = {
    listStacks: overrides.listStacks ?? vi.fn(async () => [stackUp]),
    fetchStackAttention: overrides.fetchStackAttention ?? vi.fn(async () => detail()),
    notify,
    onUpdate
  }
  return { poller: new AttentionPoller(deps), notify, onUpdate, deps }
}

describe('AttentionPoller', () => {
  it('first tick is a silent baseline (no notifications, cache populated)', async () => {
    const { poller, notify, onUpdate } = makePoller({
      fetchStackAttention: vi.fn(async () => detail([item('r1')]))
    })
    await poller.tick()
    expect(notify).not.toHaveBeenCalled()
    expect(poller.current()).toEqual([item('r1')])
    expect(onUpdate).toHaveBeenCalledWith(
      [item('r1')],
      [stackUp],
      new Map([['orcha-demo', detail([item('r1')])]])
    )
  })

  it('notifies once for an item that appears after the baseline', async () => {
    const fetch = vi.fn(async () => detail())
    const { poller, notify } = makePoller({ fetchStackAttention: fetch })
    await poller.tick()                                  // baseline: empty
    fetch.mockResolvedValue(detail([item('r1')]))
    await poller.tick()                                  // r1 appears
    await poller.tick()                                  // still present
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(item('r1'))
  })

  it('re-notifies when an item disappears and reappears', async () => {
    const fetch = vi.fn(async () => detail())
    const { poller, notify } = makePoller({ fetchStackAttention: fetch })
    await poller.tick()                                  // baseline
    fetch.mockResolvedValue(detail([item('r1')]))
    await poller.tick()                                  // appears -> notify 1
    fetch.mockResolvedValue(detail())
    await poller.tick()                                  // gone
    fetch.mockResolvedValue(detail([item('r1')]))
    await poller.tick()                                  // back -> notify 2
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('does not fetch attention for stopped stacks (and omits them from details)', async () => {
    const fetch = vi.fn(async () => detail([item('r1')]))
    const { poller, onUpdate } = makePoller({
      listStacks: vi.fn(async () => [stackDown]),
      fetchStackAttention: fetch
    })
    await poller.tick()
    expect(fetch).not.toHaveBeenCalled()
    expect(poller.current()).toEqual([])
    expect(onUpdate).toHaveBeenCalledWith([], [stackDown], new Map())
  })

  it('emits health notifications on running-state transitions (after baseline only)', async () => {
    const list = vi.fn(async () => [stackUp])
    const { poller, notify } = makePoller({ listStacks: list })
    await poller.tick()                                  // baseline: up, silent
    list.mockResolvedValue([stackDown])
    await poller.tick()                                  // up -> down
    list.mockResolvedValue([stackUp])
    await poller.tick()                                  // down -> up
    const healthCalls = notify.mock.calls.map((c) => c[0]).filter((i) => i.kind === 'health')
    expect(healthCalls.map((i) => i.id)).toEqual(['health:orcha-demo:down', 'health:orcha-demo:up'])
  })

  it('a per-stack fetch failure skips that stack but the tick survives', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('api hiccup')
    })
    const { poller } = makePoller({ fetchStackAttention: fetch })
    await poller.tick()
    expect(poller.current()).toEqual([])
  })

  it('a listStacks failure (docker down) keeps the previous cache', async () => {
    const fetch = vi.fn(async () => detail([item('r1')]))
    const list = vi.fn(async () => [stackUp])
    const { poller, deps } = makePoller({ listStacks: list, fetchStackAttention: fetch })
    await poller.tick()
    ;(deps.listStacks as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'DOCKER_UNAVAILABLE' })
    await poller.tick()
    expect(poller.current()).toEqual([item('r1')])
  })

  it('ignores a tick that starts while another is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const fetch = vi.fn(async () => {
      await gate
      return detail([item('r1')])
    })
    const { poller } = makePoller({ fetchStackAttention: fetch })
    const first = poller.tick()
    await poller.tick() // overlapping tick: must be a no-op
    release()
    await first
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(poller.current()).toEqual([item('r1')])
  })

  it('snapshot() reports per-stack availability: ok with container counts, or failed (not zero)', async () => {
    let fail = false
    const { poller } = makePoller({
      fetchStackAttention: vi.fn(async () => {
        if (fail) throw new Error('down')
        return { ...detail([item('a')]), containers: [
            {
              cid: 'c1',
              name: 'Demo',
              count: 1,
              partial: false,
              live: [{ alias: 'lead', state: 'working' as const, task: 'Fix it', lastActive: null, branch: 'main' }],
              liveTotal: 1,
              checkouts: [{ branch: 'main', primary: true, detached: false, repo: 'acme/web' }]
            }
          ],
          unavailable: []
        }
      })
    })
    await poller.tick()
    const first = poller.snapshot()
    expect(first.items.map((i) => i.id)).toEqual(['a'])
    expect(first.projects).toHaveLength(1)
    expect(first.projects[0]).toMatchObject({ project: 'orcha-demo', ok: true, containers: [{ cid: 'c1', count: 1 }] })
    // D11: the container's live agents ride the same typed snapshot to the host sidebar.
    expect(first.projects[0].containers[0].live).toEqual([{ alias: 'lead', state: 'working', task: 'Fix it', lastActive: null, branch: 'main' }])
    expect(first.projects[0].containers[0].liveTotal).toBe(1)
    // D14: the real checkouts ride the same typed snapshot too.
    expect(first.projects[0].containers[0].checkouts).toEqual([{ branch: 'main', primary: true, detached: false, repo: 'acme/web' }])
    const okAt = first.projects[0].fetchedAt
    expect(okAt).not.toBeNull()

    fail = true
    await poller.tick()
    const second = poller.snapshot()
    expect(second.projects[0]).toMatchObject({ project: 'orcha-demo', ok: false, containers: [] }) // unreachable → no (stale or fake) agents
    expect(second.projects[0].fetchedAt).toBe(okAt) // last GOOD fetch time is kept
  })

  it('snapshot() omits stopped stacks (the UI shows them as stopped, not as zero)', async () => {
    const { poller } = makePoller({ listStacks: vi.fn(async () => [stackDown]) })
    await poller.tick()
    expect(poller.snapshot().projects).toEqual([])
  })
})

describe('AttentionPoller.forget (project removed)', () => {
  it('drops the project’s cached items and status, and a re-added stack starts silently', async () => {
    let stacks = [stackUp]
    const { poller, notify } = makePoller({
      listStacks: vi.fn(async () => stacks),
      fetchStackAttention: vi.fn(async () => detail([item('r1')]))
    })
    await poller.tick()
    expect(poller.current()).toHaveLength(1)
    poller.forget('orcha-demo')
    expect(poller.current()).toEqual([])
    expect(poller.snapshot().projects).toEqual([])
    // removed, then added back stopped: no "went down" alert from the stale running state
    stacks = [stackDown]
    await poller.tick()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('AttentionPoller — no notification flood when a stack drops and comes back', () => {
  const items = [item('r1'), item('r2'), item('r3')]

  it('a failed fetch (portal restarting on upgrade) keeps the seen items: no flood on recovery', async () => {
    let fail = false
    const { poller, notify } = makePoller({
      fetchStackAttention: vi.fn(async () => {
        if (fail) throw new Error('ECONNREFUSED')
        return detail(items)
      })
    })
    await poller.tick() // baseline
    fail = true
    await poller.tick() // portal restarting
    fail = false
    await poller.tick() // back up, same queue
    expect(notify).not.toHaveBeenCalled()
  })

  it('a stack unreachable at startup baselines silently on its first successful fetch', async () => {
    let fail = true
    const { poller, notify } = makePoller({
      fetchStackAttention: vi.fn(async () => {
        if (fail) throw new Error('down')
        return detail(items)
      })
    })
    await poller.tick()
    fail = false
    await poller.tick()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a genuinely new item after recovery still notifies, once', async () => {
    let phase = 0
    const { poller, notify } = makePoller({
      fetchStackAttention: vi.fn(async () => {
        if (phase === 1) throw new Error('blip')
        return detail(phase === 2 ? [...items, item('r4')] : items)
      })
    })
    await poller.tick()
    phase = 1
    await poller.tick()
    phase = 2
    await poller.tick()
    await poller.tick()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toEqual(item('r4'))
  })
})
