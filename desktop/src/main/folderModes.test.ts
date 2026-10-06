import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectRuntime, inspectFolder, isProject, sanitizeName } from './folderModes'
import { readFileSync } from 'node:fs'

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'orcha-fm-'))
}

describe('sanitizeName', () => {
  it('mirrors the CLI rule', () => {
    expect(sanitizeName('My App!')).toBe('my-app')
    expect(sanitizeName('  ')).toBe('orcha')
    expect(sanitizeName('keep_under-score')).toBe('keep_under-score')
  })
})

describe('inspectFolder', () => {
  it('reports an uninitialized writable folder with a sanitized suggested name', () => {
    const dir = path.join(tmp(), 'My Project')
    mkdirSync(dir, { recursive: true })
    try {
      const state = inspectFolder(dir)
      expect(state.initialized).toBe(false)
      expect(state.writable).toBe(true)
      expect(state.suggestedName).toBe('my-project')
      expect(state.isGitRepo).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects an initialized folder (.orcha/docker-compose.yml present)', () => {
    const dir = tmp()
    mkdirSync(path.join(dir, '.orcha'), { recursive: true })
    writeFileSync(path.join(dir, '.orcha', 'docker-compose.yml'), 'name: orcha-x\n')
    try {
      expect(inspectFolder(dir).initialized).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects a git repo (.git dir present)', () => {
    const dir = tmp()
    mkdirSync(path.join(dir, '.git'), { recursive: true })
    try {
      expect(inspectFolder(dir).isGitRepo).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import { createBlankFolder } from './folderModes'
import { existsSync } from 'node:fs'

describe('createBlankFolder', () => {
  it('creates a sanitized child dir', () => {
    const parent = tmp()
    try {
      const made = createBlankFolder(parent, 'New App')
      expect(made).toBe(path.join(parent, 'new-app'))
      expect(existsSync(made)).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rejects a non-empty existing target', () => {
    const parent = tmp()
    mkdirSync(path.join(parent, 'taken'))
    writeFileSync(path.join(parent, 'taken', 'f'), 'x')
    try {
      expect(() => createBlankFolder(parent, 'taken')).toThrow()
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

/** The same truth table the CLI's tests/test_cli_runtime_mode.py runs (GH #258 D2). */
describe('runtime rule — parity with the CLI (tests/fixtures/runtime_mode_cases.json)', () => {
  const file = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'runtime_mode_cases.json')
  const cases = (JSON.parse(readFileSync(file, 'utf8')) as {
    cases: { name: string; orcha_json: Record<string, unknown> | null; compose: boolean; runtime: string; is_project: boolean }[]
  }).cases
  it('has the shared cases', () => expect(cases.length).toBeGreaterThanOrEqual(10))
  for (const c of cases) {
    it(c.name, () => {
      const dir = tmp()
      try {
        if (c.orcha_json) {
          mkdirSync(path.join(dir, '.claude'), { recursive: true })
          writeFileSync(path.join(dir, '.claude', 'orcha.json'), JSON.stringify(c.orcha_json))
        }
        if (c.compose) {
          mkdirSync(path.join(dir, '.orcha'), { recursive: true })
          writeFileSync(path.join(dir, '.orcha', 'docker-compose.yml'), 'name: orcha-demo\n')
        }
        if (c.runtime === 'error') expect(() => detectRuntime(dir)).toThrow(/unknown runtime/)
        else expect(detectRuntime(dir)).toBe(c.runtime)
        expect(isProject(dir)).toBe(c.is_project)
        expect(inspectFolder(dir).initialized).toBe(c.is_project)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
