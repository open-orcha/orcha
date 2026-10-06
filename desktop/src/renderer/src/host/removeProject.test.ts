import { describe, it, expect } from 'vitest'
import {
  EXPANDED_KEY,
  FAVORITES_KEY,
  ORDER_KEY,
  fallbackAfterRemoval,
  forgetLocalPrefs,
  formatBytes,
  isProjectKey,
  projectKeys,
  projectTerminals,
  removedToast
} from './removeProject'
import type { ProjectRow } from './projectModel'
import type { TermTab } from '../terminal/termTabs'
import type { Stack } from '../../../shared/types'

const stack = (project: string, running = true): Stack => ({
  project,
  projectShort: project.replace(/^orcha-/, ''),
  apiPort: running ? 8001 : null,
  dbPort: null,
  portalStatus: running ? 'Up' : 'Exited',
  running,
  folder: null
})
const row = (project: string, cid: string | null, running = true): ProjectRow =>
  ({ key: cid ? `${project}:${cid}` : project, stack: stack(project, running), container: cid ? { id: cid } : null, name: cid ?? project }) as unknown as ProjectRow
const tab = (key: string, project: string | null, status: TermTab['status']): TermTab => ({ key, project, status }) as TermTab

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

describe('row keys', () => {
  it('matches a project’s own keys only — never a project that merely shares the prefix', () => {
    expect(isProjectKey('orcha-acme', 'orcha-acme')).toBe(true)
    expect(isProjectKey('orcha-acme:c1', 'orcha-acme')).toBe(true)
    expect(isProjectKey('orcha-acme-web:c2', 'orcha-acme')).toBe(false)
    expect(isProjectKey('orcha-acme-web', 'orcha-acme')).toBe(false)
  })

  it('collects keys and container ids of the project', () => {
    const rows = [row('orcha-acme', 'c1'), row('orcha-acme', 'c2'), row('orcha-acme-web', 'c3')]
    expect(projectKeys(rows, 'orcha-acme')).toEqual({ keys: ['orcha-acme:c1', 'orcha-acme:c2'], cids: ['c1', 'c2'] })
  })
})

describe('projectTerminals', () => {
  it('the project’s tabs, and how many are still running', () => {
    const tabs = [tab('a', 'orcha-acme', 'running'), tab('b', 'orcha-acme', 'exited'), tab('c', 'orcha-acme', 'starting'), tab('d', 'orcha-acme-web', 'running'), tab('e', null, 'running')]
    expect(projectTerminals(tabs, 'orcha-acme')).toEqual({ keys: ['a', 'b', 'c'], live: 2 })
  })
})

describe('fallbackAfterRemoval (the open project was removed)', () => {
  it('lands on the first other project that can open', () => {
    const rows = [row('orcha-acme', 'c1'), row('orcha-stopped', 'c2', false), row('orcha-web', 'c3')]
    expect(fallbackAfterRemoval(rows, 'orcha-acme')?.key).toBe('orcha-web:c3')
  })

  it('no other openable project → null (the home screen)', () => {
    expect(fallbackAfterRemoval([row('orcha-acme', 'c1'), row('orcha-stopped', 'c2', false)], 'orcha-acme')).toBeNull()
    expect(fallbackAfterRemoval([], 'orcha-acme')).toBeNull()
  })
})

describe('forgetLocalPrefs (this Mac’s sidebar state)', () => {
  it('drops favourites, order and expand state of the project only', () => {
    const s = memStore({
      [FAVORITES_KEY]: JSON.stringify(['c1', 'c3']),
      [ORDER_KEY]: JSON.stringify(['orcha-acme-web:c3', 'orcha-acme:c1', 'orcha-acme']),
      [EXPANDED_KEY]: JSON.stringify({ 'orcha-acme:c1': true, 'orcha-acme-web:c3': false })
    })
    const r = forgetLocalPrefs(s, 'orcha-acme', ['c1'])
    expect([...r.favorites]).toEqual(['c3'])
    expect(r.order).toEqual(['orcha-acme-web:c3'])
    expect(r.expanded).toEqual({ 'orcha-acme-web:c3': false })
    expect(JSON.parse(s.m.get(FAVORITES_KEY) as string)).toEqual(['c3'])
    expect(JSON.parse(s.m.get(ORDER_KEY) as string)).toEqual(['orcha-acme-web:c3'])
  })

  it('survives empty / corrupt storage', () => {
    const s = memStore({ [ORDER_KEY]: '{not json' })
    expect(forgetLocalPrefs(s, 'orcha-acme', [])).toEqual({ favorites: new Set(), order: [], expanded: {} })
  })
})

describe('labels', () => {
  it('formats sizes like Docker', () => {
    expect(formatBytes(347_000_000)).toBe('347 MB')
    expect(formatBytes(66_810_000)).toBe('66.8 MB')
    expect(formatBytes(1_200_000_000)).toBe('1.2 GB')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(null)).toBeNull()
  })

  it('says what was done', () => {
    expect(removedToast('acme', { dataDeleted: false, filesRemoved: false })).toBe(
      'Removed acme. Its data is kept — add the folder again to bring it back.'
    )
    expect(removedToast('acme', { dataDeleted: true, filesRemoved: true })).toBe(
      'Removed acme and deleted its data. Embodent’s files were removed from the folder.'
    )
  })
})
