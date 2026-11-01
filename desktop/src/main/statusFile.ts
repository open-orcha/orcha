import { execFile } from 'node:child_process'
import path from 'node:path'
import type { AgentSummary, StackAttention } from './attention'
import { isDecisionItem, type AttentionItem, type Stack } from '../shared/types'

/** The widget reads status.json from the App Group `<signing team>.orcha` (FX6LQ4M698.orcha).
 *  On macOS 15+ touching a group container this app's signature does not own (e.g. the old
 *  N2597TV587.orcha, or any hand-built path) raises the "would like to access data from other
 *  apps" prompt, again and again (GH #397). So this process never touches Group Containers:
 *  it pipes the JSON to the bundled native helper Contents/MacOS/orcha-status-writer
 *  (native/status-writer), which is signed with the group entitlement, checks that its own
 *  signing team owns the group, gets the folder from containerURL(forSecurityApplication-
 *  GroupIdentifier:) and writes it. Dev builds have no helper, so nothing is written. */
export const STATUS_WRITER_NAME = 'orcha-status-writer'

/** The helper next to the running executable (…/X.app/Contents/MacOS/), or null when this
 *  is not a packaged macOS app. */
export function statusWriterPath(platform: NodeJS.Platform, execPath: string): string | null {
  if (platform !== 'darwin') return null
  const macosDir = path.dirname(execPath)
  if (path.basename(macosDir) !== 'MacOS' || !path.resolve(macosDir, '..', '..').endsWith('.app')) return null
  return path.join(macosDir, STATUS_WRITER_NAME)
}

/** ok: written · failed: transient, try again next poll · unavailable: no helper or no owned
 *  group (never will be this session) · denied: macOS refused access. */
export type WriteOutcome = 'ok' | 'failed' | 'unavailable' | 'denied'

/** Helper exit code -> outcome (codes are documented in native/status-writer/main.swift). */
export function outcomeFromExit(code: number | string | null | undefined): WriteOutcome {
  if (code === 0) return 'ok'
  if (code === 3 || code === 'ENOENT' || code === 'EACCES') return 'unavailable'
  if (code === 4) return 'denied'
  return 'failed'
}

/** Runs the helper once with the JSON on stdin. */
export function runStatusWriter(helper: string, json: string): Promise<WriteOutcome> {
  return new Promise((resolve) => {
    const child = execFile(helper, [], { timeout: 10_000 }, (err) =>
      resolve(outcomeFromExit(err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code ?? null) : 0))
    )
    child.stdin?.on('error', () => {}) // helper exited before reading (e.g. unavailable)
    child.stdin?.end(json)
  })
}

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

const ATTENTION_MAX = 8

export function buildStatus(
  stacks: Stack[],
  items: AttentionItem[],
  details: Map<string, StackAttention>,
  now: Date
): WidgetStatus {
  // Counts are DECISIONS only (plans, verifications, requests to a human/escalated) — the
  // same rule as the tray title and host sidebar. Follow-ups (answered requests a human
  // raised) are still listed below, after the decisions, but never counted (V2 arch §3.3).
  const decisions = items.filter(isDecisionItem)
  const followUps = items.filter((i) => !isDecisionItem(i))
  const counts = new Map<string, number>()
  for (const i of decisions) counts.set(i.project, (counts.get(i.project) ?? 0) + 1)
  return {
    v: 3,
    updatedAt: now.toISOString(),
    totalAttention: decisions.length,
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
    attention: [...decisions, ...followUps]
      .slice(0, ATTENTION_MAX)
      .map((i) => ({ projectShort: i.projectShort, kind: i.kind, title: i.title }))
  }
}

/** Hands the widget file to the helper on every poll, and stops for the rest of the
 *  session once the helper is missing, the app owns no group, or macOS refused access, so
 *  macOS is never asked again until relaunch. */
export class StatusFileWriter {
  private stopped = false

  constructor(
    private helper: string | null = statusWriterPath(process.platform, process.execPath),
    private run: (helper: string, json: string) => Promise<WriteOutcome> = runStatusWriter,
    private warn: (msg: string) => void = (msg) => console.warn(`[orcha-desktop] ${msg}`)
  ) {}

  async write(status: WidgetStatus): Promise<void> {
    if (this.stopped || !this.helper) return
    const outcome = await this.run(this.helper, JSON.stringify(status)).catch((): WriteOutcome => 'failed')
    if (outcome === 'unavailable' || outcome === 'denied') {
      this.stopped = true
      this.warn(`widget status file: ${outcome === 'denied' ? 'access denied' : 'no app group this build owns'}; not writing this session`)
    }
  }
}
