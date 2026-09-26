import { describe, it, expect, vi } from 'vitest'
import { resetStack, type ResetDeps } from './resetEngine'
import type { ProcessDeps } from './daemonCleanup'

function deps(over: Partial<ResetDeps> = {}): ResetDeps {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '' }),
    rmrf: vi.fn(),
    rmFile: vi.fn(),
    ...over
  }
}

function noopProcessDeps(over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    findByCommand: vi.fn().mockResolvedValue([]),
    cwdOf: vi.fn().mockResolvedValue(null),
    kill: vi.fn(),
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

  // ---- CLI-first teardown ----------------------------------------------------------------

  it('runs `orcha down -v` from the folder BEFORE the direct compose down -v, when execHost is given', async () => {
    const calls: string[] = []
    const exec = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      calls.push(`exec:${args.join(' ')}`)
      return Promise.resolve({ stdout: '' })
    })
    const execHost = vi.fn().mockImplementation((cmd: string, args: string[], opts: { cwd: string }) => {
      calls.push(`execHost:${cmd} ${args.join(' ')}@${opts.cwd}`)
      return Promise.resolve({ stdout: '' })
    })
    const d = deps({ exec, execHost, pathEnv: '/usr/bin' })
    await resetStack('orcha-foo', '/Users/me/foo', d)

    expect(execHost).toHaveBeenCalledWith(
      'orcha',
      ['down', '-v'],
      expect.objectContaining({ cwd: '/Users/me/foo' })
    )
    // CLI teardown ran first, then the direct compose down -v still ran (never skipped).
    expect(calls[0]).toBe('execHost:orcha down -v@/Users/me/foo')
    expect(calls.some((c) => c.startsWith('exec:compose -p orcha-foo down -v'))).toBe(true)
  })

  it('does not call execHost when folder is unknown (nothing to cd into)', async () => {
    const execHost = vi.fn().mockResolvedValue({ stdout: '' })
    const d = deps({ execHost })
    await resetStack('orcha-foo', null, d)
    expect(execHost).not.toHaveBeenCalled()
  })

  it('tolerates a missing orcha binary (execHost rejects with ENOENT) and still runs compose down -v', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '' })
    const execHost = vi.fn().mockRejectedValue(Object.assign(new Error('spawn orcha ENOENT'), { code: 'ENOENT' }))
    const d = deps({ exec, execHost })
    await expect(resetStack('orcha-foo', '/Users/me/foo', d)).resolves.toBeUndefined()
    const composeDown = (exec as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      (c[1] as string[]).includes('down')
    )
    expect(composeDown).toBeTruthy()
  })

  it('tolerates a nonzero exit from `orcha down -v` and still runs compose down -v', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '' })
    const execHost = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('exited 1'), { stderr: 'no .orcha/docker-compose.yml here' }))
    const d = deps({ exec, execHost })
    await expect(resetStack('orcha-foo', '/Users/me/foo', d)).resolves.toBeUndefined()
    expect(exec).toHaveBeenCalled()
  })

  it('passes the given pathEnv/hostEnv through to execHost', async () => {
    const execHost = vi.fn().mockResolvedValue({ stdout: '' })
    const d = deps({ execHost, pathEnv: '/custom/bin:/usr/bin', hostEnv: { FOO: 'bar' } })
    await resetStack('orcha-foo', '/Users/me/foo', d)
    const call = (execHost as ReturnType<typeof vi.fn>).mock.calls[0]
    const env = call[2].env as NodeJS.ProcessEnv
    expect(env.PATH).toBe('/custom/bin:/usr/bin')
    expect(env.FOO).toBe('bar')
  })

  // ---- artifact set additions --------------------------------------------------------------

  it('includes the daemon log files in the removed artifact set', async () => {
    const d = deps()
    await resetStack('orcha-foo', '/Users/me/foo', d)
    const removedFiles = (d.rmFile as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
    expect(removedFiles).toContain('/Users/me/foo/.claude/.orcha-notifier.log')
    expect(removedFiles).toContain('/Users/me/foo/.claude/.orcha-terminal-bridge.log')
  })

  it('removes only orcha-* subdirs of .agents/skills, never the whole .agents dir', async () => {
    const listDir = vi.fn().mockImplementation((p: string) =>
      p === '/Users/me/foo/.agents/skills' ? ['orcha-done', 'orcha-register-human', 'my-custom-skill'] : null
    )
    const d = deps({ listDir })
    await resetStack('orcha-foo', '/Users/me/foo', d)
    const removedDirs = (d.rmrf as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
    expect(removedDirs).toContain('/Users/me/foo/.agents/skills/orcha-done')
    expect(removedDirs).toContain('/Users/me/foo/.agents/skills/orcha-register-human')
    expect(removedDirs).not.toContain('/Users/me/foo/.agents/skills/my-custom-skill')
    expect(removedDirs).not.toContain('/Users/me/foo/.agents')
    expect(removedDirs).not.toContain('/Users/me/foo/.agents/skills')
  })

  it('skips the .agents/skills glob entirely when the dir does not exist', async () => {
    const listDir = vi.fn().mockReturnValue(null)
    const d = deps({ listDir })
    await resetStack('orcha-foo', '/Users/me/foo', d)
    const removedDirs = (d.rmrf as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
    expect(removedDirs.some((p) => p.includes('.agents'))).toBe(false)
  })

  // ---- belt-and-braces daemon cleanup -------------------------------------------------------

  it('reads current_container_id from orcha.json and passes it to daemon cleanup', async () => {
    const readFile = vi.fn().mockImplementation((p: string) =>
      p === '/Users/me/foo/.claude/orcha.json' ? JSON.stringify({ current_container_id: 'cid-123' }) : null
    )
    const kill = vi.fn()
    const processDeps = noopProcessDeps({
      findByCommand: vi.fn().mockImplementation((pattern: string) =>
        pattern === 'orcha notifier'
          ? Promise.resolve([{ pid: 42, command: 'orcha notifier --quiet --container cid-123' }])
          : Promise.resolve([])
      ),
      kill
    })
    const d = deps({ readFile, processDeps })
    await resetStack('orcha-foo', '/Users/me/foo', d)
    expect(kill).toHaveBeenCalledWith(42)
  })

  it('never kills a daemon bound to a DIFFERENT container id', async () => {
    const readFile = vi.fn().mockReturnValue(JSON.stringify({ current_container_id: 'cid-mine' }))
    const kill = vi.fn()
    const processDeps = noopProcessDeps({
      findByCommand: vi.fn().mockImplementation((pattern: string) =>
        pattern === 'orcha notifier'
          ? Promise.resolve([{ pid: 99, command: 'orcha notifier --quiet --container cid-OTHER' }])
          : Promise.resolve([])
      ),
      kill
    })
    const d = deps({ readFile, processDeps })
    await resetStack('orcha-foo', '/Users/me/foo', d)
    expect(kill).not.toHaveBeenCalled()
  })

  it('does not attempt daemon cleanup when readFile is not supplied (no container id available)', async () => {
    const findByCommand = vi.fn().mockResolvedValue([])
    const processDeps = noopProcessDeps({ findByCommand })
    const d = deps({ processDeps })
    await resetStack('orcha-foo', '/Users/me/foo', d)
    expect(findByCommand).not.toHaveBeenCalledWith('orcha notifier')
  })

  it('skips daemon cleanup entirely when folder is unknown', async () => {
    const findByCommand = vi.fn().mockResolvedValue([])
    const processDeps = noopProcessDeps({ findByCommand })
    const d = deps({ processDeps })
    await resetStack('orcha-foo', null, d)
    expect(findByCommand).not.toHaveBeenCalled()
  })
})
