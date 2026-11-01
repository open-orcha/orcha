import { execFile } from 'node:child_process'
import { promises as nodeFs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentSummary, StackAttention } from './attention'
import { isDecisionItem, type AttentionItem, type Stack } from '../shared/types'

/** App Group shared with the native WidgetKit extension: `<signing team>.orcha`
 *  (FX6LQ4M698.orcha; the widget declares the same id). macOS only lets an app use a
 *  group container its own signature is entitled to. Touching anyone else's (e.g. the
 *  old N2597TV587.orcha) raises the "would like to access data from other apps" prompt,
 *  again and again (GH #397). So the group is never hardcoded here: it is read
 *  from the running app's entitlements once, and with no matching entitlement
 *  (dev builds, older signed builds) the status file is not written at all. */
export const APP_GROUP_SUFFIX = '.orcha'

export interface StatusTarget {
  dir: string
  file: string
}

export function statusTarget(groupId: string, home = os.homedir()): StatusTarget {
  const dir = path.join(home, 'Library', 'Group Containers', groupId)
  return { dir, file: path.join(dir, 'status.json') }
}

/** The `<team>.orcha` group from a `codesign --entitlements - --xml` plist, if any. */
export function appGroupFromEntitlements(xml: string): string | null {
  const m = /<key>com\.apple\.security\.application-groups<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)
  if (!m) return null
  for (const g of m[1].matchAll(/<string>([^<]*)<\/string>/g)) {
    const id = g[1].trim()
    if (id.endsWith(APP_GROUP_SUFFIX) && id.length > APP_GROUP_SUFFIX.length) return id
  }
  return null
}

/** The .app bundle around the running executable (…/X.app/Contents/MacOS/X). */
export function bundleFromExecPath(execPath: string): string | null {
  const bundle = path.resolve(execPath, '..', '..', '..')
  return bundle.endsWith('.app') ? bundle : null
}

/** Reads the running app's own signed entitlements (never another app's data). */
export function readOwnEntitlements(bundle: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', bundle], { encoding: 'utf8', timeout: 5000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
  )
}

export interface ResolveDeps {
  platform: NodeJS.Platform
  execPath: string
  readEntitlements(bundle: string): Promise<string>
}

/** Where this app may write the widget file, or null when it isn't entitled to a group. */
export async function resolveStatusTarget(
  deps: ResolveDeps = { platform: process.platform, execPath: process.execPath, readEntitlements: readOwnEntitlements }
): Promise<StatusTarget | null> {
  if (deps.platform !== 'darwin') return null
  const bundle = bundleFromExecPath(deps.execPath)
  if (!bundle) return null
  try {
    const group = appGroupFromEntitlements(await deps.readEntitlements(bundle))
    return group ? statusTarget(group) : null
  } catch {
    return null
  }
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

/** A refusal from macOS (privacy/sandbox), as opposed to a transient disk error. */
const isDenied = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/** Best-effort atomic write — the widget shows stale-data state on its own.
 *  Resolves 'denied' when macOS refused access, so the caller can stop trying. */
export async function writeStatusFile(status: WidgetStatus, target: StatusTarget, fs: StatusFs = nodeFs): Promise<'ok' | 'denied' | 'failed'> {
  try {
    await fs.mkdir(target.dir, { recursive: true })
    await fs.writeFile(`${target.file}.tmp`, JSON.stringify(status))
    await fs.rename(`${target.file}.tmp`, target.file)
    return 'ok'
  } catch (err) {
    // best-effort: never let widget plumbing break the app
    return isDenied(err) ? 'denied' : 'failed'
  }
}

/** Writes the widget file on every poll, but only into the app's own entitled group,
 *  and gives up for the rest of the session after the first denial, so macOS is
 *  never asked again until relaunch. */
export class StatusFileWriter {
  private target: Promise<StatusTarget | null> | null = null
  private stopped = false

  constructor(
    private resolve: () => Promise<StatusTarget | null> = () => resolveStatusTarget(),
    private fs: StatusFs = nodeFs,
    private warn: (msg: string) => void = (msg) => console.warn(`[orcha-desktop] ${msg}`)
  ) {}

  async write(status: WidgetStatus): Promise<void> {
    if (this.stopped) return
    this.target ??= this.resolve().catch(() => null)
    const target = await this.target
    if (!target || this.stopped) return
    if ((await writeStatusFile(status, target, this.fs)) === 'denied') {
      this.stopped = true
      this.warn(`widget status file: access to ${target.dir} denied; not retrying this session`)
    }
  }
}
