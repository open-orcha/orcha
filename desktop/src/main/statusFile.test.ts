import { describe, it, expect, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildStatus, outcomeFromExit, runStatusWriter, statusWriterPath, StatusFileWriter, type WriteOutcome } from './statusFile'
import type { StackAttention } from './attention'
import type { AttentionItem, Stack } from '../shared/types'

const stack: Stack = {
  project: 'orcha-acme-ehr',
  projectShort: 'acme-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true,
  folder: null,
  runtime: 'docker',
  health: 'ok'
}
const item: AttentionItem = {
  project: 'orcha-acme-ehr',
  projectShort: 'acme-ehr',
  kind: 'request_answer',
  id: 'r1',
  title: 'Need a decision',
  path: '/requests?req=r1'
}
const stackDetail: StackAttention = {
  items: [item, { ...item, id: 'r2', title: 'Second ask' }],
  agents: [
    { alias: 'Plum', kind: 'ai', status: 'working', model: 'sonnet-5', task: 'Wire the widget bridge' },
    { alias: 'Atlas', kind: 'ai', status: 'idle', model: 'opus-4-8', task: null }
  ],
  tasks: { ready: 1, inProgress: 2, needsVerification: 0 }
}

describe('buildStatus', () => {
  it('counts decisions only — follow-ups are listed after them but never counted', () => {
    const followUp: AttentionItem = { ...item, id: 'f1', kind: 'request_close', title: 'Close my ask' }
    const plan: AttentionItem = { ...item, id: 'p1', kind: 'task_plan', title: 'Approve plan' }
    const status = buildStatus([stack], [followUp, plan], new Map(), new Date('2026-06-11T22:00:00Z'))
    expect(status.totalAttention).toBe(1)
    expect(status.stacks[0].attention).toBe(1)
    expect(status.attention.map((a) => a.kind)).toEqual(['task_plan', 'request_close'])
  })

  it('emits schema v3: per-stack roster (with model + task) + pipeline counts, attention titles', () => {
    const status = buildStatus(
      [stack, { ...stack, project: 'orcha-idle', projectShort: 'idle', running: false, apiPort: null }],
      [item, { ...item, id: 'r2', title: 'Second ask' }],
      new Map([['orcha-acme-ehr', stackDetail]]), // stopped stack absent (poller skips it)
      new Date('2026-06-11T22:00:00Z')
    )
    expect(status).toEqual({
      v: 3,
      updatedAt: '2026-06-11T22:00:00.000Z',
      totalAttention: 2,
      stacks: [
        {
          projectShort: 'acme-ehr',
          running: true,
          attention: 2,
          working: 1,
          agents: [
            { alias: 'Plum', kind: 'ai', status: 'working', model: 'sonnet-5', task: 'Wire the widget bridge' },
            { alias: 'Atlas', kind: 'ai', status: 'idle', model: 'opus-4-8', task: null }
          ],
          tasks: { ready: 1, inProgress: 2, needsVerification: 0 }
        },
        {
          projectShort: 'idle',
          running: false,
          attention: 0,
          working: 0,
          agents: [],
          tasks: { ready: 0, inProgress: 0, needsVerification: 0 }
        }
      ],
      attention: [
        { projectShort: 'acme-ehr', kind: 'request_answer', title: 'Need a decision' },
        { projectShort: 'acme-ehr', kind: 'request_answer', title: 'Second ask' }
      ]
    })
  })

  it('caps the top-level attention list at 8 items (totalAttention stays uncapped)', () => {
    const items = Array.from({ length: 10 }, (_, n) => ({ ...item, id: `r${n}`, title: `ask ${n}` }))
    const status = buildStatus([stack], items, new Map(), new Date('2026-06-11T22:00:00Z'))
    expect(status.totalAttention).toBe(10)
    expect(status.attention).toHaveLength(8)
    expect(status.attention[0]).toEqual({ projectShort: 'acme-ehr', kind: 'request_answer', title: 'ask 0' })
    expect(status.attention[7].title).toBe('ask 7')
  })
})

const EXEC = '/Applications/Embodent.app/Contents/MacOS/Embodent'
const HELPER = '/Applications/Embodent.app/Contents/MacOS/orcha-status-writer'
const STATUS_WRITER_REL = path.join('Contents', 'MacOS', 'orcha-status-writer')

describe('status writer helper (GH #397)', () => {
  it('is looked up next to the packaged macOS executable only', () => {
    expect(statusWriterPath('darwin', EXEC)).toBe(HELPER)
    expect(statusWriterPath('darwin', '/usr/local/bin/electron')).toBeNull() // dev: not in a bundle
    expect(statusWriterPath('linux', EXEC)).toBeNull()
  })

  it('maps helper exit codes to outcomes', () => {
    expect(outcomeFromExit(0)).toBe('ok')
    expect(outcomeFromExit(3)).toBe('unavailable') // no group this signing team owns
    expect(outcomeFromExit('ENOENT')).toBe('unavailable') // helper missing
    expect(outcomeFromExit(4)).toBe('denied')
    for (const c of [1, 2, null, 'ETIMEDOUT']) expect(outcomeFromExit(c)).toBe('failed')
  })

  it('pipes the JSON to a real helper process on stdin and reads its exit code', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'status-writer-'))
    const helper = path.join(dir, 'fake-writer')
    const out = path.join(dir, 'stdin.json')
    const fake = (code: number) => {
      writeFileSync(helper, `#!/bin/sh\ncat > '${out}'\nexit ${code}\n`)
      chmodSync(helper, 0o755)
    }
    fake(0)
    await expect(runStatusWriter(helper, '{"v":3}')).resolves.toBe('ok')
    expect(readFileSync(out, 'utf8')).toBe('{"v":3}')
    fake(4)
    await expect(runStatusWriter(helper, '{}')).resolves.toBe('denied')
    fake(3)
    await expect(runStatusWriter(helper, '{}')).resolves.toBe('unavailable')
    await expect(runStatusWriter(path.join(dir, 'missing'), '{}')).resolves.toBe('unavailable')
  })
})

describe('StatusFileWriter', () => {
  const status = () => buildStatus([], [], new Map(), new Date())

  it('never runs anything without a packaged helper (dev builds, non-macOS)', async () => {
    const run = vi.fn()
    const writer = new StatusFileWriter(null, run, vi.fn())
    await writer.write(status())
    expect(run).not.toHaveBeenCalled()
  })

  it('hands every poll to the helper while it succeeds', async () => {
    const run = vi.fn().mockResolvedValue('ok')
    const writer = new StatusFileWriter(HELPER, run, vi.fn())
    for (let i = 0; i < 3; i++) await writer.write(status())
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[0][0]).toBe(HELPER)
    expect(JSON.parse(run.mock.calls[0][1])).toEqual(JSON.parse(JSON.stringify(status())))
  })

  it.each<WriteOutcome>(['unavailable', 'denied'])('stops for the session after %s, but keeps going after transient errors', async (final) => {
    const warn = vi.fn()
    const run = vi.fn<() => Promise<WriteOutcome>>().mockResolvedValueOnce('failed').mockRejectedValueOnce(new Error('spawn')).mockResolvedValueOnce(final)
    const writer = new StatusFileWriter(HELPER, run, warn)
    for (let i = 0; i < 6; i++) await writer.write(status())
    expect(run).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('mac sign hook (GH #397)', () => {
  const require = createRequire(import.meta.url)
  const hook = require('../../scripts/macSign.cjs') as {
    (opts: object): Promise<void>
    withStatusWriterEntitlements: (f: (p: string) => object) => (p: string) => { entitlements?: string }
    presignStatusWriter: (opts: object, run?: (cmd: string, args: string[]) => void) => boolean
    MAIN_ENTITLEMENTS: string
  }
  const app = '/build/mac-universal/Embodent.app'
  const base = (p: string) => ({ entitlements: p === app ? 'main.plist' : 'inherit.plist', hardenedRuntime: true })
  const route = hook.withStatusWriterEntitlements(base)

  it('signs only the status writer with the main (group) entitlements', () => {
    expect(route(`${app}/Contents/MacOS/orcha-status-writer`)).toEqual({ entitlements: hook.MAIN_ENTITLEMENTS, hardenedRuntime: true })
    expect(hook.MAIN_ENTITLEMENTS.endsWith(path.join('resources', 'entitlements.mac.plist'))).toBe(true)
    expect(route(app).entitlements).toBe('main.plist')
    for (const nested of [
      `${app}/Contents/Frameworks/Embodent Helper (Renderer).app`,
      `${app}/Contents/Resources/orcha-runtime/python/bin/python3.12`,
      `${app}/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`
    ])
      expect(route(nested).entitlements).toBe('inherit.plist')
  })

  it('keeps the group out of the inherit set', () => {
    const inherit = readFileSync(path.join(__dirname, '..', '..', 'resources', 'entitlements.mac.inherit.plist'), 'utf8')
    expect(inherit).not.toContain('application-groups')
    expect(readFileSync(hook.MAIN_ENTITLEMENTS, 'utf8')).toContain('<string>FX6LQ4M698.orcha</string>')
  })

  it('gives the helper a preliminary signature with the build identity before the real pass', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'presign-'))
    const helper = path.join(dir, 'Contents', 'MacOS', 'orcha-status-writer')
    const run = vi.fn()
    expect(hook.presignStatusWriter({ app: dir, identity: 'ABC123' }, run)).toBe(false) // no helper packed
    mkdirSync(path.dirname(helper), { recursive: true })
    writeFileSync(helper, '')
    expect(hook.presignStatusWriter({ app: dir }, run)).toBe(false) // unsigned build
    expect(run).not.toHaveBeenCalled()
    expect(hook.presignStatusWriter({ app: dir, identity: 'ABC123', keychain: '/tmp/k.keychain' }, run)).toBe(true)
    expect(run).toHaveBeenCalledWith('/usr/bin/codesign', ['--force', '--sign', 'ABC123', '--timestamp=none', '--keychain', '/tmp/k.keychain', helper], { stdio: 'pipe' })
  })

  // The real thing: two thin apps built from the compiled helpers, merged by @electron/universal
  // exactly like `dist:mac`, then signed (ad-hoc) through this hook and electron-builder's per-file
  // options. Without the presign, codesign fails on the main executable ("code object is not
  // signed at all", subcomponent orcha-status-writer).
  it.runIf(process.platform === 'darwin')('signs a combined Intel + Apple Silicon app with the helper inside', { timeout: 180_000 }, async () => {
    const desktop = path.join(__dirname, '..', '..')
    const built = (arch: string) => path.join(desktop, 'resources', 'status-writer', arch, 'orcha-status-writer')
    if (!existsSync(built('arm64')) || !existsSync(built('x64')))
      execFileSync(process.execPath, [path.join(desktop, 'scripts', 'build-status-writer.mjs')], { stdio: 'pipe' })
    const { makeUniversalApp } = require('@electron/universal')
    const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper')
    const root = mkdtempSync(path.join(os.tmpdir(), 'universal-sign-'))
    const nestedRuntime = path.join('Contents', 'Resources', 'orcha-runtime', 'python', 'bin', 'python3.12')
    for (const arch of ['arm64', 'x64']) {
      const contents = path.join(root, `${arch}.app`, 'Contents')
      for (const f of ['MacOS/Probe', 'MacOS/orcha-status-writer', 'Resources/orcha-runtime/python/bin/python3.12']) {
        mkdirSync(path.dirname(path.join(contents, f)), { recursive: true })
        copyFileSync(built(arch), path.join(contents, f))
      }
      mkdirSync(path.join(contents, 'Resources', 'app'), { recursive: true })
      writeFileSync(path.join(contents, 'Resources', 'app', 'package.json'), '{"name":"probe","version":"1.0.0"}')
      writeFileSync(
        path.join(contents, 'Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Probe</string>' +
          '<key>CFBundleIdentifier</key><string>io.openorcha.sign-probe</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>'
      )
    }
    const app = path.join(root, 'universal.app')
    await makeUniversalApp({ x64AppPath: path.join(root, 'x64.app'), arm64AppPath: path.join(root, 'arm64.app'), outAppPath: app, force: true })
    const helper = path.join(app, STATUS_WRITER_REL)
    expect(execFileSync('/usr/bin/lipo', ['-archs', helper], { encoding: 'utf8' }).trim().split(' ').sort()).toEqual(['arm64', 'x86_64'])

    const config = {
      entitlements: hook.MAIN_ENTITLEMENTS,
      entitlementsInherit: path.join(desktop, 'resources', 'entitlements.mac.inherit.plist'),
      hardenedRuntime: true
    }
    const optionsForFile = await MacTargetHelper.prototype.getOptionsForFile.call(
      { packager: { resourceList: [], platformSpecificBuildOptions: {} } },
      app,
      false,
      config
    )
    await hook({ app, platform: 'darwin', identity: '-', identityValidation: false, preAutoEntitlements: false, preEmbedProvisioningProfile: false, gatekeeperAssess: false, optionsForFile })

    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
    const claimsGroup = (f: string) => execFileSync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).includes('application-groups')
    expect(claimsGroup(app)).toBe(true)
    expect(claimsGroup(helper)).toBe(true)
    expect(claimsGroup(path.join(app, nestedRuntime))).toBe(false)
    // Ad-hoc signed, so no team owns the group: both slices must refuse to write (exit 3).
    for (const arch of ['arm64', 'x86_64']) expect(spawnSync('/usr/bin/arch', [`-${arch}`, helper], { input: '{"v":3}' }).status).toBe(3)
  })
})

