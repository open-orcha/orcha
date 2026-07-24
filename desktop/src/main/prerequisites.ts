/** Probes and installs host prerequisites while keeping API keys local to this Mac. */
import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hostToolPath } from './hostWorker'
import { adminOsascriptArgs } from './installers'
import type { PrereqProbe } from '../shared/types'

function apiKeyFile(): string {
  return path.join(app.getPath('userData'), 'anthropic-api-key')
}

/** Make a saved key available to workers spawned during this app session. */
export function loadApiKeyIntoEnv(): void {
  try {
    const file = apiKeyFile()
    if (!process.env.ANTHROPIC_API_KEY && existsSync(file)) {
      const key = readFileSync(file, 'utf8').trim()
      if (key) process.env.ANTHROPIC_API_KEY = key
    }
  } catch {
    // A missing or unreadable key file simply means no key is configured yet.
  }
}

function whichHostTool(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/which',
      [command],
      { env: { ...process.env, PATH: hostToolPath() } },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    )
  })
}

export async function probePrereqs(): Promise<PrereqProbe> {
  const [brew, docker, orcha, claude, codex] = await Promise.all([
    whichHostTool('brew'),
    whichHostTool('docker'),
    whichHostTool('orcha'),
    whichHostTool('claude'),
    whichHostTool('codex')
  ])
  return {
    homebrew: !!brew,
    dockerEngine: !!docker,
    orcha: !!orcha,
    claude: !!claude,
    codex: !!codex,
    apiKey: !!process.env.ANTHROPIC_API_KEY || existsSync(apiKeyFile())
  }
}

/** Run an unprivileged install and stream useful output without requiring a TTY. */
export function runUserInstall(
  script: string,
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', script], {
      env: {
        ...process.env,
        PATH: hostToolPath(),
        NONINTERACTIVE: '1',
        HOMEBREW_NO_AUTO_UPDATE: '1'
      }
    })
    let tail = ''
    const onData = (buffer: Buffer): void => {
      const text = buffer.toString()
      tail = (tail + text).slice(-2000)
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) onLine(trimmed)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(Object.assign(new Error(`exited ${code}`), { stderr: tail.trim() }))
    })
  })
}

/** Run a privileged install through the native macOS authorization dialog. */
export function runAdminInstall(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('osascript', adminOsascriptArgs(script), (error, _stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: stderr || error.message }))
      else resolve()
    })
  })
}

/** Prompt for an Anthropic API key using a native masked input field. */
export function promptApiKey(): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '-e',
      'try',
      '-e',
      'set k to text returned of (display dialog "Paste your Anthropic API key (starts with sk-ant-). It is stored only on this Mac." default answer "" with hidden answer with title "Orcha" buttons {"Cancel", "Save"} default button "Save")',
      '-e',
      'return k',
      '-e',
      'on error',
      '-e',
      'return "__CANCELLED__"',
      '-e',
      'end try'
    ]
    execFile('osascript', args, (error, stdout) => {
      if (error) return resolve(null)
      const value = stdout.trim()
      resolve(!value || value === '__CANCELLED__' ? null : value)
    })
  })
}

export async function persistApiKey(key: string): Promise<void> {
  const file = apiKeyFile()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, key, { mode: 0o600 })
  process.env.ANTHROPIC_API_KEY = key
}
