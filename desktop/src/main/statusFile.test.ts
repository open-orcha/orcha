import { describe, it, expect, vi } from 'vitest'
import { buildStatus, writeStatusFile, STATUS_DIR, STATUS_FILE } from './statusFile'
import type { StackAttention } from './attention'
import type { AttentionItem, Stack } from '../shared/types'

const stack: Stack = {
  project: 'orcha-quantal-ehr',
  projectShort: 'quantal-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true
}
const item: AttentionItem = {
  project: 'orcha-quantal-ehr',
  projectShort: 'quantal-ehr',
  kind: 'request_answer',
  id: 'r1',
  title: 'Need a decision',
  path: '/requests?req=r1'
}
const stackDetail: StackAttention = {
  items: [item, { ...item, id: 'r2', title: 'Second ask' }],
  agents: [
    { alias: 'Plum', kind: 'ai', status: 'working', model: 'sonnet-4-6', task: 'Wire the widget bridge' },
    { alias: 'Atlas', kind: 'ai', status: 'idle', model: 'opus-4-8', task: null }
  ],
  tasks: { ready: 1, inProgress: 2, needsVerification: 0 }
}

describe('buildStatus', () => {
  it('emits schema v3: per-stack roster (with model + task) + pipeline counts, attention titles', () => {
    const status = buildStatus(
      [stack, { ...stack, project: 'orcha-idle', projectShort: 'idle', running: false, apiPort: null }],
      [item, { ...item, id: 'r2', title: 'Second ask' }],
      new Map([['orcha-quantal-ehr', stackDetail]]), // stopped stack absent (poller skips it)
      new Date('2026-06-11T22:00:00Z')
    )
    expect(status).toEqual({
      v: 3,
      updatedAt: '2026-06-11T22:00:00.000Z',
      totalAttention: 2,
      stacks: [
        {
          projectShort: 'quantal-ehr',
          running: true,
          attention: 2,
          working: 1,
          agents: [
            { alias: 'Plum', kind: 'ai', status: 'working', model: 'sonnet-4-6', task: 'Wire the widget bridge' },
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
        { projectShort: 'quantal-ehr', kind: 'request_answer', title: 'Need a decision' },
        { projectShort: 'quantal-ehr', kind: 'request_answer', title: 'Second ask' }
      ]
    })
  })

  it('caps the top-level attention list at 8 items (totalAttention stays uncapped)', () => {
    const items = Array.from({ length: 10 }, (_, n) => ({ ...item, id: `r${n}`, title: `ask ${n}` }))
    const status = buildStatus([stack], items, new Map(), new Date('2026-06-11T22:00:00Z'))
    expect(status.totalAttention).toBe(10)
    expect(status.attention).toHaveLength(8)
    expect(status.attention[0]).toEqual({ projectShort: 'quantal-ehr', kind: 'request_answer', title: 'ask 0' })
    expect(status.attention[7].title).toBe('ask 7')
  })
})

describe('writeStatusFile', () => {
  it('mkdirs the group container and writes atomically (tmp then rename)', async () => {
    const fs = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined)
    }
    const status = buildStatus([stack], [item], new Map([['orcha-quantal-ehr', stackDetail]]), new Date('2026-06-11T22:00:00Z'))
    await writeStatusFile(status, fs)
    expect(fs.mkdir).toHaveBeenCalledWith(STATUS_DIR, { recursive: true })
    const [tmpPath, body] = fs.writeFile.mock.calls[0]
    expect(String(tmpPath)).toBe(`${STATUS_FILE}.tmp`)
    expect(JSON.parse(body as string)).toEqual(status)
    expect(fs.rename).toHaveBeenCalledWith(`${STATUS_FILE}.tmp`, STATUS_FILE)
  })

  it('swallows write failures (widget data is best-effort)', async () => {
    const fs = {
      mkdir: vi.fn().mockRejectedValue(new Error('disk full')),
      writeFile: vi.fn(),
      rename: vi.fn()
    }
    await expect(writeStatusFile(buildStatus([], [], new Map(), new Date()), fs)).resolves.toBeUndefined()
  })
})
