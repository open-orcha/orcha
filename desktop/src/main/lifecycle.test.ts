import { describe, it, expect, vi } from 'vitest'
import { startStack, stopStack } from './lifecycle'

describe('lifecycle', () => {
  it('startStack runs docker compose -p <project> start', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '' })
    await startStack('orcha-demo', exec)
    expect(exec).toHaveBeenCalledWith('docker', ['compose', '-p', 'orcha-demo', 'start'])
  })

  it('stopStack runs docker compose -p <project> stop', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '' })
    await stopStack('orcha-demo', exec)
    expect(exec).toHaveBeenCalledWith('docker', ['compose', '-p', 'orcha-demo', 'stop'])
  })

  it('rejects non-orcha project names without invoking docker', async () => {
    const exec = vi.fn()
    await expect(startStack('shadow; rm -rf /', exec)).rejects.toEqual({
      code: 'UNKNOWN_STACK'
    })
    expect(exec).not.toHaveBeenCalled()
  })

  it('maps compose failure to COMPOSE_FAILED with the stderr tail', async () => {
    const err = Object.assign(new Error('exit 1'), {
      stderr: 'a'.repeat(2000) + '\nno such project'
    })
    const exec = vi.fn().mockRejectedValue(err)
    await expect(stopStack('orcha-demo', exec)).rejects.toMatchObject({
      code: 'COMPOSE_FAILED'
    })
    const rejection = await stopStack('orcha-demo', exec).catch((e) => e)
    expect(rejection.stderr.endsWith('no such project')).toBe(true)
    expect(rejection.stderr.length).toBeLessThanOrEqual(500)
  })

  describe('native projects (GH #258)', () => {
    const notes = { project: 'orcha-notes', runtime: 'native' as const, folder: '/Users/me/notes' }

    it('startStack runs `orcha up` in the project folder, never docker', async () => {
      const exec = vi.fn()
      const run = vi.fn().mockResolvedValue(undefined)
      await startStack(notes, exec, run)
      expect(run).toHaveBeenCalledWith('/Users/me/notes', ['up'])
      expect(exec).not.toHaveBeenCalled()
    })

    it('stopStack runs `orcha down` in the project folder', async () => {
      const run = vi.fn().mockResolvedValue(undefined)
      await stopStack(notes, vi.fn(), run)
      expect(run).toHaveBeenCalledWith('/Users/me/notes', ['down'])
    })

    it('a docker StackRef still goes through compose', async () => {
      const exec = vi.fn().mockResolvedValue({ stdout: '' })
      const run = vi.fn()
      await startStack({ project: 'orcha-demo', runtime: 'docker', folder: null }, exec, run)
      expect(exec).toHaveBeenCalledWith('docker', ['compose', '-p', 'orcha-demo', 'start'])
      expect(run).not.toHaveBeenCalled()
    })

    it('refuses a native stack with no folder or an unsafe name', async () => {
      const run = vi.fn()
      await expect(startStack({ ...notes, folder: null }, vi.fn(), run)).rejects.toEqual({ code: 'UNKNOWN_STACK' })
      await expect(startStack({ ...notes, project: 'orcha-x; rm' }, vi.fn(), run)).rejects.toEqual({
        code: 'UNKNOWN_STACK'
      })
      expect(run).not.toHaveBeenCalled()
    })

    it('maps an orcha failure to ORCHA_FAILED with the stderr tail', async () => {
      const run = vi.fn().mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: 'x'.repeat(900) + 'port 8010 busy' }))
      await expect(stopStack(notes, vi.fn(), run)).rejects.toMatchObject({ code: 'ORCHA_FAILED' })
      const err = await startStack(notes, vi.fn(), run).catch((e) => e)
      expect(err.stderr).toHaveLength(500)
      expect(err.stderr.endsWith('port 8010 busy')).toBe(true)
    })
  })
})
