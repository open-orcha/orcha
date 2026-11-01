import { describe, it, expect, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  appGroupFromEntitlements,
  bundleFromExecPath,
  buildStatus,
  resolveStatusTarget,
  statusTarget,
  StatusFileWriter,
  writeStatusFile
} from './statusFile'
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

const ENTITLED = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.application-groups</key>
<array><string>FX6LQ4M698.other</string><string>FX6LQ4M698.orcha</string></array>
</dict></plist>`
// What the shipped 2.2.0 app reports: hardened-runtime keys only, no group.
const NOT_ENTITLED = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.device.audio-input</key><true/>
</dict></plist>`
const EXEC = '/Applications/Embodent.app/Contents/MacOS/Embodent'
const target = statusTarget('FX6LQ4M698.orcha')
const denied = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })
const okFs = () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined)
})

describe('app group resolution (GH #397)', () => {
  it('reads the <team>.orcha group from the signed entitlements', () => {
    expect(appGroupFromEntitlements(ENTITLED)).toBe('FX6LQ4M698.orcha')
    expect(appGroupFromEntitlements(NOT_ENTITLED)).toBeNull()
    expect(appGroupFromEntitlements('')).toBeNull()
  })

  it('puts the file in that group container', () => {
    expect(target.dir).toBe(path.join(os.homedir(), 'Library', 'Group Containers', 'FX6LQ4M698.orcha'))
    expect(target.file).toBe(path.join(target.dir, 'status.json'))
  })

  it('finds the .app bundle around the executable', () => {
    expect(bundleFromExecPath(EXEC)).toBe('/Applications/Embodent.app')
    expect(bundleFromExecPath('/usr/local/bin/node')).toBeNull()
  })

  it('resolves a target only for an entitled macOS app', async () => {
    const read = vi.fn().mockResolvedValue(ENTITLED)
    await expect(resolveStatusTarget({ platform: 'darwin', execPath: EXEC, readEntitlements: read })).resolves.toEqual(target)
    expect(read).toHaveBeenCalledWith('/Applications/Embodent.app')
    const none = (xml: string) => resolveStatusTarget({ platform: 'darwin', execPath: EXEC, readEntitlements: async () => xml })
    await expect(none(NOT_ENTITLED)).resolves.toBeNull()
    await expect(
      resolveStatusTarget({ platform: 'darwin', execPath: EXEC, readEntitlements: () => Promise.reject(new Error('codesign failed')) })
    ).resolves.toBeNull()
    await expect(resolveStatusTarget({ platform: 'linux', execPath: EXEC, readEntitlements: read })).resolves.toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('writeStatusFile', () => {
  it('mkdirs the group container and writes atomically (tmp then rename)', async () => {
    const fs = okFs()
    const status = buildStatus([stack], [item], new Map([['orcha-acme-ehr', stackDetail]]), new Date('2026-06-11T22:00:00Z'))
    await expect(writeStatusFile(status, target, fs)).resolves.toBe('ok')
    expect(fs.mkdir).toHaveBeenCalledWith(target.dir, { recursive: true })
    const [tmpPath, body] = fs.writeFile.mock.calls[0]
    expect(String(tmpPath)).toBe(`${target.file}.tmp`)
    expect(JSON.parse(body as string)).toEqual(status)
    expect(fs.rename).toHaveBeenCalledWith(`${target.file}.tmp`, target.file)
  })

  it('swallows write failures (widget data is best-effort)', async () => {
    const fs = { mkdir: vi.fn().mockRejectedValue(new Error('disk full')), writeFile: vi.fn(), rename: vi.fn() }
    await expect(writeStatusFile(buildStatus([], [], new Map(), new Date()), target, fs)).resolves.toBe('failed')
  })

  it('reports a macOS refusal as denied', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      const fs = { mkdir: vi.fn().mockRejectedValue(denied(code)), writeFile: vi.fn(), rename: vi.fn() }
      await expect(writeStatusFile(buildStatus([], [], new Map(), new Date()), target, fs)).resolves.toBe('denied')
    }
  })
})

describe('StatusFileWriter', () => {
  const status = () => buildStatus([], [], new Map(), new Date())

  it('never touches Group Containers when the app is not entitled', async () => {
    const fs = okFs()
    const resolve = vi.fn().mockResolvedValue(null)
    const writer = new StatusFileWriter(resolve, fs, vi.fn())
    for (let i = 0; i < 5; i++) await writer.write(status())
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(fs.mkdir).not.toHaveBeenCalled()
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('treats a failed lookup as not entitled', async () => {
    const fs = okFs()
    const writer = new StatusFileWriter(() => Promise.reject(new Error('boom')), fs, vi.fn())
    await writer.write(status())
    expect(fs.mkdir).not.toHaveBeenCalled()
  })

  it('writes every poll when entitled, resolving the target once', async () => {
    const fs = okFs()
    const resolve = vi.fn().mockResolvedValue(target)
    const writer = new StatusFileWriter(resolve, fs, vi.fn())
    for (let i = 0; i < 3; i++) await writer.write(status())
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(fs.rename).toHaveBeenCalledTimes(3)
  })

  it('stops for the session after the first denial, but keeps going after other errors', async () => {
    const warn = vi.fn()
    const fs = okFs()
    fs.mkdir.mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce(denied('EPERM'))
    const writer = new StatusFileWriter(async () => target, fs, warn)
    await writer.write(status()) // transient failure: retried next poll
    await writer.write(status()) // denied: stop
    for (let i = 0; i < 3; i++) await writer.write(status())
    expect(fs.mkdir).toHaveBeenCalledTimes(2)
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('denied')
  })
})
