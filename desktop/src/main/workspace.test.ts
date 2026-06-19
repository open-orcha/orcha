import { describe, it, expect, vi } from 'vitest'
import { createWorkspace, readableInitError, sanitizeName } from './workspace'
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

describe('readableInitError', () => {
  it("surfaces docker's error over the Python traceback the CLI appends", () => {
    const stderr = [
      'Error response from daemon: error while creating mount source path',
      "'/Users/x/Documents/p/.orcha/migrations': mkdir /Users/x: operation not permitted",
      'Traceback (most recent call last):',
      '  File "/opt/homebrew/Cellar/orcha/0.2.0/.../__main__.py", line 292, in _compose',
      '    return subprocess.run(cmd, check=check, capture_output=capture, text=capture)',
      '           ~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
      "subprocess.CalledProcessError: Command '['docker', 'compose', ...]' returned non-zero exit status 125."
    ].join('\n')
    const out = readableInitError(stderr)
    expect(out).toContain('Error response from daemon')
    expect(out).toContain('operation not permitted')
    expect(out).not.toContain('Traceback')
    expect(out).not.toContain('subprocess.run')
    expect(out).not.toMatch(/[~^]{3,}/)
  })

  it('falls back to the raw tail when there is nothing but a traceback', () => {
    const stderr = 'Traceback (most recent call last):\n  File "x", line 1\nValueError: boom'
    expect(readableInitError(stderr)).toContain('ValueError: boom')
  })
})
