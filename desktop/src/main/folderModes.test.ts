import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectFolder } from './folderModes'

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'orcha-fm-'))
}

describe('inspectFolder', () => {
  it('reports an uninitialized writable folder with a sanitized suggested name', () => {
    const dir = path.join(tmp(), 'My Project')
    mkdirSync(dir, { recursive: true })
    try {
      const state = inspectFolder(dir)
      expect(state.initialized).toBe(false)
      expect(state.writable).toBe(true)
      expect(state.suggestedName).toBe('my-project')
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
