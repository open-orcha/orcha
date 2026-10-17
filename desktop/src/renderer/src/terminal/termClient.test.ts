import { describe, it, expect, vi } from 'vitest'
import { REPLAY_MAX, TermClient } from './termClient'
import type { TermEvent } from '../../../shared/terminal'

function setup() {
  let emit: ((e: TermEvent) => void) | null = null
  const off = vi.fn()
  const api = { onEvent: (cb: (e: TermEvent) => void) => ((emit = cb), off) }
  const seen: unknown[] = []
  const client = new TermClient(api, (e) => seen.push(e))
  client.start()
  return { client, emit: (e: TermEvent) => emit!(e), seen, off }
}

describe('TermClient', () => {
  it('routes output to the attached view and reports data/exit upstream', () => {
    const { client, emit, seen } = setup()
    const got: string[] = []
    client.attach(1, (d) => got.push(d))
    emit({ type: 'data', id: 1, data: 'hello' })
    emit({ type: 'data', id: 2, data: 'other' })
    emit({ type: 'exit', id: 1, exitCode: 0, signal: null })
    expect(got).toEqual(['hello'])
    expect(seen).toEqual([{ type: 'data', id: 1 }, { type: 'data', id: 2 }, { type: 'exit', id: 1, exitCode: 0, signal: null }])
  })
  it('replays buffered output to a view that attaches late (early output / remount)', () => {
    const { client, emit } = setup()
    emit({ type: 'data', id: 1, data: 'a' })
    emit({ type: 'data', id: 1, data: 'b' })
    const got: string[] = []
    client.attach(1, (d) => got.push(d))
    emit({ type: 'data', id: 1, data: 'c' })
    expect(got).toEqual(['ab', 'c'])
  })
  it('bounds the replay buffer and forgets closed ptys', () => {
    const { client, emit } = setup()
    client.seed(1, 'x'.repeat(REPLAY_MAX))
    emit({ type: 'data', id: 1, data: 'END' })
    const got: string[] = []
    client.attach(1, (d) => got.push(d))
    expect(got[0].length).toBe(REPLAY_MAX)
    expect(got[0].endsWith('END')).toBe(true)
    client.forget(1)
    const again: string[] = []
    client.attach(1, (d) => again.push(d))
    expect(again).toEqual([])
  })
  it('stop unsubscribes from the bridge', () => {
    const { client, off } = setup()
    client.stop()
    expect(off).toHaveBeenCalled()
  })
})
