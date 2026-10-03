import { describe, it, expect, vi } from 'vitest'
import { AttentionPoller } from './attentionPoller'
import type { StackAttention } from './attention'
import { checkUrl, decisionOf, shouldShowAttention, type PostJson } from './notifyPrefs'
import type { AttentionItem, Stack } from '../shared/types'

const stack: Stack = {
  project: 'orcha-demo',
  projectShort: 'demo',
  apiPort: 8001,
  dbPort: 5433,
  portalStatus: 'Up 1 hour',
  running: true,
  folder: null
}
const CID = '11111111-1111-1111-1111-111111111111'
const item = (id: string, kind: AttentionItem['kind'] = 'task_verify', cid: string | undefined = CID): AttentionItem => ({
  project: 'orcha-demo',
  projectShort: 'demo',
  kind,
  id,
  title: `item ${id}`,
  path: `/tasks?task=${id}`,
  ...(cid ? { cid } : {})
})
const answer = (notify: boolean): PostJson => vi.fn(async () => ({ status: 200, body: { decisions: [{ notify }] } }))

describe('notifyPrefs — desktop honours the portal notification settings', () => {
  it('asks the item’s own stack on the desktop channel', async () => {
    const post = answer(true)
    expect(await shouldShowAttention(item('t1'), [stack], post)).toBe(true)
    expect(post).toHaveBeenCalledWith(
      `http://localhost:8001/api/containers/${CID}/notification-prefs/check`,
      { channel: 'desktop', items: [{ kind: 'task_verify', ref_id: 't1' }] }
    )
    expect(checkUrl(9, 'a b')).toBe('http://localhost:9/api/containers/a%20b/notification-prefs/check')
  })

  it('suppresses the alert when the portal says no', async () => {
    expect(await shouldShowAttention(item('t1'), [stack], answer(false))).toBe(false)
  })

  it.each([
    ['older portal (404)', vi.fn(async () => ({ status: 404, body: { detail: 'Not Found' } }))],
    ['server error', vi.fn(async () => ({ status: 500, body: null }))],
    ['malformed answer', vi.fn(async () => ({ status: 200, body: { decisions: [{}] } }))],
    ['empty decisions', vi.fn(async () => ({ status: 200, body: { decisions: [] } }))],
    ['network failure', vi.fn(async () => { throw new Error('ECONNREFUSED') })]
  ])('fails OPEN on %s', async (_label, post) => {
    expect(await shouldShowAttention(item('t1'), [stack], post as PostJson)).toBe(true)
  })

  it('never gates health items, items without a project id, or stopped/unknown stacks', async () => {
    const post = answer(false)
    expect(await shouldShowAttention(item('h', 'health'), [stack], post)).toBe(true)
    expect(await shouldShowAttention(item('t1', 'task_verify', ''), [stack], post)).toBe(true)
    expect(await shouldShowAttention(item('t1'), [{ ...stack, running: false, apiPort: null }], post)).toBe(true)
    expect(await shouldShowAttention(item('t1'), [], post)).toBe(true)
    expect(post).not.toHaveBeenCalled()
  })

  it('decisionOf reads only a real boolean decision', () => {
    expect(decisionOf({ status: 200, body: { decisions: [{ notify: false }] } })).toBe(false)
    expect(decisionOf({ status: 200, body: { decisions: [{ notify: true }] } })).toBe(true)
    expect(decisionOf({ status: 200, body: null })).toBeNull()
    expect(decisionOf({ status: 403, body: { decisions: [{ notify: false }] } })).toBeNull()
  })
})

describe('AttentionPoller gate', () => {
  const detail = (items: AttentionItem[] = []): StackAttention => ({
    items,
    agents: [],
    tasks: { ready: 0, inProgress: 0, needsVerification: 0 }
  })

  function poller(gate: (i: AttentionItem) => Promise<boolean>) {
    const fetch = vi.fn(async () => detail())
    const notify = vi.fn()
    const p = new AttentionPoller({ listStacks: vi.fn(async () => [stack]), fetchStackAttention: fetch, notify, gate })
    return { p, fetch, notify }
  }

  it('a gated-off item raises no alert but still counts (Needs-you/tray unchanged) and is not re-asked', async () => {
    const gate = vi.fn(async (i: AttentionItem) => i.id !== 'muted')
    const { p, fetch, notify } = poller(gate)
    await p.tick() // baseline
    fetch.mockResolvedValue(detail([item('muted'), item('shown')]))
    await p.tick()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(item('shown'))
    expect(p.current()).toEqual([item('muted'), item('shown')]) // still listed / counted
    await p.tick()
    expect(gate).toHaveBeenCalledTimes(2) // seen items are not re-alerted or re-asked
  })

  it('a gate that throws fails open', async () => {
    const { p, fetch, notify } = poller(vi.fn(async () => { throw new Error('boom') }))
    await p.tick()
    fetch.mockResolvedValue(detail([item('x')]))
    await p.tick()
    expect(notify).toHaveBeenCalledWith(item('x'))
  })
})
