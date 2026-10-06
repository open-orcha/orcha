/** Terminal session restore: the tab set survives quitting the app.
 *
 *  Processes can't outlive the app (ptyHost kills every pty on quit), so what comes back is
 *  the SET of tabs, not their processes:
 *  - shells reopen a fresh login shell in the folder the shell was last in;
 *  - Claude Code tabs relaunch with `claude --resume <session_id>` (the id its own hooks
 *    reported — agentHooks.ts / agentStatus.ts), Codex tabs with `codex resume <thread-id>`
 *    (its `notify` payload); with no id captured, `--continue` / `resume --last` only when that
 *    tab was the only one of its agent in that folder (otherwise "most recent" could be a
 *    different conversation) — else a fresh conversation, and the tab says so;
 *  - other registry agents start fresh (no documented resume by id).
 *  Title, pin, colour, order, selection and the sidebar row come back too.
 *
 *  Where the facts come from (never the renderer for anything that reaches a spawn):
 *  - main's own session facts (ptyHost.facts(): kind, project, branch, launch cwd, agent
 *    conversation id) and the shell's live cwd (`lsof -d cwd` of the shell's pid);
 *  - the renderer reports only cosmetic layout keyed by pty ids main minted (parseLayout).
 *
 *  Everything read back from disk is re-validated (parseSavedSessions): known kinds, project
 *  and branch NAMES, a normalised absolute cwd that must still be a directory inside $HOME or
 *  a known project folder, conversation ids that are strict UUIDs. A restore can never block
 *  startup (every failure is swallowed into `dropped`) and restores at most RESTORE_MAX_TABS.
 *
 *  Electron-free and clock/fs/pty-injected — sessionRestore.test.ts. */
import path from 'node:path'
import type { AgentId } from '../shared/agents'
import {
  isBranchName,
  isRowKey,
  isTabColor,
  isTermKind,
  parseLayout,
  PROJECT_RE,
  TAB_TITLE_MAX,
  type RestoredHow,
  type RestoredTab,
  type TabColor,
  type TermInfo,
  type TermKind,
  type TermLayout,
  type TermRestoreRequest,
  type TermRestoreResult
} from '../shared/terminal'
import { isAgentSessionId } from './agentStatus'
import type { SessionFacts } from './ptyHost'
import type { KnownProject } from './terminalLaunch'

export const SESSIONS_FILE = 'terminal-sessions.json'
export const SESSIONS_VERSION = 1
/** Most tabs a launch reopens (the rest are left out, with a note). */
export const RESTORE_MAX_TABS = 20
/** Most tabs the file may describe (anything longer is treated as corrupt). */
export const SAVED_TABS_MAX = 64
/** Layout reports / session-id captures are coalesced for this long before a write. */
export const SAVE_DEBOUNCE_MS = 400
const CWD_MAX = 1024

export function sessionsFilePath(userDataDir: string): string {
  return path.join(userDataDir, SESSIONS_FILE)
}

export interface SavedTab {
  kind: TermKind
  project: string | null
  /** Branch of the checkout the session ran in (sidebar grouping). */
  branch: string | null
  /** Branch the user launched on (Restart reuses it). */
  launchBranch: string | null
  /** Shell: the folder it was last in. Agent: the folder it was launched in. */
  cwd: string
  title: string | null
  pinned: boolean
  color: TabColor | null
  rowKey: string | null
  /** The agent's own conversation id (UUID); null for shells / none captured. */
  agentSession: string | null
}

export interface SavedSessions {
  version: 1
  savedAt: number
  tabs: SavedTab[]
  /** Index into `tabs` of the selected tab. */
  active: number | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A normalised absolute path with no control characters (no `..`, no `//`, no trailing /). */
export function isCleanAbsPath(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= CWD_MAX &&
    v.startsWith('/') &&
    !/[\u0000-\u001f\u007f]/.test(v) &&
    path.posix.normalize(v) === v &&
    (v === '/' || !v.endsWith('/'))
  )
}

/** One saved tab, or null when anything about it is off (dropped, never coerced). */
export function parseSavedTab(raw: unknown): SavedTab | null {
  if (!isRecord(raw)) return null
  const keys = ['kind', 'project', 'branch', 'launchBranch', 'cwd', 'title', 'pinned', 'color', 'rowKey', 'agentSession']
  if (!Object.keys(raw).every((k) => keys.includes(k))) return null
  if (!isTermKind(raw.kind)) return null
  const project = raw.project ?? null
  if (project !== null && (typeof project !== 'string' || !PROJECT_RE.test(project))) return null
  const branch = raw.branch ?? null
  const launchBranch = raw.launchBranch ?? null
  if ((branch !== null && !isBranchName(branch)) || (launchBranch !== null && !isBranchName(launchBranch))) return null
  if ((branch !== null || launchBranch !== null) && project === null) return null
  if (!isCleanAbsPath(raw.cwd)) return null
  const title = raw.title ?? null
  if (title !== null && (typeof title !== 'string' || title.trim() === '' || title.length > TAB_TITLE_MAX)) return null
  const pinned = raw.pinned ?? false
  if (typeof pinned !== 'boolean') return null
  const color = raw.color ?? null
  if (color !== null && !isTabColor(color)) return null
  const rowKey = raw.rowKey ?? null
  if (rowKey !== null && (!isRowKey(rowKey) || project === null || !(rowKey === project || rowKey.startsWith(`${project}:`)))) return null
  const agentSession = raw.agentSession ?? null
  if (agentSession !== null && (raw.kind === 'shell' || !isAgentSessionId(agentSession))) return null
  return {
    kind: raw.kind,
    project: project as string | null,
    branch: branch as string | null,
    launchBranch: launchBranch as string | null,
    cwd: raw.cwd,
    title: title === null ? null : (title as string).trim(),
    pinned,
    color: color as TabColor | null,
    rowKey: rowKey as string | null,
    agentSession: agentSession as string | null
  }
}

/** Parse the file's JSON. Wrong top-level shape / version → null (nothing restored); a bad
 *  individual tab is dropped (counted) and the selection index follows the kept tabs. */
export function parseSavedSessions(raw: unknown): { saved: SavedSessions; dropped: number } | null {
  if (!isRecord(raw) || raw.version !== SESSIONS_VERSION) return null
  if (!Array.isArray(raw.tabs) || raw.tabs.length > SAVED_TABS_MAX) return null
  const savedAt = typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0
  const rawActive = raw.active ?? null
  const activeIn = typeof rawActive === 'number' && Number.isInteger(rawActive) && rawActive >= 0 ? rawActive : null
  const tabs: SavedTab[] = []
  let active: number | null = null
  let dropped = 0
  raw.tabs.forEach((t, i) => {
    const tab = parseSavedTab(t)
    if (!tab) {
      dropped++
      return
    }
    if (i === activeIn) active = tabs.length
    tabs.push(tab)
  })
  return { saved: { version: 1, savedAt, tabs, active }, dropped }
}

// ---- resume argv ------------------------------------------------------------------------

export type ResumePlan = { mode: 'resume'; id: string } | { mode: 'continue' } | null

/** Agents with a documented resume: Claude Code (`--resume <id>` / `--continue`, see
 *  `claude --help`) and Codex (`codex resume <id>` / `codex resume --last`, `codex resume
 *  --help`: options follow the subcommand). */
export const RESUMABLE_AGENTS: readonly AgentId[] = ['claude', 'codex']

/** Claude flags that already choose the conversation — the user's own extra args win. */
const CLAUDE_SESSION_FLAGS = ['--resume', '-r', '--continue', '-c', '--session-id', '--from-pr', '--fork-session', '--teleport']

export function agentPicksOwnSession(kind: AgentId, args: readonly string[]): boolean {
  if (kind !== 'claude') return false
  return args.some((a) => CLAUDE_SESSION_FLAGS.includes(a) || CLAUDE_SESSION_FLAGS.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)))
}

/** The final agent argv (after hook wiring + permission mode + extra args) with the resume
 *  added. The id is a validated UUID; each element is single-quoted again at spawn. */
export function withResume(kind: AgentId, args: readonly string[], plan: ResumePlan): string[] {
  if (!plan) return [...args]
  if (plan.mode === 'resume' && !isAgentSessionId(plan.id)) return [...args]
  if (kind === 'claude') {
    if (agentPicksOwnSession(kind, args)) return [...args]
    return plan.mode === 'resume' ? [...args, '--resume', plan.id] : [...args, '--continue']
  }
  if (kind === 'codex') {
    return plan.mode === 'resume' ? ['resume', plan.id, ...args] : ['resume', '--last', ...args]
  }
  return [...args]
}

// ---- restore planning (pure) --------------------------------------------------------------

export interface RestoreItem {
  saved: SavedTab
  kind: TermKind
  project: KnownProject | null
  cwd: string
  resume: ResumePlan
  /** Conversation id the new session starts out with (kept until the agent reports one). */
  agentSession: string | null
  how: RestoredHow
  note: string
}

export interface RestorePlanContext {
  projects: readonly KnownProject[]
  home: string
  isDir(p: string): boolean
  /** Resolve symlinks (null = gone). The resolved path must stay inside the same roots. */
  realpath?(p: string): string | null
  resumeAgents: boolean
  /** The user's extra args per agent (a session flag there wins over our resume). */
  extraArgs?(kind: AgentId): readonly string[]
}

export interface RestorePlan {
  items: RestoreItem[]
  /** Tabs whose project isn't discovered right now (restored when it is). */
  deferred: SavedTab[]
  capped: number
  dropped: number
  /** Index into `items` of the tab to select. */
  active: number | null
}

function isUnder(p: string, root: string): boolean {
  const r = root.length > 1 ? root.replace(/\/+$/, '') : root
  return p === r || p.startsWith(r === '/' ? '/' : `${r}/`)
}

export const RESTORED_NOTES: Record<RestoredHow, string> = {
  shell: 'Restored · new shell',
  resumed: 'Restored · conversation resumed',
  continued: 'Restored · most recent conversation',
  fresh: 'Restored · new conversation'
}

/** Decide, for every saved tab, where it reopens and how. Pure. */
export function planRestore(saved: SavedSessions, ctx: RestorePlanContext, max = RESTORE_MAX_TABS): RestorePlan {
  const byProject = new Map(ctx.projects.map((p) => [p.project, p]))
  const folders = ctx.projects
    .map((p) => p.folder)
    .filter((f): f is string => typeof f === 'string' && f.startsWith('/') && !f.includes('\0'))
  const roots = [ctx.home, ...folders]
  const allowed = (p: string): boolean => {
    if (!isCleanAbsPath(p) || !roots.some((r) => isUnder(p, r)) || !ctx.isDir(p)) return false
    if (!ctx.realpath) return true
    const real = ctx.realpath(p)
    return real !== null && roots.some((r) => isUnder(real, r) || isUnder(real, ctx.realpath!(r) ?? r))
  }
  // "Only tab of its agent in that folder" — counted over the whole saved set.
  const perCwd = new Map<string, number>()
  for (const t of saved.tabs) if (t.kind !== 'shell') perCwd.set(`${t.kind}\0${t.cwd}`, (perCwd.get(`${t.kind}\0${t.cwd}`) ?? 0) + 1)

  const items: RestoreItem[] = []
  const deferred: SavedTab[] = []
  let capped = 0
  let dropped = 0
  let active: number | null = null
  saved.tabs.forEach((t, i) => {
    const known = t.project !== null ? (byProject.get(t.project) ?? null) : null
    if (t.project !== null && !known) {
      deferred.push(t)
      return
    }
    if (items.length >= max) {
      capped++
      return
    }
    let cwd = t.cwd
    let moved = false
    if (!allowed(cwd)) {
      const fallback = known?.folder && allowed(known.folder) ? known.folder : ctx.isDir(ctx.home) ? ctx.home : null
      if (!fallback) {
        dropped++
        return
      }
      cwd = fallback
      moved = true
    }
    let resume: ResumePlan = null
    let how: RestoredHow = 'shell'
    if (t.kind !== 'shell') {
      how = 'fresh'
      const kind = t.kind
      const ownFlags = agentPicksOwnSession(kind, ctx.extraArgs?.(kind) ?? [])
      if (ctx.resumeAgents && !moved && !ownFlags && RESUMABLE_AGENTS.includes(kind)) {
        if (t.agentSession) {
          resume = { mode: 'resume', id: t.agentSession }
          how = 'resumed'
        } else if ((perCwd.get(`${kind}\0${t.cwd}`) ?? 0) === 1) {
          resume = { mode: 'continue' }
          how = 'continued'
        }
      }
    }
    if (i === saved.active) active = items.length
    items.push({
      saved: t,
      kind: t.kind,
      project: known,
      cwd,
      resume,
      agentSession: resume?.mode === 'resume' ? resume.id : null,
      how,
      note: moved ? `${RESTORED_NOTES[how]} · folder moved` : RESTORED_NOTES[how]
    })
  })
  if (active === null && items.length > 0) active = items.length - 1
  return { items, deferred, capped, dropped, active }
}

// ---- live cwd of shells (lsof) -----------------------------------------------------------

/** argv for `lsof`: the cwd of each pid, machine-readable (`-F n`). */
export function lsofArgs(pids: readonly number[]): string[] {
  return ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn']
}

/** Parse `lsof -F` output (`p<pid>` then `n<path>` lines) into pid → cwd. */
export function parseLsofCwds(out: string): Map<number, string> {
  const map = new Map<number, string>()
  let pid: number | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1))
      pid = Number.isInteger(n) && n > 0 ? n : null
    } else if (line.startsWith('n') && pid !== null) {
      const p = line.slice(1)
      if (isCleanAbsPath(p)) map.set(pid, p)
    }
  }
  return map
}

// ---- the keeper (persist + restore) -------------------------------------------------------

export interface SessionKeeperDeps {
  facts(): SessionFacts[]
  /** Live sessions right now (a renderer reload re-attaches instead of restoring). */
  liveCount(): number
  read(): unknown
  write(s: SavedSessions): void
  /** Current cwd of these pids (async while running, sync on quit). */
  liveCwds(pids: number[]): Promise<Map<number, string>>
  liveCwdsSync(pids: number[]): Map<number, string>
  prefs(): { restoreSessions: boolean; resumeAgents: boolean; extraArgs?(kind: AgentId): readonly string[] }
  listProjects(): Promise<KnownProject[]>
  home: string
  isDir(p: string): boolean
  realpath?(p: string): string | null
  /** Start one restored session (terminalIpc.restoreSpawn). Throws on failure. */
  spawn(item: RestoreItem): TermInfo
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(h: unknown): void
}

const EMPTY_RESULT: TermRestoreResult = { tabs: [], active: null, skipped: 0, capped: 0, deferred: 0, dropped: 0 }

export function createSessionKeeper(deps: SessionKeeperDeps) {
  let layout: TermLayout | null = null
  /** Saves are ignored until the launch restore ran — an early save must not overwrite the
   *  file before it was read. Reset by `freeze()` (window closed / quitting). */
  let ready = false
  let frozen = false
  let timer: unknown = null
  const cwdCache = new Map<number, string>()
  /** Saved tabs waiting for their project to be discovered (kept in every save). */
  let deferred: SavedTab[] = []
  /** The set the setting skipped at launch — ⌘K "Restore last session" offers it. */
  let skipped: SavedSessions | null = null
  let lastWritten = ''

  const compose = (cwds: Map<number, string>): SavedSessions => {
    const facts = deps.facts().filter((f) => !f.probe)
    const byId = new Map(facts.map((f) => [f.id, f]))
    const tabs: SavedTab[] = []
    let active: number | null = null
    const push = (f: SessionFacts, l: TermLayout['tabs'][number] | null): void => {
      const liveCwd = f.kind === 'shell' ? (cwds.get(f.pid) ?? cwdCache.get(f.id) ?? f.cwd) : f.cwd
      const project = f.project
      const rowKey = l?.rowKey && project && (l.rowKey === project || l.rowKey.startsWith(`${project}:`)) ? l.rowKey : null
      const tab = parseSavedTab({
        kind: f.kind,
        project,
        branch: f.branch,
        launchBranch: project ? (l?.launchBranch ?? null) : null,
        cwd: liveCwd,
        title: l?.title ?? null,
        pinned: l?.pinned ?? false,
        color: l?.color ?? null,
        rowKey,
        agentSession: f.kind === 'shell' ? null : f.agentSession
      })
      if (tab) tabs.push(tab)
    }
    for (const l of layout?.tabs ?? []) {
      const f = byId.get(l.id)
      if (!f) continue
      byId.delete(l.id)
      if (l.id === layout?.active) active = tabs.length
      push(f, l)
    }
    // Sessions the renderer hasn't reported yet (just opened) keep their place at the end.
    for (const f of byId.values()) push(f, null)
    for (const d of deferred) if (tabs.length < SAVED_TABS_MAX) tabs.push(d)
    return { version: 1, savedAt: deps.now(), tabs: tabs.slice(0, SAVED_TABS_MAX), active }
  }

  const writeIfChanged = (s: SavedSessions): void => {
    const key = JSON.stringify({ ...s, savedAt: 0 })
    if (key === lastWritten) return
    try {
      deps.write(s)
      lastWritten = key
    } catch {
      // best effort — the next change tries again
    }
  }

  const shellPids = (): { pids: number[]; idByPid: Map<number, number> } => {
    const live = deps.facts().filter((f) => f.kind === 'shell' && !f.exited && !f.probe)
    return { pids: live.map((f) => f.pid), idByPid: new Map(live.map((f) => [f.pid, f.id])) }
  }

  const remember = (cwds: Map<number, string>, idByPid: Map<number, number>): void => {
    for (const [pid, cwd] of cwds) {
      const id = idByPid.get(pid)
      if (id !== undefined) cwdCache.set(id, cwd)
    }
  }

  const saveSoon = (): void => {
    if (!ready || frozen) return
    if (timer !== null) deps.clearTimer(timer)
    timer = deps.setTimer(() => {
      timer = null
      if (!ready || frozen) return
      const { pids, idByPid } = shellPids()
      const done = (cwds: Map<number, string>): void => {
        if (!ready || frozen) return
        remember(cwds, idByPid)
        writeIfChanged(compose(cwds))
      }
      if (pids.length === 0) done(new Map())
      else
        void deps
          .liveCwds(pids)
          .catch(() => new Map<number, string>())
          .then(done)
    }, SAVE_DEBOUNCE_MS)
  }

  const spawnAll = (plan: RestorePlan): { tabs: RestoredTab[]; active: number | null; dropped: number } => {
    const tabs: RestoredTab[] = []
    let active: number | null = null
    let dropped = plan.dropped
    plan.items.forEach((item, i) => {
      try {
        const info = deps.spawn(item)
        if (i === plan.active) active = info.id
        tabs.push({
          info,
          title: item.saved.title,
          pinned: item.saved.pinned,
          color: item.saved.color,
          rowKey: item.saved.rowKey,
          launchBranch: item.saved.launchBranch,
          how: item.how,
          note: item.note
        })
      } catch {
        dropped++
      }
    })
    if (active === null && tabs.length > 0) active = tabs[tabs.length - 1].info.id
    return { tabs, active, dropped }
  }

  /** Until the renderer reports its layout, the restored order IS the layout. */
  const adoptLayout = (tabs: RestoredTab[], active: number | null): void => {
    const prior = layout?.tabs ?? []
    const known = new Set(prior.map((t) => t.id))
    layout = {
      tabs: [
        ...prior,
        ...tabs
          .filter((t) => !known.has(t.info.id))
          .map((t) => ({ id: t.info.id, title: t.title, pinned: t.pinned, color: t.color, rowKey: t.rowKey, launchBranch: t.launchBranch }))
      ],
      active: active ?? layout?.active ?? null
    }
  }

  const planFor = async (saved: SavedSessions): Promise<RestorePlan> => {
    const projects = await deps.listProjects().catch(() => [] as KnownProject[])
    const prefs = deps.prefs()
    return planRestore(saved, {
      projects,
      home: deps.home,
      isDir: deps.isDir,
      realpath: deps.realpath,
      resumeAgents: prefs.resumeAgents,
      extraArgs: prefs.extraArgs
    })
  }

  return {
    /** Renderer layout report (already sender-checked by the caller). */
    layout(raw: unknown): boolean {
      const l = parseLayout(raw)
      if (!l || frozen) return false
      layout = l
      saveSoon()
      return true
    },
    /** An agent reported a (new) conversation id. */
    agentSessionChanged(): void {
      saveSoon()
    },
    /** Window closing / app quitting: write the final set NOW (sync), then ignore everything
     *  until the next launch restore — the kill-all that follows must not be persisted. */
    freeze(): void {
      if (timer !== null) {
        deps.clearTimer(timer)
        timer = null
      }
      if (ready && !frozen) {
        try {
          const { pids, idByPid } = shellPids()
          const cwds = pids.length ? deps.liveCwdsSync(pids) : new Map<number, string>()
          remember(cwds, idByPid)
          writeIfChanged(compose(cwds))
        } catch {
          // never block quitting
        }
      }
      frozen = true
      ready = false
      layout = null
      cwdCache.clear()
    },
    /** A project was removed: drop its saved tabs (waiting-for-discovery and the skipped
     *  "Restore last session" set) so they never come back, and persist that. Returns how
     *  many saved tabs were dropped. Live tabs are closed by the renderer. */
    forgetProject(project: string): number {
      const before = deferred.length + (skipped?.tabs.length ?? 0)
      deferred = deferred.filter((t) => t.project !== project)
      if (skipped) {
        const tabs = skipped.tabs.filter((t) => t.project !== project)
        skipped = tabs.length > 0 ? { ...skipped, tabs, active: null } : null
      }
      const dropped = before - (deferred.length + (skipped?.tabs.length ?? 0))
      if (dropped > 0) saveSoon()
      return dropped
    },
    /** Is there a skipped set ⌘K could restore? */
    skippedCount(): number {
      return skipped?.tabs.length ?? 0
    },
    async restore(raw: TermRestoreRequest): Promise<TermRestoreResult> {
      try {
        if (raw.project) {
          if (!ready) return EMPTY_RESULT
          const waiting = deferred.filter((t) => t.project === raw.project)
          if (waiting.length === 0) return EMPTY_RESULT
          const plan = await planFor({ version: 1, savedAt: 0, tabs: waiting, active: null })
          if (plan.items.length === 0 && plan.dropped === 0) return { ...EMPTY_RESULT, deferred: deferred.length }
          // That project's tabs are now restored, dropped or capped — or still waiting.
          deferred = deferred.filter((t) => t.project !== raw.project || plan.deferred.includes(t))
          const out = spawnAll({ ...plan, active: null })
          adoptLayout(out.tabs, null)
          saveSoon()
          return { tabs: out.tabs, active: null, skipped: 0, capped: plan.capped, deferred: deferred.length, dropped: out.dropped }
        }
        if (raw.manual) {
          const set = skipped
          if (!set) return EMPTY_RESULT
          skipped = null
          const plan = await planFor(set)
          deferred = [...deferred, ...plan.deferred]
          const out = spawnAll(plan)
          adoptLayout(out.tabs, out.active)
          ready = true
          frozen = false
          saveSoon()
          return { tabs: out.tabs, active: out.active, skipped: 0, capped: plan.capped, deferred: deferred.length, dropped: out.dropped }
        }
        // Launch restore: only into an empty app (a reloaded renderer re-attaches instead).
        if (deps.liveCount() > 0) {
          ready = true
          frozen = false
          return EMPTY_RESULT
        }
        frozen = false
        let parsed: ReturnType<typeof parseSavedSessions> = null
        try {
          parsed = parseSavedSessions(deps.read())
        } catch {
          parsed = null
        }
        ready = true
        if (!parsed || parsed.saved.tabs.length === 0) return { ...EMPTY_RESULT, dropped: parsed?.dropped ?? 0 }
        if (!deps.prefs().restoreSessions) {
          skipped = parsed.saved
          return { ...EMPTY_RESULT, skipped: parsed.saved.tabs.length, dropped: parsed.dropped }
        }
        const plan = await planFor(parsed.saved)
        deferred = plan.deferred
        const out = spawnAll(plan)
        layout = null
        adoptLayout(out.tabs, out.active)
        saveSoon()
        return {
          tabs: out.tabs,
          active: out.active,
          skipped: 0,
          capped: plan.capped,
          deferred: deferred.length,
          dropped: out.dropped + parsed.dropped
        }
      } catch {
        ready = true
        frozen = false
        return EMPTY_RESULT
      }
    }
  }
}

export type SessionKeeper = ReturnType<typeof createSessionKeeper>
