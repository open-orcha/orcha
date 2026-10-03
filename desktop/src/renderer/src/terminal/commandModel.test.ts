import { describe, it, expect } from 'vitest'
import {
  filterCommands,
  flatSelectable,
  matchHostShortcut,
  moveSelection,
  scoreItem,
  terminalShouldSkip,
  type CommandItem
} from './commandModel'

const items: CommandItem[] = [
  { id: 'new-shell', section: 'actions', label: 'New Terminal', keywords: 'shell zsh' },
  { id: 'new-claude', section: 'actions', label: 'Claude', keywords: 'agent anthropic' },
  { id: 'new-codex', section: 'actions', label: 'Codex', keywords: 'agent openai' },
  { id: 'agent-settings', section: 'actions', label: 'Agent settings…', keywords: 'preferences' },
  { id: 'tab-1', section: 'tabs', label: 'zsh · todo-app', hint: 'exited 1' },
  { id: 'project-a', section: 'projects', label: 'todo-app' },
  { id: 'project-b', section: 'projects', label: 'billing', hint: 'stopped', disabled: true }
]

const ids = (q: string) => filterCommands(items, q).flatMap((g) => g.items.map((i) => i.id))

describe('filterCommands', () => {
  it('empty query: everything, sections in order (Actions, Open tabs, Projects)', () => {
    const groups = filterCommands(items, '')
    expect(groups.map((g) => g.section)).toEqual(['actions', 'tabs', 'projects'])
    expect(ids('')).toEqual(items.map((i) => i.id))
  })
  it('matches labels, hints and keywords, case/accent-insensitive', () => {
    expect(ids('claude')).toEqual(['new-claude'])
    expect(ids('CODEX')).toEqual(['new-codex'])
    expect(ids('openai')).toEqual(['new-codex'])
    expect(ids('exited')).toEqual(['tab-1'])
  })
  it('ranks a label prefix above a word start above keyword hits', () => {
    // "agent" is the label prefix of Agent settings, only a keyword of Claude/Codex
    expect(ids('agent')).toEqual(['agent-settings', 'new-claude', 'new-codex'])
    expect(scoreItem(items[0], 'term')).toBeGreaterThan(scoreItem(items[0], 'zsh'))
  })
  it('every word must match (AND), across sections', () => {
    expect(ids('todo')).toEqual(['tab-1', 'project-a'])
    expect(ids('zsh todo')).toEqual(['tab-1'])
    expect(ids('zsh billing')).toEqual([])
  })
  it('treats regex metacharacters literally', () => {
    expect(() => ids('(')).not.toThrow()
    expect(ids('settings…')).toEqual(['agent-settings'])
  })
  it('flatSelectable skips disabled items (a stopped project)', () => {
    expect(flatSelectable(filterCommands(items, 'billing'))).toEqual([])
  })
})

describe('moveSelection', () => {
  const list = ['a', 'b', 'c']
  it('arrows wrap; Home/End jump', () => {
    expect(moveSelection(list, 'a', 'ArrowDown')).toBe('b')
    expect(moveSelection(list, 'c', 'ArrowDown')).toBe('a')
    expect(moveSelection(list, 'a', 'ArrowUp')).toBe('c')
    expect(moveSelection(list, null, 'ArrowDown')).toBe('a')
    expect(moveSelection(list, 'b', 'Home')).toBe('a')
    expect(moveSelection(list, 'b', 'End')).toBe('c')
    expect(moveSelection([], 'a', 'ArrowDown')).toBeNull()
  })
})

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

describe('shortcuts', () => {
  it('⌘K opens the menu; ⌘1..9 switch tabs', () => {
    expect(matchHostShortcut(key('k', { metaKey: true }))).toEqual({ type: 'command-menu' })
    expect(matchHostShortcut(key('K', { metaKey: true }))).toEqual({ type: 'command-menu' })
    expect(matchHostShortcut(key('1', { metaKey: true }))).toEqual({ type: 'tab-index', index: 0 })
    expect(matchHostShortcut(key('9', { metaKey: true }))).toEqual({ type: 'tab-index', index: 8 })
  })
  it('claims nothing else: plain keys, ⌘0, ⇧⌘K, ⌥⌘K, Ctrl+K (terminal kill-line) all pass through', () => {
    expect(matchHostShortcut(key('k'))).toBeNull()
    expect(matchHostShortcut(key('0', { metaKey: true }))).toBeNull()
    expect(matchHostShortcut(key('k', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(matchHostShortcut(key('k', { metaKey: true, altKey: true }))).toBeNull()
    expect(matchHostShortcut(key('k', { ctrlKey: true }))).toBeNull()
    expect(matchHostShortcut(key('c', { metaKey: true }))).toBeNull()
  })
  it('uses Ctrl off macOS', () => {
    expect(matchHostShortcut(key('k', { ctrlKey: true }), false)).toEqual({ type: 'command-menu' })
    expect(matchHostShortcut(key('k', { metaKey: true }), false)).toBeNull()
  })
  it('xterm skips only host/menu shortcuts; Ctrl-keys, ⌘C/⌘V and typing reach the shell', () => {
    expect(terminalShouldSkip(key('k', { metaKey: true }))).toBe(true)
    expect(terminalShouldSkip(key('t', { metaKey: true }))).toBe(true)
    expect(terminalShouldSkip(key('t', { metaKey: true, altKey: true }))).toBe(true)
    expect(terminalShouldSkip(key('w', { metaKey: true }))).toBe(true)
    expect(terminalShouldSkip(key('3', { metaKey: true }))).toBe(true)
    expect(terminalShouldSkip(key('c', { ctrlKey: true }))).toBe(false)
    expect(terminalShouldSkip(key('k', { ctrlKey: true }))).toBe(false)
    expect(terminalShouldSkip(key('c', { metaKey: true }))).toBe(false)
    expect(terminalShouldSkip(key('a'))).toBe(false)
  })
})
