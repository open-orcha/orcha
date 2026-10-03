import { describe, it, expect } from 'vitest'
import {
  isBranchName,
  parseLayout,
  parseRestoreRequest,
  parseMetaEvent,
  TERM_META_TEXT_MAX,
  chunkWrite,
  isTermKind,
  parseCreateRequest,
  parseResize,
  parseTermId,
  parseWrite,
  TERM_WRITE_MAX
} from './terminal'

describe('parseCreateRequest', () => {
  const ok = { kind: 'shell', project: 'orcha-todo-app', cols: 120, rows: 30 }
  it('accepts the three launch kinds with a compose project or null (home)', () => {
    expect(parseCreateRequest(ok)).toEqual(ok)
    expect(parseCreateRequest({ ...ok, kind: 'claude' })?.kind).toBe('claude')
    expect(parseCreateRequest({ ...ok, kind: 'codex' })?.kind).toBe('codex')
    expect(parseCreateRequest({ ...ok, project: null })?.project).toBeNull()
    expect(parseCreateRequest({ kind: 'shell', cols: 80, rows: 24 })?.project).toBeNull()
  })
  it('rejects unknown kinds (no arbitrary executables)', () => {
    for (const kind of ['bash', '/bin/sh', 'python', 'SHELL', '', null, 1, ['shell']]) {
      expect(parseCreateRequest({ ...ok, kind })).toBeNull()
    }
  })
  it('rejects paths and anything that is not an orcha compose project name', () => {
    for (const project of ['/etc', '/Users/me/project', '../orcha-x', '~', 'orcha-', 'todo-app', 'orcha-a/../../etc', 'orcha-a b', 'orcha-a\0', 42, {}]) {
      expect(parseCreateRequest({ ...ok, project })).toBeNull()
    }
  })
  it('rejects extra keys — a renderer cannot smuggle cwd/file/args/env', () => {
    for (const extra of [{ cwd: '/' }, { file: '/bin/sh' }, { args: ['-c', 'rm -rf ~'] }, { env: { PATH: '/tmp' } }, { shell: '/bin/sh' }]) {
      expect(parseCreateRequest({ ...ok, ...extra })).toBeNull()
    }
  })
  it('rejects bad sizes and non-objects', () => {
    expect(parseCreateRequest({ ...ok, cols: 0 })).toBeNull()
    expect(parseCreateRequest({ ...ok, cols: 1.5 })).toBeNull()
    expect(parseCreateRequest({ ...ok, rows: 100000 })).toBeNull()
    expect(parseCreateRequest({ ...ok, rows: '24' })).toBeNull()
    expect(parseCreateRequest(null)).toBeNull()
    expect(parseCreateRequest('shell')).toBeNull()
    expect(parseCreateRequest([ok])).toBeNull()
  })
})

describe('parseWrite / parseResize / parseTermId', () => {
  it('accepts well-formed messages', () => {
    expect(parseWrite({ id: 3, data: 'ls\r' })).toEqual({ id: 3, data: 'ls\r' })
    expect(parseResize({ id: 3, cols: 80, rows: 24 })).toEqual({ id: 3, cols: 80, rows: 24 })
    expect(parseTermId(7)).toBe(7)
  })
  it('rejects bad ids, empty/oversize data, extra keys', () => {
    expect(parseWrite({ id: 0, data: 'x' })).toBeNull()
    expect(parseWrite({ id: -1, data: 'x' })).toBeNull()
    expect(parseWrite({ id: '3', data: 'x' })).toBeNull()
    expect(parseWrite({ id: 3, data: '' })).toBeNull()
    expect(parseWrite({ id: 3, data: 'x'.repeat(TERM_WRITE_MAX + 1) })).toBeNull()
    expect(parseWrite({ id: 3, data: 'x', extra: 1 })).toBeNull()
    expect(parseResize({ id: 3, cols: 0, rows: 24 })).toBeNull()
    expect(parseResize({ id: 3, cols: 80 })).toBeNull()
    expect(parseTermId(1.5)).toBeNull()
    expect(parseTermId(null)).toBeNull()
  })
  it('isTermKind', () => {
    expect(isTermKind('codex')).toBe(true)
    expect(isTermKind('zsh')).toBe(false)
  })
})

describe('chunkWrite', () => {
  it('splits a big paste into write-sized chunks without losing data', () => {
    const data = 'a'.repeat(10) + 'b'.repeat(10)
    expect(chunkWrite(data, 8)).toEqual(['aaaaaaaa', 'aabbbbbb', 'bbbb'])
    expect(chunkWrite('hi')).toEqual(['hi'])
    expect(chunkWrite('')).toEqual([])
  })
})

describe('branch in create requests', () => {
  const ok = { kind: 'shell', project: 'orcha-todo-app', cols: 120, rows: 30 }
  it('accepts a plain branch name for a project', () => {
    expect(parseCreateRequest({ ...ok, branch: 'feat/orcha-v2-redesign' })).toEqual({ ...ok, branch: 'feat/orcha-v2-redesign' })
    expect(parseCreateRequest({ ...ok, branch: null })).toEqual(ok)
  })
  it('rejects paths, option-like and traversal names, and a branch without a project', () => {
    for (const branch of ['/etc', '../x', 'a/../b', '-x', '--upload-pack=sh', 'a//b', 'a/', '.hidden', 'a/.b', 'x.lock', 'a b', 'a\0', '', 'x'.repeat(201), 3]) {
      expect(parseCreateRequest({ ...ok, branch })).toBeNull()
    }
    expect(parseCreateRequest({ ...ok, project: null, branch: 'main' })).toBeNull()
    expect(isBranchName('orcha/task-lead-1')).toBe(true)
  })
})

describe('parseMetaEvent', () => {
  const ok = { type: 'meta', id: 3, title: 'Fix login', snippet: 'hi', attention: true, busy: false, lastActivity: 1, status: 'attention', statusAt: null }
  it('accepts a well-formed meta event', () => {
    expect(parseMetaEvent(ok)).toEqual(ok)
    expect(parseMetaEvent({ ...ok, title: null, snippet: null })).toMatchObject({ title: null, snippet: null })
  })
  it('carries the hook status (done + when) and derives one for an older main without it', () => {
    expect(parseMetaEvent({ ...ok, attention: false, status: 'done', statusAt: 42 })).toMatchObject({ status: 'done', statusAt: 42 })
    const { status: _s, statusAt: _a, ...legacy } = ok
    expect(parseMetaEvent(legacy)).toMatchObject({ status: 'attention', statusAt: null })
    expect(parseMetaEvent({ ...legacy, attention: false, busy: true })).toMatchObject({ status: 'working' })
    expect(parseMetaEvent({ ...ok, status: 'bogus', attention: false })).toMatchObject({ status: 'idle' })
    expect(parseMetaEvent({ ...ok, statusAt: 'soon' })).toMatchObject({ statusAt: null })
  })
  it('drops malformed ones', () => {
    for (const bad of [
      { ...ok, id: 0 },
      { ...ok, type: 'data' },
      { ...ok, attention: 'yes' },
      { ...ok, title: 'x'.repeat(TERM_META_TEXT_MAX + 1) },
      { ...ok, lastActivity: NaN },
      null
    ]) {
      expect(parseMetaEvent(bad)).toBeNull()
    }
  })
})

describe('session restore payloads', () => {
  it('parseLayout: pty ids + cosmetics, strict', () => {
    const t = { id: 3, title: ' api ', pinned: true, color: 'pink', rowKey: 'orcha-todo:c1', launchBranch: 'feat/x' }
    expect(parseLayout({ tabs: [t], active: 3 })).toEqual({ tabs: [{ ...t, title: 'api' }], active: 3 })
    expect(parseLayout({ tabs: [{ ...t, cwd: '/etc' }], active: null })).toBeNull() // no paths from the renderer
    expect(parseLayout({ tabs: [{ ...t, kind: 'claude' }], active: null })).toBeNull()
    expect(parseLayout({ tabs: [t, t], active: null })).toBeNull() // duplicate id
    expect(parseLayout({ tabs: [{ ...t, color: 'magenta' }], active: null })).toBeNull()
    expect(parseLayout({ tabs: [{ ...t, rowKey: '../x' }], active: null })).toBeNull()
    expect(parseLayout({ tabs: [{ ...t, launchBranch: '-x' }], active: null })).toBeNull()
    expect(parseLayout({ tabs: Array.from({ length: 65 }, (_, i) => ({ ...t, id: i + 1 })), active: null })).toBeNull()
  })
  it('parseRestoreRequest', () => {
    expect(parseRestoreRequest(undefined)).toEqual({})
    expect(parseRestoreRequest({ manual: true })).toEqual({ manual: true })
    expect(parseRestoreRequest({ project: 'orcha-todo' })).toEqual({ project: 'orcha-todo' })
    expect(parseRestoreRequest({ project: '/etc' })).toBeNull()
    expect(parseRestoreRequest({ manual: true, project: 'orcha-todo' })).toBeNull()
    expect(parseRestoreRequest({ cwd: '/' })).toBeNull()
  })
})
