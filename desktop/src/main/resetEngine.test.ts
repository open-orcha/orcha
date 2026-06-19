import { describe, it, expect, vi } from 'vitest'
import { resetStack, type ResetDeps } from './resetEngine'

function deps(over: Partial<ResetDeps> = {}): ResetDeps {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '' }),
    rmrf: vi.fn(),
    rmFile: vi.fn(),
    ...over
  }
}

describe('resetStack', () => {
  it('rejects a non-orcha project name without running anything', async () => {
    const d = deps()
    await expect(resetStack('shadow; rm -rf /', null, d)).rejects.toEqual({ code: 'UNKNOWN_STACK' })
    expect(d.exec).not.toHaveBeenCalled()
    expect(d.rmrf).not.toHaveBeenCalled()
  })

  it('runs docker compose down -v then removes the portal image', async () => {
    const d = deps()
    await resetStack('orcha-foo', null, d)
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string[])
    const down = calls.find((a) => a.includes('down'))
    expect(down).toEqual(['compose', '-p', 'orcha-foo', 'down', '-v'])
    const rmi = calls.find((a) => a[0] === 'rmi')
    expect(rmi).toEqual(['rmi', '-f', 'orcha-foo-portal'])
  })

  it('down -v runs BEFORE the image removal', async () => {
    const d = deps()
    await resetStack('orcha-foo', null, d)
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string[])
    const downIdx = calls.findIndex((a) => a.includes('down'))
    const rmiIdx = calls.findIndex((a) => a[0] === 'rmi')
    expect(downIdx).toBeGreaterThanOrEqual(0)
    expect(downIdx).toBeLessThan(rmiIdx)
  })

  it('deletes ONLY the orcha on-disk artifacts when a folder is known', async () => {
    const d = deps()
    await resetStack('orcha-foo', '/Users/me/foo', d)
    const removedDirs = (d.rmrf as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
    const removedFiles = (d.rmFile as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
    expect(removedDirs).toEqual(
      expect.arrayContaining([
        '/Users/me/foo/.orcha',
        '/Users/me/foo/.claude/orcha-tabs',
        '/Users/me/foo/.claude/.orcha-wakes',
        '/Users/me/foo/.claude/.orcha-attachments'
      ])
    )
    expect(removedFiles).toContain('/Users/me/foo/.claude/orcha.json')
    // Never removes the project root or .claude wholesale, and never anything outside the folder.
    expect(removedDirs).not.toContain('/Users/me/foo')
    expect(removedDirs).not.toContain('/Users/me/foo/.claude')
    expect(removedDirs.every((p) => p.startsWith('/Users/me/foo/'))).toBe(true)
  })

  it('skips on-disk cleanup when the folder is unknown (null)', async () => {
    const d = deps()
    await resetStack('orcha-foo', null, d)
    expect(d.rmrf).not.toHaveBeenCalled()
    expect(d.rmFile).not.toHaveBeenCalled()
    // but docker teardown still ran
    expect(d.exec).toHaveBeenCalled()
  })

  it('does not throw if image removal fails (image may not exist)', async () => {
    const exec = vi.fn().mockImplementation((_cmd: string, args: string[]) =>
      args[0] === 'rmi'
        ? Promise.reject(Object.assign(new Error('no such image'), { stderr: 'No such image' }))
        : Promise.resolve({ stdout: '' })
    )
    const d = deps({ exec })
    await expect(resetStack('orcha-foo', '/Users/me/foo', d)).resolves.toBeUndefined()
  })

  it('throws COMPOSE_FAILED with stderr tail when down -v fails', async () => {
    const exec = vi.fn().mockImplementation((_cmd: string, args: string[]) =>
      args.includes('down')
        ? Promise.reject(Object.assign(new Error('boom'), { stderr: 'a'.repeat(800) + '\nfatal' }))
        : Promise.resolve({ stdout: '' })
    )
    const d = deps({ exec })
    const err = await resetStack('orcha-foo', null, d).catch((e) => e)
    expect(err.code).toBe('COMPOSE_FAILED')
    expect(err.stderr.endsWith('fatal')).toBe(true)
    expect(err.stderr.length).toBeLessThanOrEqual(500)
  })
})
