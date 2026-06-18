import { describe, it, expect, vi } from 'vitest'
import { createWorkspace, sanitizeName } from './workspace'
import type { Exec } from './dockerExec'

describe('sanitizeName', () => {
  it('mirrors the CLI: lowercases and replaces non [a-z0-9_-] runs with dashes', () => {
    expect(sanitizeName('Todo App')).toBe('todo-app')
    expect(sanitizeName('My_Project')).toBe('my_project')
    expect(sanitizeName('café!')).toBe('caf') // non-alnum each become '-', then stripped
  })
  it('strips leading/trailing dashes and falls back to "orcha"', () => {
    expect(sanitizeName('--weird--')).toBe('weird')
    expect(sanitizeName('!!!')).toBe('orcha')
  })
})

describe('createWorkspace', () => {
  it('runs `orcha init` in the chosen dir and derives the compose project name', async () => {
    const exec = vi.fn<Exec>().mockResolvedValue({ stdout: 'ok' })
    const result = await createWorkspace('/Users/me/Code/Todo App', exec)
    expect(exec).toHaveBeenCalledWith('orcha', ['init'], { cwd: '/Users/me/Code/Todo App' })
    expect(result).toEqual({
      project: 'orcha-todo-app',
      projectShort: 'todo-app',
      dir: '/Users/me/Code/Todo App'
    })
  })

  it('wraps a failing `orcha init` as WORKSPACE_INIT_FAILED with the stderr tail', async () => {
    const exec = vi
      .fn<Exec>()
      .mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: 'error: .orcha/ already exists' }))
    await expect(createWorkspace('/tmp/proj', exec)).rejects.toEqual({
      code: 'WORKSPACE_INIT_FAILED',
      stderr: 'error: .orcha/ already exists'
    })
  })
})
