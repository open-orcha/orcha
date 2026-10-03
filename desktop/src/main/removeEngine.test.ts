import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { dockerFailure, planRemoval, removeProject, type RemoveDeps, type RemoveFs } from './removeEngine'
import type { ProcessDeps } from './daemonCleanup'

const FOLDER = '/Users/me/acme'
const HOME = '/Users/me'

/** In-memory fs: files (path → text) and dirs (set). */
function memFs(files: Record<string, string>, dirs: string[] = []) {
  const f = new Map(Object.entries(files))
  const d = new Set(dirs)
  for (const p of [...f.keys(), ...d]) {
    let cur = path.dirname(p)
    while (cur !== '/' && cur !== '.') {
      d.add(cur)
      cur = path.dirname(cur)
    }
  }
  const under = (p: string): string[] => [...f.keys(), ...d].filter((x) => x.startsWith(`${p}/`))
  const fs: RemoveFs = {
    readText: (p) => f.get(p) ?? null,
    exists: (p) => f.has(p) || d.has(p),
    listDir: (p) => (d.has(p) ? [...new Set(under(p).map((x) => x.slice(p.length + 1).split('/')[0]))] : null),
    writeText: (p, t) => void f.set(p, t),
    rmrf: (p) => {
      f.delete(p)
      d.delete(p)
      for (const x of under(p)) {
        f.delete(x)
        d.delete(x)
      }
    },
    rmFile: (p) => void f.delete(p),
    rmdirIfEmpty: (p) => {
      if (d.has(p) && under(p).length === 0) d.delete(p)
    }
  }
  return { fs, files: f, dirs: d }
}

const projectFiles = (): Record<string, string> => ({
  [`${FOLDER}/src/index.ts`]: 'user code',
  [`${FOLDER}/.git/HEAD`]: 'ref: refs/heads/main',
  [`${FOLDER}/.orcha/docker-compose.yml`]: 'name: orcha-acme\nservices: {}\n',
  [`${FOLDER}/.orcha/agent-home/session.jsonl`]: '{}',
  [`${FOLDER}/.claude/orcha.json`]: JSON.stringify({ project_name: 'acme', current_container_id: 'cid-acme' }),
  [`${FOLDER}/.claude/.orcha-notifier.pid`]: '123',
  [`${FOLDER}/.claude/.orcha-terminal-bridge.pid`]: '124',
  [`${FOLDER}/.claude/orcha-tabs/lead.json`]: '{}',
  [`${FOLDER}/.claude/commands/orcha-inbox.md`]: '# inbox',
  [`${FOLDER}/.claude/commands/my-own.md`]: '# mine',
  [`${FOLDER}/.claude/CLAUDE.md`]: 'my notes',
  [`${FOLDER}/.claude/settings.json`]: JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'orcha poll-inbox', timeout: 5 }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }
      ]
    }
  }),
  [`${FOLDER}/.agents/skills/orcha-inbox/SKILL.md`]: 'skill',
  [`${FOLDER}/.agents/skills/my-skill/SKILL.md`]: 'mine',
  [`${HOME}/.orcha/notifier-cid-acme.pid`]: '123',
  [`${HOME}/.orcha/notifier-cid-other.pid`]: '999'
})

/** A fake docker whose listings shrink as resources are removed. */
function fakeDocker(opts: { fail?: (args: string[]) => unknown } = {}) {
  let containers = [
    'orcha-acme-portal-1\trunning\torcha-acme\t\t\torcha-acme_default',
    'orcha-acme-db-1\trunning\torcha-acme\t\t\torcha-acme_default',
    'orcha-acme-web-portal-1\trunning\torcha-acme-web\t\t\torcha-acme-web_default',
    'orcha-acme-web-db-1\trunning\torcha-acme-web\t\t\torcha-acme-web_default',
    'orcha-run-aaaaaaaaaaaa\texited\t\t1\tcid-acme\torcha-acme_default',
    'orcha-run-bbbbbbbbbbbb\trunning\t\t1\tcid-web\torcha-acme-web_default'
  ]
  let volumes = ['orcha-acme_pgdata\torcha-acme', 'orcha-acme-web_pgdata\torcha-acme-web']
  let networks = ['orcha-acme_default\torcha-acme', 'orcha-acme-web_default\torcha-acme-web']
  const images = ['orcha-acme-portal\tlatest\tid1', 'orcha-acme-web-portal\tlatest\tid2', 'postgres\t16\tid3']
  const calls: string[][] = []
  const docker = vi.fn(async (args: string[]) => {
    calls.push(args)
    const f = opts.fail?.(args)
    if (f) throw f
    const [a, b] = args
    if (a === 'ps') return { stdout: containers.join('\n') }
    if (a === 'volume' && b === 'ls') return { stdout: volumes.join('\n') }
    if (a === 'network' && b === 'ls') return { stdout: networks.join('\n') }
    if (a === 'images') return { stdout: images.join('\n') }
    if (a === 'system') return { stdout: JSON.stringify({ Images: [{ Repository: 'orcha-acme-portal', Tag: 'latest', UniqueSize: '24.9MB' }], Volumes: [{ Name: 'orcha-acme_pgdata', Size: '66.8MB' }] }) }
    if (a === 'compose' && args.includes('down')) {
      const p = args[args.indexOf('-p') + 1]
      containers = containers.filter((c) => c.split('\t')[2] !== p)
      networks = networks.filter((n) => n.split('\t')[1] !== p)
      if (args.includes('-v')) volumes = volumes.filter((v) => v.split('\t')[1] !== p)
    }
    if (a === 'rm') containers = containers.filter((c) => !args.includes(c.split('\t')[0]))
    if (a === 'volume' && b === 'rm') volumes = volumes.filter((v) => !args.includes(v.split('\t')[0]))
    return { stdout: '' }
  })
  return { docker, calls, state: () => ({ containers, volumes, networks }) }
}

function noProcs(): ProcessDeps {
  return { findByCommand: vi.fn().mockResolvedValue([]), cwdOf: vi.fn().mockResolvedValue(null), kill: vi.fn() }
}

function deps(over: Partial<RemoveDeps> & { files?: Record<string, string> } = {}) {
  const mem = memFs(over.files ?? projectFiles())
  const dk = fakeDocker()
  const run = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args.includes('list')) return { stdout: `worktree ${FOLDER}\nbranch refs/heads/main\n` }
    return { stdout: '' }
  })
  const d: RemoveDeps = { docker: dk.docker, run, fs: mem.fs, home: HOME, processDeps: noProcs(), ...over }
  return { d, mem, dk, run }
}

const KEEP = { deleteData: false, removeFiles: false }

describe('removeProject — command construction', () => {
  it('rejects a non-orcha project before running anything', async () => {
    const { d, dk, run } = deps()
    await expect(removeProject('orcha-acme; rm -rf /', 'acme', FOLDER, KEEP, d)).rejects.toEqual({ code: 'UNKNOWN_STACK' })
    expect(dk.docker).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('default: `orcha down` (no -v) and `compose down` WITHOUT -v; the volume is kept', async () => {
    const { d, dk, run } = deps()
    const res = await removeProject('orcha-acme', 'acme', FOLDER, KEEP, d)
    expect(run).toHaveBeenCalledWith('orcha', ['down'], FOLDER)
    const down = dk.calls.find((a) => a[0] === 'compose')
    expect(down).toEqual(['compose', '-p', 'orcha-acme', 'down'])
    expect(dk.calls.some((a) => a[0] === 'volume' && a[1] === 'rm')).toBe(false)
    expect(dk.state().volumes).toContain('orcha-acme_pgdata\torcha-acme')
    expect(res.kept).toContain('Data orcha-acme_pgdata')
    expect(res.dataDeleted).toBe(false)
  })

  it('deleteData: `orcha down -v`, `compose down -v`, and only this project’s volume', async () => {
    const { d, dk, run } = deps()
    await removeProject('orcha-acme', 'acme', FOLDER, { deleteData: true, removeFiles: false }, d)
    expect(run).toHaveBeenCalledWith('orcha', ['down', '-v'], FOLDER)
    expect(dk.calls.find((a) => a[0] === 'compose')).toEqual(['compose', '-p', 'orcha-acme', 'down', '-v'])
    expect(dk.state().volumes).toEqual(['orcha-acme-web_pgdata\torcha-acme-web'])
  })

  it('every call is an argv array (no shell string, no interpolation)', async () => {
    const { d, dk, run } = deps()
    await removeProject('orcha-acme', 'acme', FOLDER, { deleteData: true, removeFiles: true }, d)
    for (const args of [...dk.calls, ...run.mock.calls.map((c) => c[1] as string[])]) {
      expect(Array.isArray(args)).toBe(true)
      for (const a of args) expect(a).not.toMatch(/[;&|`$]|\s&&\s/)
    }
    for (const c of run.mock.calls) expect(['orcha', 'git']).toContain(c[0])
  })

  it('removes this project’s sandbox, network and image — never orcha-acme-web’s', async () => {
    const { d, dk } = deps()
    await removeProject('orcha-acme', 'acme', FOLDER, KEEP, d)
    expect(dk.calls).toContainEqual(['rm', '-f', '-v', 'orcha-run-aaaaaaaaaaaa'])
    expect(dk.calls).toContainEqual(['image', 'rm', 'orcha-acme-portal:latest'])
    const flat = dk.calls.flat()
    expect(flat).not.toContain('orcha-run-bbbbbbbbbbbb')
    expect(flat).not.toContain('orcha-acme-web-portal:latest')
    expect(flat).not.toContain('orcha-acme-web')
    expect(flat).not.toContain('postgres:16')
    expect(dk.state().containers.some((c) => c.startsWith('orcha-acme-web-portal-1'))).toBe(true)
  })

  it('the image is removed without -f (a shared or in-use image stays, with a warning)', async () => {
    const { d } = deps()
    const dk = fakeDocker({ fail: (a) => (a[0] === 'image' && a[1] === 'rm' ? { stderr: 'image is being used' } : null) })
    const res = await removeProject('orcha-acme', 'acme', FOLDER, KEEP, { ...d, docker: dk.docker })
    expect(dk.calls.find((a) => a[0] === 'image')).toEqual(['image', 'rm', 'orcha-acme-portal:latest'])
    expect(res.warnings.join(' ')).toMatch(/in use/)
  })

  it('stops the daemons and removes exactly their pid files (folder + this cid’s global one)', async () => {
    const { d, mem } = deps()
    await removeProject('orcha-acme', 'acme', FOLDER, KEEP, d)
    expect(mem.files.has(`${FOLDER}/.claude/.orcha-notifier.pid`)).toBe(false)
    expect(mem.files.has(`${FOLDER}/.claude/.orcha-terminal-bridge.pid`)).toBe(false)
    expect(mem.files.has(`${HOME}/.orcha/notifier-cid-acme.pid`)).toBe(false)
    expect(mem.files.has(`${HOME}/.orcha/notifier-cid-other.pid`)).toBe(true)
  })

  it('default keeps every file in the folder except the daemon pid files', async () => {
    const { d, mem } = deps()
    const before = [...mem.files.keys()].filter((p) => p.startsWith(FOLDER) && !p.endsWith('.pid'))
    await removeProject('orcha-acme', 'acme', FOLDER, KEEP, d)
    for (const p of before) expect(mem.files.has(p)).toBe(true)
  })

  it('never runs `orcha down` or touches files in a folder that now belongs to ANOTHER stack', async () => {
    const files = { ...projectFiles(), [`${FOLDER}/.orcha/docker-compose.yml`]: 'name: orcha-acme-web\n' }
    const { d, mem, run } = deps({ files })
    const res = await removeProject('orcha-acme', 'acme', FOLDER, { deleteData: false, removeFiles: true }, d)
    expect(run).not.toHaveBeenCalledWith('orcha', expect.anything(), expect.anything())
    expect(mem.files.has(`${FOLDER}/.orcha/docker-compose.yml`)).toBe(true)
    expect(mem.files.has(`${FOLDER}/.claude/.orcha-notifier.pid`)).toBe(true)
    expect(res.warnings.join(' ')).toMatch(/untouched/)
  })

  it('Docker not running → DOCKER_UNAVAILABLE (plain words in the dialog)', async () => {
    const { d } = deps()
    const dk = fakeDocker({ fail: () => ({ stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' }) })
    await expect(removeProject('orcha-acme', 'acme', FOLDER, KEEP, { ...d, docker: dk.docker })).rejects.toEqual({ code: 'DOCKER_UNAVAILABLE' })
  })

  it('a compose hiccup still removes the stack’s containers directly (graceful stop, then rm)', async () => {
    const { d } = deps()
    const dk = fakeDocker({ fail: (a) => (a[0] === 'compose' ? { stderr: 'compose: weird error' } : null) })
    await removeProject('orcha-acme', 'acme', FOLDER, KEEP, { ...d, docker: dk.docker })
    expect(dk.calls).toContainEqual(['stop', 'orcha-acme-portal-1', 'orcha-acme-db-1'])
    expect(dk.calls).toContainEqual(['rm', 'orcha-acme-portal-1', 'orcha-acme-db-1'])
  })

  it('reports phases in order', async () => {
    const { d } = deps()
    const phases: string[] = []
    await removeProject('orcha-acme', 'acme', FOLDER, { deleteData: true, removeFiles: true }, d, (p) => phases.push(p))
    expect(phases).toEqual(['stopping', 'removing', 'deleting-data', 'removing-files', 'cleaning'])
  })
})

describe('removeProject — Remove Embodent’s files', () => {
  const WT = `${FOLDER}/.orcha-worktrees`
  const gitRun = (opts: { dirty?: string[]; unmerged?: string[] } = {}) =>
    vi.fn(async (cmd: string, args: string[]) => {
      if (cmd !== 'git') return { stdout: '' }
      if (args.includes('list'))
        return {
          stdout: [
            `worktree ${FOLDER}`,
            'branch refs/heads/main',
            '',
            `worktree ${WT}/task-login`,
            'branch refs/heads/orcha/task-login',
            '',
            `worktree ${WT}/task-wip`,
            'branch refs/heads/orcha/task-wip',
            '',
            `worktree ${WT}/task-dirty`,
            'branch refs/heads/orcha/task-dirty',
            ''
          ].join('\n')
        }
      if (args.includes('remove') && opts.dirty?.some((d) => args.includes(`${WT}/${d}`))) throw { stderr: 'contains modified or untracked files' }
      if (args.includes('--is-ancestor') && opts.unmerged?.some((b) => args.includes(b))) throw { stderr: '' }
      return { stdout: '' }
    })

  it('removes Embodent files only; keeps the user’s code, own commands/skills, CLAUDE.md and hooks', async () => {
    const run = gitRun({ dirty: ['task-dirty'], unmerged: ['orcha/task-wip'] })
    const { d, mem } = deps({ run })
    const res = await removeProject('orcha-acme', 'acme', FOLDER, { deleteData: false, removeFiles: true }, d)
    // gone
    for (const p of ['.orcha/docker-compose.yml', '.orcha/agent-home/session.jsonl', '.claude/orcha.json', '.claude/orcha-tabs/lead.json', '.claude/commands/orcha-inbox.md', '.agents/skills/orcha-inbox/SKILL.md']) {
      expect(mem.files.has(`${FOLDER}/${p}`)).toBe(false)
    }
    // kept
    for (const p of ['src/index.ts', '.git/HEAD', '.claude/commands/my-own.md', '.claude/CLAUDE.md', '.agents/skills/my-skill/SKILL.md']) {
      expect(mem.files.has(`${FOLDER}/${p}`)).toBe(true)
    }
    expect(JSON.parse(mem.files.get(`${FOLDER}/.claude/settings.json`) as string)).toEqual({
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] }
    })
    expect(res.filesRemoved).toBe(true)
    // worktrees: removed without --force; dirty kept; only merged orcha/* branches deleted (with -d)
    const gitCalls = run.mock.calls.filter((c) => c[0] === 'git').map((c) => c[1] as string[])
    expect(gitCalls).toContainEqual(['-C', FOLDER, 'worktree', 'remove', `${WT}/task-login`])
    expect(gitCalls.flat()).not.toContain('--force')
    expect(gitCalls.flat()).not.toContain('-D')
    expect(gitCalls).toContainEqual(['-C', FOLDER, 'branch', '-d', 'orcha/task-login'])
    expect(gitCalls).not.toContainEqual(['-C', FOLDER, 'branch', '-d', 'orcha/task-wip'])
    expect(gitCalls).not.toContainEqual(['-C', FOLDER, 'branch', '-d', 'orcha/task-dirty'])
    expect(res.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/task-dirty.*uncommitted/), expect.stringMatching(/orcha\/task-wip.*isn't merged/)])
    )
  })

  it('deletes settings.json only when it held nothing but Embodent hooks', async () => {
    const files = {
      ...projectFiles(),
      [`${FOLDER}/.claude/settings.json`]: JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'orcha snapshot' }] }] } })
    }
    const { d, mem } = deps({ files })
    await removeProject('orcha-acme', 'acme', FOLDER, { deleteData: false, removeFiles: true }, d)
    expect(mem.files.has(`${FOLDER}/.claude/settings.json`)).toBe(false)
    expect(mem.files.has(`${FOLDER}/.claude/CLAUDE.md`)).toBe(true)
  })
})

describe('planRemoval', () => {
  it('lists exactly what would go, with sizes, and the folder files', async () => {
    const { d } = deps()
    const plan = await planRemoval('orcha-acme', 'acme', FOLDER, d)
    expect(plan.containers).toEqual(['orcha-acme-portal-1', 'orcha-acme-db-1'])
    expect(plan.sandboxes).toEqual(['orcha-run-aaaaaaaaaaaa'])
    expect(plan.networks).toEqual(['orcha-acme_default'])
    expect(plan.images).toEqual([{ name: 'orcha-acme-portal:latest', size: 24_900_000 }])
    expect(plan.volumes).toEqual([{ name: 'orcha-acme_pgdata', size: 66_800_000 }])
    expect(plan.folderMatches).toBe(true)
    expect(plan.folderFiles).toEqual(expect.arrayContaining(['.orcha', '.claude/orcha.json', '.claude/settings.json (Embodent hooks only)']))
    expect(plan.daemonPidFiles).toContain(`${HOME}/.orcha/notifier-cid-acme.pid`)
  })

  it('makes no changes', async () => {
    const { d, dk, mem } = deps()
    const before = new Map(mem.files)
    await planRemoval('orcha-acme', 'acme', FOLDER, d)
    expect(dk.calls.every((a) => ['ps', 'volume', 'network', 'images', 'system'].includes(a[0]) && !a.includes('rm'))).toBe(true)
    expect(mem.files).toEqual(before)
  })
})

describe('dockerFailure', () => {
  it('daemon down / missing binary → DOCKER_UNAVAILABLE; else the stderr tail', () => {
    expect(dockerFailure({ code: 'ENOENT' })).toEqual({ code: 'DOCKER_UNAVAILABLE' })
    expect(dockerFailure({ stderr: 'Is the docker daemon running?' })).toEqual({ code: 'DOCKER_UNAVAILABLE' })
    expect(dockerFailure({ stderr: 'boom' })).toEqual({ code: 'COMPOSE_FAILED', stderr: 'boom' })
  })
})

describe('removeProject — agent worktrees through the CLI classification', () => {
  const WT = `${FOLDER}/.orcha-worktrees`
  const row = (name: string, state: string, extra: Record<string, unknown> = {}) => ({
    path: `${WT}/${name}`, name, branch: `orcha/${name}`, kind: 'wake', agent: 'Atlas', state, size_bytes: 1000, ...extra
  })
  const ROWS = [
    row('wk-scaffold', 'clean', { reason: 'only Embodent scaffolding — safe to remove' }),
    row('task-qa', 'has-output', { output: ['qa-runs/report.md'] }),
    row('wk-ahead', 'unmerged', { unmerged_commits: 2 }),
    row('live-Atlas', 'in-use'),
    { ...row('truck', 'not-quorate'), branch: 'feat/truck-card-profit' }
  ]
  const cliRun = () =>
    vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('list')) {
        return { stdout: [`worktree ${FOLDER}`, 'branch refs/heads/main', '', ...ROWS.flatMap((r) => [`worktree ${r.path}`, `branch refs/heads/${r.branch}`, ''])].join('\n') }
      }
      if (cmd === 'orcha' && args[0] === 'worktrees') {
        if (args[1] === 'list') return { stdout: JSON.stringify({ ok: true, items: ROWS }) + '\n' }
        if (args[1] === 'save-output') return { stdout: JSON.stringify({ ok: true, attached: ['qa-runs/report.md'], saved: [] }) }
        if (args[1] === 'remove') return { stdout: JSON.stringify({ ok: true, outcome: 'removed', reason: 'ok', branch_note: 'deleted' }) }
      }
      return { stdout: '' }
    })
  const orchaCalls = (run: ReturnType<typeof cliRun>) => run.mock.calls.filter((c) => c[0] === 'orcha').map((c) => (c[1] as string[]).slice(0, 3).join(' '))

  it('scaffolding-only worktrees are not "changes"; output is saved before the stack stops', async () => {
    const run = cliRun()
    const files = { ...projectFiles(), [`${FOLDER}/.orcha/saved-output/wk-old/notes.md`]: 'saved earlier' }
    const { d, mem } = deps({ run, files })
    const res = await removeProject('orcha-acme', 'acme', FOLDER, { deleteData: false, removeFiles: true }, d)
    const calls = orchaCalls(run)
    // the output was saved while the portal still ran — before `orcha down`
    expect(calls.indexOf(`worktrees save-output ${WT}/task-qa`)).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf(`worktrees save-output ${WT}/task-qa`)).toBeLessThan(calls.indexOf('down'))
    // clean + saved has-output go through the CLI's safe remove; nothing else is touched
    expect(calls).toContain(`worktrees remove ${WT}/wk-scaffold`)
    expect(calls).toContain(`worktrees remove ${WT}/task-qa`)
    for (const kept of ['wk-ahead', 'live-Atlas', 'truck']) expect(calls).not.toContain(`worktrees remove ${WT}/${kept}`)
    const gitCalls = run.mock.calls.filter((c) => c[0] === 'git').map((c) => c[1] as string[])
    expect(gitCalls.some((a) => a.includes('remove'))).toBe(false)
    expect(res.removed).toEqual(expect.arrayContaining(['Worktree wk-scaffold', 'Branch orcha/wk-scaffold', 'Saved the output of task-qa']))
    expect(res.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/wk-ahead.*orcha\/wk-ahead has commits that aren't merged/),
      expect.stringMatching(/live-Atlas.*still running/),
      expect.stringMatching(/truck.*isn't a Embodent worktree/)
    ]))
    expect(res.warnings.some((w) => /uncommitted/.test(w))).toBe(false)
    // saved agent output survives the .orcha removal
    expect(mem.files.get(`${FOLDER}/.orcha/saved-output/wk-old/notes.md`)).toBe('saved earlier')
    expect(mem.files.has(`${FOLDER}/.orcha/docker-compose.yml`)).toBe(false)
    expect(res.kept).toContain('Saved agent output in .orcha/saved-output')
  })

  it('"Save agent output first" unticked keeps worktrees with output', async () => {
    const run = cliRun()
    const { d } = deps({ run })
    const res = await removeProject('orcha-acme', 'acme', FOLDER, { deleteData: false, removeFiles: true, saveOutput: false }, d)
    const calls = orchaCalls(run)
    expect(calls.some((c) => c.startsWith('worktrees save-output'))).toBe(false)
    expect(calls).not.toContain(`worktrees remove ${WT}/task-qa`)
    expect(calls).toContain(`worktrees remove ${WT}/wk-scaffold`)
    expect(res.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/task-qa.*output you chose not to save/)]))
  })

  it('the plan carries each worktree’s state and the files that would be saved', async () => {
    const run = cliRun()
    const { d } = deps({ run })
    const plan = await planRemoval('orcha-acme', 'acme', FOLDER, d)
    expect(plan.worktrees.map((w) => [w.path.split('/').pop(), w.state])).toEqual([
      ['wk-scaffold', 'clean'], ['task-qa', 'has-output'], ['wk-ahead', 'unmerged'], ['live-Atlas', 'in-use'], ['truck', 'not-quorate']
    ])
    expect(plan.worktrees[1].files).toEqual(['qa-runs/report.md'])
    expect(orchaCalls(run).every((c) => c.startsWith('worktrees list'))).toBe(true) // planning changes nothing
  })
})
