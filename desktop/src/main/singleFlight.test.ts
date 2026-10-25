import { describe, it, expect, vi } from 'vitest'
import { singleFlight } from './singleFlight'

describe('singleFlight (Settings › Storage scans)', () => {
  it('a repeat while a scan runs joins it; the next call after it ends starts a new one', async () => {
    let finish = (_v: string): void => {}
    const fn = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const scan = singleFlight(fn)
    const a = scan()
    const b = scan()
    expect(fn).toHaveBeenCalledTimes(1)
    finish('one')
    expect(await a).toBe('one')
    expect(await b).toBe('one')
    const c = scan()
    expect(fn).toHaveBeenCalledTimes(2)
    finish('two')
    expect(await c).toBe('two')
  })

  it('a failed scan does not stick', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce('ok')
    const scan = singleFlight(fn)
    await expect(scan()).rejects.toThrow('busy')
    expect(await scan()).toBe('ok')
  })

  it('invalidation starts fresh, and an older completion cannot release the replacement', async () => {
    const finish: Array<(value: string) => void> = []
    const fn = vi.fn(() => new Promise<string>((resolve) => { finish.push(resolve) }))
    const scan = singleFlight(fn)
    const old = scan()
    scan.invalidate()
    const fresh = scan()
    expect(fresh).not.toBe(old)
    expect(fn).toHaveBeenCalledTimes(2)
    finish[0]('before cleanup')
    await old
    expect(scan()).toBe(fresh)
    expect(fn).toHaveBeenCalledTimes(2)
    finish[1]('after cleanup')
    expect(await fresh).toBe('after cleanup')
  })
})
