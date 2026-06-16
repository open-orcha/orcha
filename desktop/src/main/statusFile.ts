import { promises as nodeFs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentSummary, StackAttention } from './attention'
import type { AttentionItem, Stack } from '../shared/types'

/** App Group shared with the native WidgetKit extension. The prefix must be
 *  the signing cert's REAL TeamIdentifier (the OU, N2597TV587 — the CN
 *  misleadingly displays the personal-team id); containermanagerd rejects
 *  groups not prefixed by the requestor's team. The widget declares the same
 *  id. The Electron app is unsandboxed so it can write here directly. */
export const STATUS_DIR = path.join(os.homedir(), 'Library', 'Group Containers', 'N2597TV587.orcha')
export const STATUS_FILE = path.join(STATUS_DIR, 'status.json')

export interface WidgetStatus {
  v: 3
  updatedAt: string
  totalAttention: number
  stacks: Array<{
    projectShort: string
    running: boolean
    attention: number
    /** Agents currently working (counted before the roster cap). */
    working: number
    /** v3: each entry carries model + current task alongside alias/kind/status. */
    agents: AgentSummary[]
    tasks: { ready: number; inProgress: number; needsVerification: number }
  }>
  /** What's actually waiting on the human — capped so the file stays small. */
  attention: Array<{ projectShort: string; kind: AttentionItem['kind']; title: string }>
}

export interface StatusFs {
  mkdir(dir: string, opts: { recursive: boolean }): Promise<unknown>
  writeFile(file: string, data: string): Promise<unknown>
  rename(from: string, to: string): Promise<unknown>
}

const ATTENTION_MAX = 8

export function buildStatus(
  stacks: Stack[],
  items: AttentionItem[],
  details: Map<string, StackAttention>,
  now: Date
): WidgetStatus {
  const counts = new Map<string, number>()
  for (const i of items) counts.set(i.project, (counts.get(i.project) ?? 0) + 1)
  return {
    v: 3,
    updatedAt: now.toISOString(),
    totalAttention: items.length,
    stacks: stacks.map((s) => {
      const d = details.get(s.project) // stopped stacks aren't fetched -> zeros
      const agents = d?.agents ?? []
      return {
        projectShort: s.projectShort,
        running: s.running,
        attention: counts.get(s.project) ?? 0,
        working: agents.filter((a) => a.status === 'working').length,
        agents,
        tasks: d?.tasks ?? { ready: 0, inProgress: 0, needsVerification: 0 }
      }
    }),
    attention: items
      .slice(0, ATTENTION_MAX)
      .map((i) => ({ projectShort: i.projectShort, kind: i.kind, title: i.title }))
  }
}

/** Best-effort atomic write — the widget shows stale-data state on its own. */
export async function writeStatusFile(status: WidgetStatus, fs: StatusFs = nodeFs): Promise<void> {
  try {
    await fs.mkdir(STATUS_DIR, { recursive: true })
    await fs.writeFile(`${STATUS_FILE}.tmp`, JSON.stringify(status))
    await fs.rename(`${STATUS_FILE}.tmp`, STATUS_FILE)
  } catch {
    // best-effort: never let widget plumbing break the app
  }
}
