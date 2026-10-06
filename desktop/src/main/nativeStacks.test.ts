import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  STATE_FRESH_MS,
  healthOf,
  listNativeStacks,
  readKnownFolders,
  readRegistry,
  rememberNativeFolder
} from './nativeStacks'

// Fixtures copy the shapes the CLI writes: stacks.json = cli_stacks_registry.register(),
// state.*.json = cli_serve.Supervisor.state(), orcha.native.json = `orcha init --runtime native`.
const FIXTURES = path.join(__dirname, '__fixtures__', 'nativeStacks')
let root: string

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8').replaceAll('__ROOT__', root)
}

function project(name: string, files: { state?: string; config?: string }, mtimeMs?: number): string {
  const folder = path.join(root, name)
  mkdirSync(path.join(folder, '.orcha'), { recursive: true })
  mkdirSync(path.join(folder, '.claude'), { recursive: true })
  if (files.state) {
    const file = path.join(folder, '.orcha', 'state.json')
    writeFileSync(file, fixture(files.state))
    if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  }
  if (files.config) writeFileSync(path.join(folder, '.claude', 'orcha.json'), fixture(files.config))
  return folder
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'native-stacks-'))
  writeFileSync(path.join(root, 'stacks.json'), fixture('stacks.json'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('readRegistry', () => {
  it('reads the CLI registry keyed by project name', () => {
    const reg = readRegistry(path.join(root, 'stacks.json'))
    expect(Object.keys(reg)).toEqual(['notes', 'wedged'])
    expect(reg.notes).toMatchObject({ path: path.join(root, 'notes'), api_port: 8010, runtime: 'native' })
  })
  it('is {} when the file is missing, half-written or not an object', () => {
    expect(readRegistry(path.join(root, 'nope.json'))).toEqual({})
    writeFileSync(path.join(root, 'torn.json'), '{"notes": {"pa')
    expect(readRegistry(path.join(root, 'torn.json'))).toEqual({})
    writeFileSync(path.join(root, 'list.json'), '[]')
    expect(readRegistry(path.join(root, 'list.json'))).toEqual({})
  })
})

describe('healthOf', () => {
  const now = 1_000_000_000
  const running = { state: { status: 'running', children: { portal: { status: 'running' } } }, mtimeMs: now }
  it('maps state.json + probe to ok / starting / crashlooping / stopped', () => {
    expect(healthOf(running, true, now)).toBe('ok')
    expect(healthOf(running, false, now)).toBe('starting')
    expect(
      healthOf({ state: { status: 'running', children: { notifier: { status: 'crashlooping' } } }, mtimeMs: now }, true, now)
    ).toBe('crashlooping')
    expect(healthOf({ state: { status: 'stopped' }, mtimeMs: now }, false, now)).toBe('stopped')
    expect(healthOf(null, false, now)).toBe('stopped')
  })
  it('treats a running state older than 90 s as stopped (serve died without cleaning up)', () => {
    expect(healthOf({ ...running, mtimeMs: now - STATE_FRESH_MS }, true, now)).toBe('stopped')
    expect(healthOf({ ...running, mtimeMs: now - STATE_FRESH_MS + 1 }, true, now)).toBe('ok')
  })
})

describe('listNativeStacks', () => {
  it('lists registered + known native projects in the Stack shape, with health', async () => {
    const now = Date.now()
    project('notes', { state: 'state.running.json' }, now)
    project('wedged', { state: 'state.crashlooping.json' }, now)
    const archive = project('archive', { state: 'state.stopped.json', config: 'orcha.native.json' }, now)
    const probe = vi.fn(async (port: number) => port === 8010 || port === 8011)

    const stacks = await listNativeStacks({
      registryFile: path.join(root, 'stacks.json'),
      knownFolders: [archive, path.join(root, 'notes')],
      probe,
      now
    })

    expect(stacks).toEqual([
      {
        project: 'orcha-archive',
        projectShort: 'archive',
        apiPort: 8012,
        dbPort: null,
        portalStatus: 'Down',
        running: false,
        folder: archive,
        runtime: 'native',
        health: 'stopped'
      },
      {
        project: 'orcha-notes',
        projectShort: 'notes',
        apiPort: 8010,
        dbPort: null,
        portalStatus: 'Up (native)',
        running: true,
        folder: path.join(root, 'notes'),
        runtime: 'native',
        health: 'ok'
      },
      expect.objectContaining({ projectShort: 'wedged', running: true, health: 'crashlooping' })
    ])
    // A stopped project is never probed (no 1.5 s wait per stopped card).
    expect(probe).not.toHaveBeenCalledWith(8012)
  })

  it('ignores a known folder that is not (or no longer) a native project', async () => {
    const dockerish = path.join(root, 'old-docker')
    mkdirSync(path.join(dockerish, '.claude'), { recursive: true })
    writeFileSync(path.join(dockerish, '.claude', 'orcha.json'), JSON.stringify({ api_port: 8001 }))
    const stacks = await listNativeStacks({
      registryFile: path.join(root, 'missing.json'),
      knownFolders: [dockerish, path.join(root, 'gone')],
      probe: async () => true
    })
    expect(stacks).toEqual([])
  })

  it('a registered project whose serve died shows as stopped, not running', async () => {
    const now = Date.now()
    project('notes', { state: 'state.running.json' }, now - STATE_FRESH_MS - 5_000)
    const [notes] = await listNativeStacks({
      registryFile: path.join(root, 'stacks.json'),
      probe: async () => true,
      now
    })
    expect(notes).toMatchObject({ projectShort: 'notes', running: false, health: 'stopped', portalStatus: 'Down' })
  })
})

describe('known native folders', () => {
  it('remembers each folder once and survives a missing file', () => {
    const dir = path.join(root, 'userData')
    expect(readKnownFolders(dir)).toEqual([])
    rememberNativeFolder(dir, '/Users/me/notes')
    rememberNativeFolder(dir, '/Users/me/notes')
    rememberNativeFolder(dir, '/Users/me/archive')
    expect(readKnownFolders(dir)).toEqual(['/Users/me/notes', '/Users/me/archive'])
  })
})
