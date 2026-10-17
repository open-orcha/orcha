import { describe, it, expect, vi } from 'vitest'
import { BACKLOG_MAX, FLUSH_BYTES, KILL_GRACE_MS, PtyHost, type CreateSpec, type PtyProcess } from './ptyHost'
import type { TermEvent } from '../shared/terminal'

class FakePty implements PtyProcess {
  pid = 4242
  data: ((d: string) => void) | null = null
  exit: ((e: { exitCode: number; signal?: number }) => void) | null = null
  writes: string[] = []
  kills: string[] = []
  resizes: Array<[number, number]> = []
  onData(cb: (d: string) => void) {
    this.data = cb
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exit = cb
  }
  write(d: string) {
    this.writes.push(d)
  }
  resize(c: number, r: number) {
    this.resizes.push([c, r])
  }
  kill(sig?: string) {
    this.kills.push(sig ?? 'SIGHUP')
  }
}

function setup() {
  vi.useFakeTimers()
  const ptys: FakePty[] = []
  const events: TermEvent[] = []
  const groups: Array<[number, string]> = []
  const spawn = vi.fn(() => {
    const p = new FakePty()
    ptys.push(p)
    return p
  })
  const host = new PtyHost({
    spawn,
    emit: (e) => events.push(e),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    killGroup: (pid, sig) => groups.push([pid, sig])
  })
  const spec: CreateSpec = {
    kind: 'shell',
    project: 'orcha-a',
    file: '/bin/zsh',
    args: ['-l'],
    cwd: '/Users/me/a',
    note: null,
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    env: { TERM: 'xterm-256color' }
  }
  return { host, ptys, events, groups, spawn, spec }
}

describe('PtyHost', () => {
  it('spawns with the planned argv/cwd/env and mints increasing ids', () => {
    const { host, spawn, spec } = setup()
    const a = host.create(spec)
    const b = host.create({ ...spec, kind: 'claude' })
    expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], expect.objectContaining({ cwd: '/Users/me/a', cols: 80, rows: 24 }))
    expect(a).toMatchObject({ id: 1, kind: 'shell', shell: 'zsh', project: 'orcha-a', cwd: '/Users/me/a' })
    expect(b.id).toBe(2)
  })

  it('coalesces output into one event per flush window', () => {
    const { host, ptys, events, spec } = setup()
    host.create(spec)
    ptys[0].data!('he')
    ptys[0].data!('llo')
    expect(events).toEqual([])
    vi.advanceTimersByTime(10)
    expect(events).toEqual([{ type: 'data', id: 1, data: 'hello' }]) // session meta waits its 500 ms
  })

  it('flushes immediately when a batch gets large', () => {
    const { host, ptys, events, spec } = setup()
    host.create(spec)
    ptys[0].data!('x'.repeat(FLUSH_BYTES))
    expect(events).toHaveLength(1)
  })

  it('flushes pending output BEFORE the exit event (the not-found line is never lost)', () => {
    const { host, ptys, events, spec } = setup()
    host.create(spec)
    ptys[0].data!('Claude Code CLI not found')
    ptys[0].exit!({ exitCode: 127 })
    expect(events.filter((e) => e.type !== 'meta')).toEqual([
      { type: 'data', id: 1, data: 'Claude Code CLI not found' },
      { type: 'exit', id: 1, exitCode: 127, signal: null }
    ])
    // …and the session row learns the unfinished last line before the exit event.
    const metaAt = events.findIndex((e) => e.type === 'meta')
    expect(events[metaAt]).toMatchObject({ type: 'meta', snippet: 'Claude Code CLI not found', attention: false })
    expect(metaAt).toBeLessThan(events.findIndex((e) => e.type === 'exit'))
  })

  it('write/resize reach the live pty only', () => {
    const { host, ptys, spec } = setup()
    host.create(spec)
    expect(host.write(1, 'ls\r')).toBe(true)
    expect(host.resize(1, 100, 30)).toBe(true)
    expect(host.write(99, 'x')).toBe(false)
    expect(ptys[0].writes).toEqual(['ls\r'])
    expect(ptys[0].resizes).toEqual([[100, 30]])
    ptys[0].exit!({ exitCode: 0 })
    expect(host.write(1, 'more')).toBe(false)
  })

  it('kill: SIGHUP, then SIGKILL if still alive after the grace period', () => {
    const { host, ptys, spec } = setup()
    host.create(spec)
    expect(host.kill(1)).toBe(true)
    expect(ptys[0].kills).toEqual(['SIGHUP'])
    expect(host.has(1)).toBe(false)
    vi.advanceTimersByTime(KILL_GRACE_MS + 1)
    expect(ptys[0].kills).toEqual(['SIGHUP', 'SIGKILL'])
  })

  it('kill: no SIGKILL when the process exits on SIGHUP', () => {
    const { host, ptys, spec } = setup()
    host.create(spec)
    host.kill(1)
    ptys[0].exit!({ exitCode: 0, signal: 1 })
    vi.advanceTimersByTime(KILL_GRACE_MS + 1)
    expect(ptys[0].kills).toEqual(['SIGHUP'])
  })

  it('killAll hangs up every live pty and its process group (window close / quit)', () => {
    const { host, ptys, groups, spec } = setup()
    host.create(spec)
    host.create(spec)
    ptys[1].exit!({ exitCode: 0 })
    host.killAll()
    expect(ptys[0].kills).toEqual(['SIGHUP'])
    expect(ptys[1].kills).toEqual([]) // already exited
    expect(groups).toEqual([[4242, 'SIGHUP']])
    expect(host.size).toBe(0)
  })

  it('list returns infos with a bounded backlog and exit status for re-attach', () => {
    const { host, ptys, spec } = setup()
    host.create(spec)
    ptys[0].data!('a'.repeat(BACKLOG_MAX))
    ptys[0].data!('tail')
    const [info] = host.list()
    expect(info.backlog!.length).toBe(BACKLOG_MAX)
    expect(info.backlog!.endsWith('tail')).toBe(true)
    expect(info.exit).toBeNull()
    ptys[0].exit!({ exitCode: 1 })
    expect(host.list()[0].exit).toEqual({ exitCode: 1, signal: null })
  })

  it('derives session meta from the stream (≤ 2/s), clears attention on input, and lists it for re-attach', () => {
    const { host, ptys, events, spec } = setup()
    host.create({ ...spec, branch: 'main' })
    ptys[0].data!('\x1b]0;✳ Fix login\x07building…\r\nready\r\n\x07')
    vi.advanceTimersByTime(600)
    const metas = events.filter((e) => e.type === 'meta')
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({ id: 1, title: 'Fix login', snippet: 'ready', attention: true })
    host.write(1, 'y')
    vi.advanceTimersByTime(600)
    expect(events.filter((e) => e.type === 'meta').at(-1)).toMatchObject({ attention: false })
    const [listed] = host.list()
    expect(listed.branch).toBe('main')
    expect(listed.meta).toMatchObject({ title: 'Fix login', snippet: 'ready', attention: false })
  })
})

describe('agent hooks', () => {
  it('a hooked session carries ORCHA_TERM_ID (its own id) + the endpoint file; others do not', () => {
    const { host, spawn, spec } = setup()
    host.create(spec)
    const info = host.create({ ...spec, kind: 'claude', hooks: { mode: 'lifecycle', endpointFile: '/ud/endpoint.env' } })
    const plainEnv = (spawn.mock.calls[0] as unknown[])[2] as { env: Record<string, string> }
    const hookedEnv = (spawn.mock.calls[1] as unknown[])[2] as { env: Record<string, string> }
    expect(plainEnv.env.ORCHA_TERM_ID).toBeUndefined()
    expect(hookedEnv.env).toMatchObject({ ORCHA_TERM_ID: String(info.id), ORCHA_HOOK_ENDPOINT: '/ud/endpoint.env' })
    expect(host.acceptsHooks(info.id)).toBe(true)
    expect(host.acceptsHooks(1)).toBe(false) // the plain shell
    expect(host.acceptsHooks(99)).toBe(false)
  })

  it('every pty is marked a personal session (never an Orcha agent identity), hooked or not', () => {
    const { host, spawn, spec } = setup()
    host.create({ ...spec, env: { TERM: 'xterm-256color', ORCHA_PERSONAL_SESSION: '0' } })
    host.create({ ...spec, kind: 'claude', hooks: { mode: 'lifecycle', endpointFile: '/ud/endpoint.env' } })
    for (const call of spawn.mock.calls) {
      const opts = (call as unknown[])[2] as { env: Record<string, string> }
      expect(opts.env.ORCHA_PERSONAL_SESSION).toBe('1')
    }
  })

  it('hook events drive the meta status; exited / killed sessions refuse them', () => {
    const { host, ptys, events, spec } = setup()
    const info = host.create({ ...spec, kind: 'claude', hooks: { mode: 'lifecycle', endpointFile: '/ud/e' } })
    expect(host.hookEvent(info.id, { event: 'UserPromptSubmit', detail: null })).toBe(true)
    vi.advanceTimersByTime(600)
    expect(host.hookEvent(info.id, { event: 'Stop', detail: null })).toBe(true)
    vi.advanceTimersByTime(600)
    const metas = events.filter((e) => e.type === 'meta') as Array<{ status: string }>
    expect(metas.map((m) => m.status)).toEqual(['working', 'done'])
    expect(host.list()[0].meta?.status).toBe('done')
    ptys[0].exit?.({ exitCode: 0 })
    expect(host.hookEvent(info.id, { event: 'UserPromptSubmit', detail: null })).toBe(false)
    host.kill(info.id)
    expect(host.acceptsHooks(info.id)).toBe(false)
  })
})
