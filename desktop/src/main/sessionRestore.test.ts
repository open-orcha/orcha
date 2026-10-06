import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSessionKeeper,
  parseLsofCwds,
  parseSavedSessions,
  planRestore,
  RESTORE_MAX_TABS,
  SAVE_DEBOUNCE_MS,
  sessionsFilePath,
  withResume,
  type RestoreItem,
  type SavedSessions,
  type SavedTab,
  type SessionKeeperDeps
} from './sessionRestore'
import { createTermController } from './terminalIpc'
import { PtyHost, type PtyProcess, type SessionFacts } from './ptyHost'
import { parseHookEvent } from './agentStatus'
import type { TermInfo } from '../shared/terminal'

const HOME = '/Users/me'
const TODO = '/Users/me/todo'
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const UUID2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const PROJECTS = [{ project: 'orcha-todo', projectShort: 'todo', folder: TODO }]
const DIRS = new Set([HOME, TODO, `${TODO}/api`, '/Users/me/Desktop'])

const tab = (over: Partial<SavedTab> = {}): SavedTab => ({
  kind: 'shell',
  project: null,
  branch: null,
  launchBranch: null,
  cwd: HOME,
  title: null,
  pinned: false,
  color: null,
  rowKey: null,
  agentSession: null,
  ...over
})
const saved = (tabs: SavedTab[], active: number | null = null): SavedSessions => ({ version: 1, savedAt: 1, tabs, active })
const ctx = (over: Partial<Parameters<typeof planRestore>[1]> = {}) => ({
  projects: PROJECTS,
  home: HOME,
  isDir: (p: string) => DIRS.has(p),
  resumeAgents: true,
  ...over
})

describe('saved-session validation (everything read back from disk)', () => {
  it('round-trips a valid set', () => {
    const s = saved(
      [
        tab({ cwd: '/Users/me/Desktop', title: 'scratch', pinned: true, color: 'pink' }),
        tab({ kind: 'claude', project: 'orcha-todo', cwd: TODO, agentSession: UUID, rowKey: 'orcha-todo:abc123', branch: 'main' })
      ],
      1
    )
    expect(parseSavedSessions(JSON.parse(JSON.stringify(s)))).toEqual({ saved: s, dropped: 0 })
  })

  it('rejects a wrong shape / version / oversize file outright', () => {
    expect(parseSavedSessions(null)).toBeNull()
    expect(parseSavedSessions({ version: 2, tabs: [] })).toBeNull()
    expect(parseSavedSessions({ version: 1, tabs: {} })).toBeNull()
    expect(parseSavedSessions({ version: 1, tabs: Array.from({ length: 65 }, () => tab()) })).toBeNull()
  })

  it('drops individual bad tabs (never coerced) and keeps the selection on the right tab', () => {
    const bad: unknown[] = [
      { ...tab(), kind: 'bash' }, // unknown kind
      { ...tab(), cwd: 'relative/dir' },
      { ...tab(), cwd: '/Users/me/../../etc' }, // not normalised
      { ...tab(), cwd: '/Users/me/x\n' },
      { ...tab({ kind: 'claude' }), agentSession: 'abc; rm -rf ~' }, // not a UUID
      { ...tab({ kind: 'claude' }), agentSession: `${UUID} --dangerous` },
      { ...tab(), agentSession: UUID }, // shells have no conversation
      { ...tab(), project: 'not-orcha' },
      { ...tab({ project: 'orcha-todo' }), rowKey: 'orcha-other:x' }, // row of another project
      { ...tab({ project: 'orcha-todo' }), branch: '--upload-pack=x' },
      { ...tab(), color: 'magenta' },
      { ...tab(), title: 'x'.repeat(61) },
      { ...tab(), extra: 1 } // unknown key
    ]
    const good = tab({ title: 'keep' })
    const r = parseSavedSessions({ version: 1, savedAt: 5, tabs: [...bad, good], active: bad.length })
    expect(r).toEqual({ saved: { ...saved([good], 0), savedAt: 5 }, dropped: bad.length })
    expect(r!.saved.savedAt).toBe(5)
  })
})

describe('resume argv', () => {
  const base = ['--settings', '/ud/agent-hooks/claude-settings.json', '--dangerously-skip-permissions', '--model', 'opus']
  it('Claude: --resume <id> after the hooks / Yolo flag / extra args; --continue as the fallback', () => {
    expect(withResume('claude', base, { mode: 'resume', id: UUID })).toEqual([...base, '--resume', UUID])
    expect(withResume('claude', base, { mode: 'continue' })).toEqual([...base, '--continue'])
    expect(withResume('claude', base, null)).toEqual(base)
  })
  it('Codex: `codex resume <id>` / `resume --last` — the subcommand first, its options after', () => {
    const cx = ['-c', 'notify=["/bin/sh","/s","codex-notify"]', '--dangerously-bypass-approvals-and-sandbox']
    expect(withResume('codex', cx, { mode: 'resume', id: UUID })).toEqual(['resume', UUID, ...cx])
    expect(withResume('codex', cx, { mode: 'continue' })).toEqual(['resume', '--last', ...cx])
  })
  it('never passes a non-UUID; other agents and user-chosen session flags are left alone', () => {
    expect(withResume('claude', base, { mode: 'resume', id: '$(touch /tmp/x)' })).toEqual(base)
    expect(withResume('gemini', ['--approval-mode=yolo'], { mode: 'resume', id: UUID })).toEqual(['--approval-mode=yolo'])
    expect(withResume('claude', ['--continue'], { mode: 'resume', id: UUID })).toEqual(['--continue'])
    expect(withResume('claude', ['--session-id=abc'], { mode: 'continue' })).toEqual(['--session-id=abc'])
  })
})

describe('planRestore', () => {
  it('resume by exact id; --continue only for the sole agent tab in that folder; else fresh', () => {
    const p = planRestore(
      saved([
        tab({ kind: 'claude', project: 'orcha-todo', cwd: TODO, agentSession: UUID }),
        tab({ kind: 'claude', project: 'orcha-todo', cwd: TODO }), // two Claude tabs here → fresh
        tab({ kind: 'claude', cwd: HOME }), // only Claude tab in $HOME → continue
        tab({ kind: 'codex', cwd: HOME, agentSession: UUID2 }),
        tab({ kind: 'gemini', cwd: HOME }), // no documented resume → fresh
        tab({ cwd: '/Users/me/Desktop' })
      ]),
      ctx()
    )
    expect(p.items.map((i) => [i.kind, i.how, i.resume])).toEqual([
      ['claude', 'resumed', { mode: 'resume', id: UUID }],
      ['claude', 'fresh', null],
      ['claude', 'continued', { mode: 'continue' }],
      ['codex', 'resumed', { mode: 'resume', id: UUID2 }],
      ['gemini', 'fresh', null],
      ['shell', 'shell', null]
    ])
    expect(p.items.map((i) => i.note)).toEqual([
      'Restored · conversation resumed',
      'Restored · new conversation',
      'Restored · most recent conversation',
      'Restored · conversation resumed',
      'Restored · new conversation',
      'Restored · new shell'
    ])
    expect(p.items[0].agentSession).toBe(UUID)
  })

  it('"Don’t resume agent conversations": every agent tab starts fresh', () => {
    const p = planRestore(saved([tab({ kind: 'claude', cwd: HOME, agentSession: UUID })]), ctx({ resumeAgents: false }))
    expect(p.items[0]).toMatchObject({ how: 'fresh', resume: null, agentSession: null })
  })

  it('a session flag in the user’s own extra args wins over our resume', () => {
    const p = planRestore(saved([tab({ kind: 'claude', cwd: HOME, agentSession: UUID })]), ctx({ extraArgs: () => ['--continue'] }))
    expect(p.items[0].resume).toBeNull()
  })

  it('cwd must be an existing folder inside $HOME or a known project folder — else the project folder / home, fresh', () => {
    const p = planRestore(
      saved([
        tab({ cwd: '/etc' }),
        tab({ cwd: '/Users/me/gone' }),
        tab({ kind: 'claude', project: 'orcha-todo', cwd: `${TODO}/deleted`, agentSession: UUID }),
        tab({ cwd: `${TODO}/api` })
      ]),
      ctx()
    )
    expect(p.items.map((i) => i.cwd)).toEqual([HOME, HOME, TODO, `${TODO}/api`])
    expect(p.items[2]).toMatchObject({ how: 'fresh', resume: null, note: 'Restored · new conversation · folder moved' })
    // A symlink out of the allowed roots is not followed.
    const q = planRestore(saved([tab({ cwd: '/Users/me/Desktop' })]), ctx({ realpath: (x) => (x === '/Users/me/Desktop' ? '/etc' : x) }))
    expect(q.items[0].cwd).toBe(HOME)
  })

  it('unknown project → deferred; capped at 20 with the rest counted; selection follows', () => {
    const tabs = [tab({ project: 'orcha-later', cwd: HOME }), ...Array.from({ length: 24 }, (_, i) => tab({ title: `t${i}` }))]
    const p = planRestore(saved(tabs, 5), ctx())
    expect(p.deferred).toHaveLength(1)
    expect(p.items).toHaveLength(RESTORE_MAX_TABS)
    expect(p.capped).toBe(4)
    expect(p.items[p.active!].saved.title).toBe('t4')
  })
})

describe('lsof parsing', () => {
  it('maps pids to clean absolute cwds only', () => {
    expect(parseLsofCwds('p12\nfcwd\nn/Users/me/Desktop\np13\nfcwd\nn/Users/me/../x\np14\nfcwd\nn/tmp\n')).toEqual(
      new Map([
        [12, '/Users/me/Desktop'],
        [14, '/tmp']
      ])
    )
  })
})

describe('session ids from agent hooks', () => {
  it('parseHookEvent accepts only a UUID session', () => {
    expect(parseHookEvent({ event: 'Stop', detail: '', session: UUID })).toEqual({ event: 'Stop', detail: null, session: UUID })
    expect(parseHookEvent({ event: 'Stop', detail: '', session: UUID.toUpperCase() })).toEqual({ event: 'Stop', detail: null, session: UUID })
    expect(parseHookEvent({ event: 'Stop', detail: '', session: '' })).toEqual({ event: 'Stop', detail: null })
    expect(parseHookEvent({ event: 'Stop', session: 'x; rm -rf /' })).toBeNull()
    expect(parseHookEvent({ event: 'Stop', session: 5 })).toBeNull()
  })

  it('PtyHost keeps the id from a prompt / turn end (not from tool events) and reports changes', () => {
    const onAgentSession = vi.fn()
    const host = new PtyHost({
      spawn: () => ({ pid: 99, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} }) as PtyProcess,
      emit: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
      onAgentSession
    })
    const info = host.create({
      kind: 'claude',
      project: null,
      file: '/bin/zsh',
      args: [],
      cwd: HOME,
      note: null,
      shell: '/bin/zsh',
      cols: 80,
      rows: 24,
      env: {},
      hooks: { mode: 'lifecycle', endpointFile: '/x' }
    })
    host.hookEvent(info.id, { event: 'PreToolUse', detail: null, session: UUID })
    expect(host.facts()[0].agentSession).toBeNull()
    host.hookEvent(info.id, { event: 'UserPromptSubmit', detail: null, session: UUID })
    host.hookEvent(info.id, { event: 'Stop', detail: null, session: UUID })
    expect(host.facts()[0]).toMatchObject({ agentSession: UUID, pid: 99, kind: 'claude', cwd: HOME })
    expect(onAgentSession).toHaveBeenCalledTimes(1)
    host.hookEvent(info.id, { event: 'Stop', detail: null, session: UUID2 }) // /clear → a new conversation
    expect(host.facts()[0].agentSession).toBe(UUID2)
    expect(onAgentSession).toHaveBeenCalledTimes(2)
  })
})

describe('restoreSpawn launch argv (terminal controller)', () => {
  function ctl() {
    const created: Array<Record<string, unknown>> = []
    const c = createTermController({
      host: {
        create: (spec: Record<string, unknown>) => {
          created.push(spec)
          return { id: created.length, kind: spec.kind, project: spec.project, cwd: spec.cwd, shell: 'zsh', note: null }
        }
      } as unknown as PtyHost,
      listProjects: async () => PROJECTS,
      env: { SHELL: '/bin/zsh' },
      home: HOME,
      exists: (p) => p === '/bin/zsh',
      isDir: (p) => DIRS.has(p),
      agentLaunch: (id) => ({ path: null, args: id === 'claude' ? ['--dangerously-skip-permissions', '--model', 'opus'] : ['--dangerously-bypass-approvals-and-sandbox'] }),
      hooks: {
        endpointFile: '/ud/agent-hooks/endpoint.env',
        wire: (id, args) => (id === 'claude' ? { args: ['--settings', '/ud/s.json', ...args], mode: 'lifecycle' } : { args: ['-c', 'notify=[]', ...args], mode: 'turn-complete' })
      }
    })
    return { c, created }
  }
  const item = (over: Partial<RestoreItem>): RestoreItem => ({
    saved: tab(),
    kind: 'shell',
    project: null,
    cwd: HOME,
    resume: null,
    agentSession: null,
    how: 'shell',
    note: '',
    ...over
  })

  it('shell → a fresh login shell in the saved folder', () => {
    const { c, created } = ctl()
    c.restoreSpawn(item({ cwd: '/Users/me/Desktop' }))
    expect(created[0]).toMatchObject({ file: '/bin/zsh', args: ['-l'], cwd: '/Users/me/Desktop' })
  })

  it('Claude → hooks --settings + Yolo + extra args + --resume <id>, seeded with the id', () => {
    const { c, created } = ctl()
    c.restoreSpawn(item({ kind: 'claude', project: PROJECTS[0], cwd: TODO, resume: { mode: 'resume', id: UUID }, agentSession: UUID }))
    const script = (created[0].args as string[]).at(-1)!
    expect(script).toContain(`exec claude '--settings' '/ud/s.json' '--dangerously-skip-permissions' '--model' 'opus' '--resume' '${UUID}'`)
    expect(created[0]).toMatchObject({ cwd: TODO, project: 'orcha-todo', agentSession: UUID, hooks: { mode: 'lifecycle' } })
  })

  it('Claude continue / fresh; Codex resume subcommand first', () => {
    const { c, created } = ctl()
    c.restoreSpawn(item({ kind: 'claude', resume: { mode: 'continue' } }))
    c.restoreSpawn(item({ kind: 'claude' }))
    c.restoreSpawn(item({ kind: 'codex', resume: { mode: 'resume', id: UUID2 }, agentSession: UUID2 }))
    const scripts = created.map((s) => (s.args as string[]).at(-1)!)
    expect(scripts[0]).toMatch(/'--model' 'opus' '--continue'; else/)
    expect(scripts[1]).toMatch(/'--model' 'opus'; else/)
    expect(scripts[2]).toContain(`exec codex 'resume' '${UUID2}' '-c' 'notify=[]' '--dangerously-bypass-approvals-and-sandbox'`)
  })

  it('refuses a folder that is not a directory', () => {
    const { c } = ctl()
    expect(() => c.restoreSpawn(item({ cwd: '/nope' }))).toThrow()
  })
})

// ---- the keeper: persist on quit, restore on the next launch -----------------------------

function world(dir: string, opts: { restoreSessions?: boolean; resumeAgents?: boolean; projects?: typeof PROJECTS } = {}) {
  const prefs = { restoreSessions: opts.restoreSessions ?? true, resumeAgents: opts.resumeAgents ?? true }
  let facts: SessionFacts[] = []
  let nextId = 1
  const spawned: RestoreItem[] = []
  const timers: Array<() => void> = []
  const file = sessionsFilePath(dir)
  const deps: SessionKeeperDeps = {
    facts: () => facts,
    liveCount: () => facts.length,
    read: () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return null
      }
    },
    write: (s) => {
      writeFileSync(`${file}.tmp`, JSON.stringify(s))
      renameSync(`${file}.tmp`, file)
    },
    liveCwds: async (pids) => new Map(pids.map((p) => [p, '/Users/me/Desktop'])),
    liveCwdsSync: (pids) => new Map(pids.map((p) => [p, '/Users/me/Desktop'])),
    prefs: () => prefs,
    listProjects: async () => opts.projects ?? PROJECTS,
    home: HOME,
    isDir: (p) => DIRS.has(p),
    spawn: (item) => {
      spawned.push(item)
      const id = nextId++
      facts.push({ id, kind: item.kind, project: item.project?.project ?? null, branch: item.saved.branch, cwd: item.cwd, pid: 1000 + id, probe: false, exited: false, agentSession: item.agentSession })
      return { id, kind: item.kind, project: item.project?.project ?? null, cwd: item.cwd, shell: 'zsh', note: null } as TermInfo
    },
    now: () => 42,
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {}
  }
  const keeper = createSessionKeeper(deps)
  return {
    keeper,
    prefs,
    spawned,
    file,
    setFacts: (f: SessionFacts[]) => {
      facts = f
      nextId = Math.max(0, ...f.map((x) => x.id)) + 1
    },
    runTimers: async () => {
      while (timers.length) timers.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}

const fact = (over: Partial<SessionFacts>): SessionFacts => ({
  id: 1,
  kind: 'shell',
  project: null,
  branch: null,
  cwd: HOME,
  pid: 500,
  probe: false,
  exited: false,
  agentSession: null,
  ...over
})

describe('session keeper', () => {
  it('quit → relaunch: order, titles, pins, colours, selection, rows, shell cwd and the Claude id come back', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-restore-'))
    const a = world(dir)
    expect(await a.keeper.restore({})).toMatchObject({ tabs: [] }) // first launch: nothing saved
    a.setFacts([
      fact({ id: 1, pid: 501 }),
      fact({ id: 2, kind: 'claude', project: 'orcha-todo', cwd: TODO, pid: 502, agentSession: UUID, branch: 'main' }),
      fact({ id: 3, kind: 'codex', cwd: HOME, pid: 503 }),
      fact({ id: 4, kind: 'claude', cwd: HOME, pid: 504, probe: true }) // Test launch — never saved
    ])
    expect(
      a.keeper.layout({
        tabs: [
          { id: 2, title: null, pinned: true, color: 'pink', rowKey: 'orcha-todo:c1', launchBranch: null },
          { id: 1, title: 'scratch', pinned: false, color: 'teal', rowKey: null, launchBranch: null },
          { id: 3, title: null, pinned: false, color: null, rowKey: null, launchBranch: null }
        ],
        active: 1
      })
    ).toBe(true)
    a.keeper.freeze() // app quitting: sync write, then everything after is ignored
    a.keeper.layout({ tabs: [], active: null })
    await a.runTimers()
    const onDisk = JSON.parse(readFileSync(a.file, 'utf8'))
    expect(onDisk.tabs.map((t: SavedTab) => [t.kind, t.cwd, t.title, t.pinned, t.color, t.agentSession])).toEqual([
      ['claude', TODO, null, true, 'pink', UUID],
      ['shell', '/Users/me/Desktop', 'scratch', false, 'teal', null], // live cwd (lsof), not the launch cwd
      ['codex', HOME, null, false, null, null]
    ])
    expect(onDisk.active).toBe(1)

    const b = world(dir)
    const r = await b.keeper.restore({})
    expect(r.tabs.map((t) => [t.info.kind, t.title, t.pinned, t.color, t.rowKey, t.how])).toEqual([
      ['claude', null, true, 'pink', 'orcha-todo:c1', 'resumed'],
      ['shell', 'scratch', false, 'teal', null, 'shell'],
      ['codex', null, false, null, null, 'continued'] // no id captured, the only Codex tab in $HOME
    ])
    expect(r.active).toBe(r.tabs[1].info.id)
    expect(b.spawned[0]).toMatchObject({ cwd: TODO, resume: { mode: 'resume', id: UUID } })
    expect(b.spawned[1]).toMatchObject({ cwd: '/Users/me/Desktop' })
  })

  it('never writes before the launch restore has read the file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-restore-'))
    writeFileSync(sessionsFilePath(dir), JSON.stringify(saved([tab({ title: 'precious' })])))
    const w = world(dir)
    w.setFacts([fact({ id: 7 })])
    w.keeper.layout({ tabs: [{ id: 7, title: null, pinned: false, color: null, rowKey: null, launchBranch: null }], active: 7 })
    w.keeper.freeze()
    await w.runTimers()
    expect(JSON.parse(readFileSync(sessionsFilePath(dir), 'utf8')).tabs[0].title).toBe('precious')
  })

  it('setting off: nothing restored, the set is offered to ⌘K "Restore last session" (once)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-restore-'))
    writeFileSync(sessionsFilePath(dir), JSON.stringify(saved([tab({ title: 'a' }), tab({ title: 'b' })], 0)))
    const w = world(dir, { restoreSessions: false })
    const r = await w.keeper.restore({})
    expect(r).toMatchObject({ tabs: [], skipped: 2 })
    expect(w.spawned).toHaveLength(0)
    const m = await w.keeper.restore({ manual: true })
    expect(m.tabs.map((t) => t.title)).toEqual(['a', 'b'])
    expect(m.active).toBe(m.tabs[0].info.id)
    expect((await w.keeper.restore({ manual: true })).tabs).toEqual([])
  })

  it('a renderer reload with live sessions re-attaches instead of restoring again', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-restore-'))
    writeFileSync(sessionsFilePath(dir), JSON.stringify(saved([tab()])))
    const w = world(dir)
    w.setFacts([fact({ id: 3 })])
    expect(await w.keeper.restore({})).toMatchObject({ tabs: [] })
    expect(w.spawned).toHaveLength(0)
  })

  it('a corrupt file or a throwing spawn never blocks startup', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-restore-'))
    writeFileSync(sessionsFilePath(dir), '{not json')
    expect(await world(dir).keeper.restore({})).toMatchObject({ tabs: [], dropped: 0 })
    writeFileSync(sessionsFilePath(dir), JSON.stringify(saved([tab(), tab()])))
    let n = 0
    // Discovery down + the second spawn failing: the first tab still opens.
    const k = createSessionKeeper({
      facts: () => [],
      liveCount: () => 0,
      read: () => JSON.parse(readFileSync(sessionsFilePath(dir), 'utf8')),
      write: () => {},
      liveCwds: async () => new Map(),
      liveCwdsSync: () => new Map(),
      prefs: () => ({ restoreSessions: true, resumeAgents: true }),
      listProjects: async () => {
        throw new Error('docker down')
      },
      home: HOME,
      isDir: (p) => DIRS.has(p),
      spawn: () => {
        if (n++ === 1) throw new Error('spawn failed')
        return { id: n, kind: 'shell', project: null, cwd: HOME, shell: 'zsh', note: null }
      },
      now: () => 1,
      setTimer: () => 0,
      clearTimer: () => {}
    })
    const r = await k.restore({})
    expect(r.tabs).toHaveLength(1)
    expect(r.dropped).toBe(1)
  })

  it('tabs of a project not discovered at launch wait, are kept on disk, and open when it appears', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-restore-'))
    const later = tab({ kind: 'claude', project: 'orcha-later', cwd: '/Users/me/later', agentSession: UUID, title: 'later' })
    writeFileSync(sessionsFilePath(dir), JSON.stringify(saved([tab({ title: 'now' }), later])))
    const projects = [...PROJECTS]
    const w = world(dir, { projects })
    const r = await w.keeper.restore({})
    expect(r.tabs.map((t) => t.title)).toEqual(['now'])
    expect(r.deferred).toBe(1)
    await w.runTimers()
    expect(JSON.parse(readFileSync(w.file, 'utf8')).tabs.map((t: SavedTab) => t.title)).toEqual(['now', 'later'])
    expect((await w.keeper.restore({ project: 'orcha-later' })).tabs).toEqual([]) // still unknown
    projects.push({ project: 'orcha-later', projectShort: 'later', folder: '/Users/me/later' })
    DIRS.add('/Users/me/later')
    const p = await w.keeper.restore({ project: 'orcha-later' })
    DIRS.delete('/Users/me/later')
    expect(p.tabs.map((t) => [t.title, t.how])).toEqual([['later', 'resumed']])
    expect(p.deferred).toBe(0)
  })

  it('forgetProject: a removed project’s waiting tabs are dropped from disk and never reopen', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-restore-'))
    const gone = tab({ kind: 'claude', project: 'orcha-gone', cwd: '/Users/me/gone', title: 'gone' })
    const goneWeb = tab({ kind: 'shell', project: 'orcha-gone-web', cwd: '/Users/me/gone-web', title: 'gone-web' })
    writeFileSync(sessionsFilePath(dir), JSON.stringify(saved([tab({ title: 'now' }), gone, goneWeb])))
    const w = world(dir)
    const r = await w.keeper.restore({})
    expect(r.deferred).toBe(2)
    expect(w.keeper.forgetProject('orcha-gone')).toBe(1)
    await w.runTimers()
    // exact project match: orcha-gone-web's tab stays
    expect(JSON.parse(readFileSync(w.file, 'utf8')).tabs.map((t: SavedTab) => t.title)).toEqual(['now', 'gone-web'])
    expect((await w.keeper.restore({ project: 'orcha-gone' })).tabs).toEqual([])
  })

  it('forgetProject also prunes the skipped "Restore last session" set', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-restore-'))
    const gone = tab({ kind: 'claude', project: 'orcha-gone', cwd: '/Users/me/gone', title: 'gone' })
    writeFileSync(sessionsFilePath(dir), JSON.stringify(saved([tab({ title: 'a' }), gone], 0)))
    const w = world(dir, { restoreSessions: false })
    expect(await w.keeper.restore({})).toMatchObject({ skipped: 2 })
    expect(w.keeper.forgetProject('orcha-gone')).toBe(1)
    expect(w.keeper.skippedCount()).toBe(1)
    expect((await w.keeper.restore({ manual: true })).tabs.map((t) => t.title)).toEqual(['a'])
  })

  it('debounced saves pick up a newly captured conversation id', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orcha-restore-'))
    const w = world(dir)
    await w.keeper.restore({})
    w.setFacts([fact({ id: 1, kind: 'claude', cwd: HOME })])
    w.keeper.layout({ tabs: [{ id: 1, title: null, pinned: false, color: null, rowKey: null, launchBranch: null }], active: 1 })
    await w.runTimers()
    expect(JSON.parse(readFileSync(w.file, 'utf8')).tabs[0].agentSession).toBeNull()
    w.setFacts([fact({ id: 1, kind: 'claude', cwd: HOME, agentSession: UUID })])
    w.keeper.agentSessionChanged()
    await w.runTimers()
    expect(JSON.parse(readFileSync(w.file, 'utf8')).tabs[0].agentSession).toBe(UUID)
    expect(SAVE_DEBOUNCE_MS).toBeGreaterThan(0)
  })
})
