import { describe, it, expect, vi } from 'vitest'
import { preflight } from './preflight'

const okInfo = { stdout: 'Server Version: 27.0\n' }

describe('preflight', () => {
  it('returns ok when docker info succeeds', async () => {
    const exec = vi.fn().mockResolvedValue(okInfo)
    const open = vi.fn()
    const report = await preflight({ exec, open, pollMs: 1, timeoutMs: 10 })
    expect(report.docker).toBe('ok')
    expect(open).not.toHaveBeenCalled()
  })

  it('reports not-installed when docker is absent (ENOENT)', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('enoent'), { code: 'ENOENT' }))
    const report = await preflight({ exec, open: vi.fn(), pollMs: 1, timeoutMs: 10 })
    expect(report.docker).toBe('not-installed')
    expect(report.hint).toMatch(/install docker/i)
  })

  it('auto-starts Docker when the daemon is down, then succeeds', async () => {
    // first info call: daemon down; open Docker; subsequent info: up.
    let up = false
    const exec = vi.fn().mockImplementation((_cmd, args: string[]) => {
      if (args.includes('info')) {
        return up
          ? Promise.resolve(okInfo)
          : Promise.reject(Object.assign(new Error('down'), { stderr: 'Cannot connect to the Docker daemon' }))
      }
      return Promise.resolve({ stdout: '' })
    })
    const open = vi.fn().mockImplementation(() => {
      up = true
      return Promise.resolve()
    })
    const report = await preflight({ exec, open, pollMs: 1, timeoutMs: 1000 })
    expect(open).toHaveBeenCalledWith('Docker')
    expect(report.docker).toBe('ok')
    expect(report.autoStarted).toBe(true)
  })

  it('times out to daemon-down when Docker never comes up', async () => {
    const exec = vi.fn().mockImplementation((_cmd, args: string[]) =>
      args.includes('info')
        ? Promise.reject(Object.assign(new Error('down'), { stderr: 'Cannot connect to the Docker daemon' }))
        : Promise.resolve({ stdout: '' })
    )
    const report = await preflight({ exec, open: vi.fn(), pollMs: 1, timeoutMs: 10 })
    expect(report.docker).toBe('daemon-down')
  })
})
