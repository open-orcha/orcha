import { describe, it, expect } from 'vitest'
import {
  composeNameOf,
  daemonPidFiles,
  folderBelongsTo,
  isQuorateBranch,
  isSafeFolder,
  parseContainers,
  parseDiskSizes,
  parseImages,
  parseLabeled,
  parseSize,
  parseWorktrees,
  projectContainers,
  projectImages,
  projectNetworks,
  projectSandboxes,
  projectVolumes,
  quorateWorktrees,
  stripManagedHooks
} from './projectCleanup'

// A machine with two stacks whose names share a prefix: orcha-acme and orcha-acme-web.
const PS = [
  'orcha-acme-portal-1\trunning\torcha-acme\t\t\torcha-acme_default',
  'orcha-acme-db-1\trunning\torcha-acme\t\t\torcha-acme_default',
  'orcha-acme-web-portal-1\trunning\torcha-acme-web\t\t\torcha-acme-web_default',
  'orcha-acme-web-db-1\trunning\torcha-acme-web\t\t\torcha-acme-web_default',
  'orcha-run-aaaaaaaaaaaa\texited\t\t1\tcid-acme\torcha-acme_default',
  'orcha-run-bbbbbbbbbbbb\trunning\t\t1\tcid-web\torcha-acme-web_default',
  'orcha-run-cccccccccccc\texited\t\t1\tcid-acme\t',
  'orcha-run-not-hex-name\texited\t\t1\tcid-acme\torcha-acme_default',
  'orcha-run-dddddddddddd\texited\t\t\tcid-acme\torcha-acme_default',
  'fq-integ-pg\trunning\t\t\t\tbridge'
].join('\n')
const VOLS = ['orcha-acme_pgdata\torcha-acme', 'orcha-acme-web_pgdata\torcha-acme-web', 'orcha-acme_extra\torcha-acme-web', 'unrelated_pgdata\t'].join('\n')
const NETS = ['bridge\t', 'orcha-acme_default\torcha-acme', 'orcha-acme-web_default\torcha-acme-web'].join('\n')
const IMGS = [
  'orcha-acme-portal\tlatest\tid1',
  'orcha-acme-web-portal\tlatest\tid2',
  'postgres\t16\tid3',
  'orcha-test/stub-runner\tlatest\tid4',
  '<none>\t<none>\tid5'
].join('\n')

describe('exact-match resource selection (never prefix globbing)', () => {
  const all = parseContainers(PS)

  it('selects only orcha-acme’s own containers, never orcha-acme-web’s', () => {
    expect(projectContainers(all, 'orcha-acme').map((c) => c.name)).toEqual(['orcha-acme-portal-1', 'orcha-acme-db-1'])
    expect(projectContainers(all, 'orcha-acme-web').map((c) => c.name)).toEqual(['orcha-acme-web-portal-1', 'orcha-acme-web-db-1'])
  })

  it('selects sandboxes by exact network or exact cid label, with the managed label and hex name', () => {
    expect(projectSandboxes(all, 'orcha-acme', 'cid-acme').map((c) => c.name)).toEqual(['orcha-run-aaaaaaaaaaaa', 'orcha-run-cccccccccccc'])
    // without a cid: only the network match
    expect(projectSandboxes(all, 'orcha-acme', null).map((c) => c.name)).toEqual(['orcha-run-aaaaaaaaaaaa'])
    expect(projectSandboxes(all, 'orcha-acme-web', 'cid-web').map((c) => c.name)).toEqual(['orcha-run-bbbbbbbbbbbb'])
  })

  it('volumes need the exact compose label AND the <project>_ name', () => {
    const vols = parseLabeled(VOLS)
    expect(projectVolumes(vols, 'orcha-acme')).toEqual(['orcha-acme_pgdata'])
    expect(projectVolumes(vols, 'orcha-acme-web')).toEqual(['orcha-acme-web_pgdata'])
  })

  it('network is exactly <project>_default with the project label', () => {
    const nets = parseLabeled(NETS)
    expect(projectNetworks(nets, 'orcha-acme')).toEqual(['orcha-acme_default'])
    expect(projectNetworks(nets, 'orcha-acme-web')).toEqual(['orcha-acme-web_default'])
  })

  it('image is exactly <project>-portal; shared images are never candidates', () => {
    const imgs = parseImages(IMGS)
    expect(projectImages(imgs, 'orcha-acme')).toEqual(['orcha-acme-portal:latest'])
    expect(projectImages(imgs, 'orcha-acme-web')).toEqual(['orcha-acme-web-portal:latest'])
    expect(imgs.find((i) => i.repository === '<none>')).toBeUndefined()
  })
})

describe('stripManagedHooks (surgical .claude/settings.json edit)', () => {
  const settings = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'orcha poll-inbox', timeout: 5 }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }, { type: 'command', command: 'orcha file-guard', timeout: 10 }] }
      ],
      SessionStart: [{ hooks: [{ type: 'command', command: 'orcha notifier --ensure', timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }]
    }
  }

  it('removes only managed hooks, keeping the user’s own hooks, matchers and other keys', () => {
    const r = stripManagedHooks(JSON.stringify(settings))
    expect(r.kind).toBe('write')
    if (r.kind !== 'write') return
    expect(r.removed).toBe(3)
    expect(JSON.parse(r.text)).toEqual({
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }]
      }
    })
  })

  it('never matches a user hook that merely calls orcha with other arguments', () => {
    const mine = { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'orcha poll-inbox --verbose' }, { type: 'command', command: 'echo orcha file-guard' }] }] } }
    expect(stripManagedHooks(JSON.stringify(mine))).toEqual({ kind: 'unchanged' })
  })

  it('a file holding only Embodent hooks can be deleted', () => {
    const only = { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'orcha snapshot', timeout: 30 }] }] } }
    expect(stripManagedHooks(JSON.stringify(only))).toEqual({ kind: 'delete', removed: 1 })
  })

  it('leaves invalid JSON (or a non-object) alone', () => {
    expect(stripManagedHooks('{ "hooks": [ oops')).toEqual({ kind: 'unparseable' })
    expect(stripManagedHooks('[]')).toEqual({ kind: 'unparseable' })
  })

  it('no hooks key → unchanged', () => {
    expect(stripManagedHooks('{"model":"opus"}')).toEqual({ kind: 'unchanged' })
  })
})

describe('folder ownership', () => {
  it('reads the compose name', () => {
    expect(composeNameOf('# header\nname: orcha-acme\n\nservices:\n')).toBe('orcha-acme')
    expect(composeNameOf(null)).toBeNull()
  })

  it('a folder belongs to a project only when its compose file (or orcha.json) names it exactly', () => {
    expect(folderBelongsTo('orcha-acme', 'name: orcha-acme\n', null)).toBe(true)
    expect(folderBelongsTo('orcha-acme', 'name: orcha-acme-web\n', null)).toBe(false)
    expect(folderBelongsTo('orcha-acme', null, '{"project_name":"acme"}')).toBe(true)
    expect(folderBelongsTo('orcha-acme', null, '{"project_name":"acme-web"}')).toBe(false)
    expect(folderBelongsTo('orcha-acme', null, null)).toBe(false)
  })

  it('only acts on absolute, normalised, non-root folders', () => {
    expect(isSafeFolder('/Users/me/acme')).toBe(true)
    expect(isSafeFolder('/')).toBe(false)
    expect(isSafeFolder('/Users')).toBe(false)
    expect(isSafeFolder('relative/acme')).toBe(false)
    expect(isSafeFolder('/Users/me/../acme')).toBe(false)
    expect(isSafeFolder('/Users/me/acme/')).toBe(false)
    expect(isSafeFolder(null)).toBe(false)
  })

  it('pid files: the folder’s two and the global notifier one (validated cid)', () => {
    expect(daemonPidFiles('/Users/me/acme', 'cid-1', '/Users/me')).toEqual([
      '/Users/me/acme/.claude/.orcha-notifier.pid',
      '/Users/me/acme/.claude/.orcha-terminal-bridge.pid',
      '/Users/me/.orcha/notifier-cid-1.pid'
    ])
    expect(daemonPidFiles(null, '../../etc/passwd', '/Users/me')).toEqual([])
  })
})

describe('worktrees', () => {
  const porcelain = [
    'worktree /Users/me/acme',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /Users/me/acme/.orcha-worktrees/task-login',
    'HEAD def',
    'branch refs/heads/orcha/task-login',
    '',
    'worktree /Users/me/elsewhere',
    'branch refs/heads/feature',
    ''
  ].join('\n')

  it('keeps only worktrees directly under .orcha-worktrees/', () => {
    const all = parseWorktrees(porcelain)
    expect(all).toHaveLength(3)
    expect(quorateWorktrees(all, '/Users/me/acme')).toEqual([{ path: '/Users/me/acme/.orcha-worktrees/task-login', branch: 'orcha/task-login' }])
  })

  it('Embodent branches are orcha/<slug> only', () => {
    expect(isQuorateBranch('orcha/task-login')).toBe(true)
    expect(isQuorateBranch('main')).toBe(false)
    expect(isQuorateBranch('orcha/../main')).toBe(false)
    expect(isQuorateBranch(null)).toBe(false)
  })
})

describe('sizes', () => {
  it('parses docker size strings', () => {
    expect(parseSize('347MB')).toBe(347_000_000)
    expect(parseSize('12.69kB')).toBe(12_690)
    expect(parseSize('1.2GB')).toBe(1_200_000_000)
    expect(parseSize('0B')).toBe(0)
    expect(parseSize('N/A')).toBeNull()
  })

  it('reads unique image sizes and volume sizes from `system df -v`', () => {
    const json = JSON.stringify({
      Images: [{ Repository: 'orcha-acme-portal', Tag: 'latest', Size: '347MB', UniqueSize: '24.9MB' }],
      Volumes: [{ Name: 'orcha-acme_pgdata', Size: '66.8MB' }]
    })
    const s = parseDiskSizes(json)
    expect(s.images.get('orcha-acme-portal:latest')).toBe(24_900_000)
    expect(s.volumes.get('orcha-acme_pgdata')).toBe(66_800_000)
    expect(parseDiskSizes('not json').images.size).toBe(0)
  })
})
