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
})
