import { describe, it, expect, vi } from 'vitest'
import {
  matchesNotifier,
  looksLikeBridgeCommand,
  matchesBridgeCwd,
  killLingeringDaemons,
  type ProcessCandidate,
  type ProcessDeps
} from './daemonCleanup'

function candidate(command: string, pid = 1): ProcessCandidate {
  return { pid, command }
}

describe('matchesNotifier (pure)', () => {
  it('matches a notifier whose --container carries the same cid', () => {
    expect(matchesNotifier(candidate('orcha notifier --quiet --container abc-123'), 'abc-123')).toBe(true)
  })

  it('matches with the module-invocation argv shape too', () => {
    expect(
      matchesNotifier(
        candidate('/usr/bin/python3 -m orcha_cli notifier --quiet --container abc-123'),
        'abc-123'
      )
    ).toBe(true)
  })

  it('never matches a notifier bound to a DIFFERENT container id', () => {
    expect(matchesNotifier(candidate('orcha notifier --quiet --container xyz-999'), 'abc-123')).toBe(false)
  })

  it('never matches a notifier with no --container token at all', () => {
    expect(matchesNotifier(candidate('orcha notifier --quiet'), 'abc-123')).toBe(false)
  })

  it('never matches when containerId is empty', () => {
    expect(matchesNotifier(candidate('orcha notifier --quiet --container abc-123'), '')).toBe(false)
  })

  it('never matches an unrelated process, even one that mentions the cid incidentally', () => {
    expect(matchesNotifier(candidate('grep abc-123 /var/log/somefile'), 'abc-123')).toBe(false)
  })

  it('never matches a plain "orcha down" or other orcha subcommand', () => {
    expect(matchesNotifier(candidate('orcha down -v --container abc-123'), 'abc-123')).toBe(false)
  })

  it('does not false-positive on a cid that is a PREFIX of another running cid', () => {
    // abc-123 must not match a process actually bound to abc-1234
    expect(matchesNotifier(candidate('orcha notifier --quiet --container abc-1234'), 'abc-123')).toBe(false)
  })
})

describe('looksLikeBridgeCommand (pure)', () => {
  it('matches the terminal-bridge argv shape', () => {
    expect(looksLikeBridgeCommand(candidate('orcha terminal-bridge --quiet'))).toBe(true)
  })

  it('matches the module-invocation form', () => {
    expect(looksLikeBridgeCommand(candidate('/usr/bin/python3 -m orcha_cli terminal-bridge --quiet'))).toBe(true)
  })

  it('does not match a notifier process', () => {
    expect(looksLikeBridgeCommand(candidate('orcha notifier --quiet --container abc-123'))).toBe(false)
  })

  it('does not match an unrelated process', () => {
    expect(looksLikeBridgeCommand(candidate('node server.js'))).toBe(false)
  })
})

describe('matchesBridgeCwd (pure)', () => {
  it('matches when cwd equals folder exactly', () => {
    expect(matchesBridgeCwd('/Users/me/foo', '/Users/me/foo')).toBe(true)
  })

  it('tolerates a trailing slash on either side', () => {
    expect(matchesBridgeCwd('/Users/me/foo/', '/Users/me/foo')).toBe(true)
    expect(matchesBridgeCwd('/Users/me/foo', '/Users/me/foo/')).toBe(true)
  })

  it('never matches a PARENT directory of folder', () => {
    expect(matchesBridgeCwd('/Users/me', '/Users/me/foo')).toBe(false)
  })

  it('never matches a CHILD directory of folder', () => {
    expect(matchesBridgeCwd('/Users/me/foo/subdir', '/Users/me/foo')).toBe(false)
  })

  it('never matches a sibling project whose name merely shares a prefix', () => {
    expect(matchesBridgeCwd('/Users/me/foo-other', '/Users/me/foo')).toBe(false)
  })

  it('never matches when cwd is null (unknown cwd is never "this project")', () => {
    expect(matchesBridgeCwd(null, '/Users/me/foo')).toBe(false)
  })

  it('never matches when folder is empty', () => {
    expect(matchesBridgeCwd('/Users/me/foo', '')).toBe(false)
  })
})

function processDeps(over: Partial<ProcessDeps> = {}): ProcessDeps {
  return {
    findByCommand: vi.fn().mockResolvedValue([]),
    cwdOf: vi.fn().mockResolvedValue(null),
    kill: vi.fn(),
    ...over
  }
}

describe('killLingeringDaemons', () => {
  it('kills a notifier matching the container id', async () => {
    const kill = vi.fn()
    const deps = processDeps({
      findByCommand: vi.fn().mockImplementation((pattern: string) =>
        pattern === 'orcha notifier'
          ? Promise.resolve([candidate('orcha notifier --quiet --container cid-1', 10)])
          : Promise.resolve([])
      ),
      kill
    })
    await killLingeringDaemons('/Users/me/foo', 'cid-1', deps)
    expect(kill).toHaveBeenCalledWith(10)
  })

  it('never kills a notifier for a foreign container id', async () => {
    const kill = vi.fn()
    const deps = processDeps({
      findByCommand: vi.fn().mockImplementation((pattern: string) =>
        pattern === 'orcha notifier'
          ? Promise.resolve([candidate('orcha notifier --quiet --container cid-OTHER', 10)])
          : Promise.resolve([])
      ),
      kill
    })
    await killLingeringDaemons('/Users/me/foo', 'cid-mine', deps)
    expect(kill).not.toHaveBeenCalled()
  })

  it('kills a terminal-bridge only when its resolved cwd matches the folder', async () => {
    const kill = vi.fn()
    const deps = processDeps({
      findByCommand: vi.fn().mockImplementation((pattern: string) =>
        pattern === 'orcha terminal-bridge'
          ? Promise.resolve([candidate('orcha terminal-bridge --quiet', 20)])
          : Promise.resolve([])
      ),
      cwdOf: vi.fn().mockResolvedValue('/Users/me/foo'),
      kill
    })
    await killLingeringDaemons('/Users/me/foo', null, deps)
    expect(kill).toHaveBeenCalledWith(20)
  })

  it('never kills a terminal-bridge belonging to another project folder', async () => {
    const kill = vi.fn()
    const deps = processDeps({
      findByCommand: vi.fn().mockImplementation((pattern: string) =>
        pattern === 'orcha terminal-bridge'
          ? Promise.resolve([candidate('orcha terminal-bridge --quiet', 20)])
          : Promise.resolve([])
      ),
      cwdOf: vi.fn().mockResolvedValue('/Users/me/OTHER-PROJECT'),
      kill
    })
    await killLingeringDaemons('/Users/me/foo', null, deps)
    expect(kill).not.toHaveBeenCalled()
  })

  it('skips notifier matching entirely when containerId is null', async () => {
    const findByCommand = vi.fn().mockResolvedValue([])
    const deps = processDeps({ findByCommand })
    await killLingeringDaemons('/Users/me/foo', null, deps)
    expect(findByCommand).not.toHaveBeenCalledWith('orcha notifier')
  })

  it('skips bridge matching entirely when folder is null', async () => {
    const findByCommand = vi.fn().mockResolvedValue([])
    const deps = processDeps({ findByCommand })
    await killLingeringDaemons(null, 'cid-1', deps)
    expect(findByCommand).not.toHaveBeenCalledWith('orcha terminal-bridge')
  })

  it('never throws when findByCommand rejects (pgrep missing, etc)', async () => {
    const deps = processDeps({
      findByCommand: vi.fn().mockRejectedValue(new Error('pgrep: command not found'))
    })
    await expect(killLingeringDaemons('/Users/me/foo', 'cid-1', deps)).resolves.toBeUndefined()
  })

  it('never throws when cwdOf rejects', async () => {
    const deps = processDeps({
      findByCommand: vi.fn().mockImplementation((pattern: string) =>
        pattern === 'orcha terminal-bridge'
          ? Promise.resolve([candidate('orcha terminal-bridge --quiet', 20)])
          : Promise.resolve([])
      ),
      cwdOf: vi.fn().mockRejectedValue(new Error('lsof: command not found'))
    })
    await expect(killLingeringDaemons('/Users/me/foo', null, deps)).resolves.toBeUndefined()
  })
})
