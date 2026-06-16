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
})
