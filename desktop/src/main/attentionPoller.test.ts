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
  folder: null
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
})
