import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { FolderGit2, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '../ui/Button'
import ErrorNotice from '../components/ErrorNotice'
import { formatBytes } from '../host/removeProject'
import type {
  AgentWorktree,
  AgentWorktreeCleanResult,
  AgentWorktreeState,
  ProjectWorktrees,
  WorktreeCleanEntry
} from '../../../shared/types'

export const STATE_LABEL: Record<AgentWorktreeState, string> = {
  clean: 'Clean',
  'has-output': 'Has output',
  unmerged: 'Unmerged commits',
  'in-use': 'In use',
  'not-quorate': 'Not Embodent'
}
const STATE_CLASS: Record<AgentWorktreeState, string> = {
  clean: 'text-ok',
  'has-output': 'text-accent',
  unmerged: 'text-warn',
  'in-use': 'text-text-2',
  'not-quorate': 'text-text-3'
}

/** "3 clean · 1 has output · 1 unmerged" (pure, tested). */
export function stateSummary(items: readonly AgentWorktree[]): string {
  const order: AgentWorktreeState[] = ['clean', 'has-output', 'unmerged', 'in-use', 'not-quorate']
  return order
    .map((s) => [s, items.filter((i) => i.state === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${STATE_LABEL[s].toLowerCase()}`)
    .join(' · ')
}

const size = (n: number | null | undefined): string => formatBytes(n ?? null) ?? '—'

interface Preview {
  folder: string
  scope: 'all' | 'clean'
  result: AgentWorktreeCleanResult
  optIn: Set<string>
}

/** Settings › Storage › Agent worktrees — every project's agent worktrees (classified by the
 *  Orcha CLI, the same rules the notifier uses), what can be reclaimed, and a clean-up that
 *  always previews first (a dry run grouped by what will happen) before it changes anything. */
export default function AgentWorktreesStorage() {
  const api = window.orchaDesktop
  const [projects, setProjects] = useState<ProjectWorktrees[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [reports, setReports] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())

  const scan = useCallback(async () => {
    if (!api.storageWorktrees) return
    setScanning(true)
    setError(null)
    try {
      setProjects(await api.storageWorktrees())
    } catch (err) {
      setError(err)
    } finally {
      setScanning(false)
    }
  }, [api])
  useEffect(() => {
    void scan()
  }, [scan])

  if (!api.storageWorktrees || !api.storageCleanWorktrees) return null

  const startPreview = async (p: ProjectWorktrees, scope: 'all' | 'clean'): Promise<void> => {
    setBusy(p.folder)
    setError(null)
    try {
      const result = await api.storageCleanWorktrees!({ folder: p.folder, dryRun: true, onlyClean: scope === 'clean', unmerged: [] })
      setPreview({ folder: p.folder, scope, result, optIn: new Set() })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  const run = async (): Promise<void> => {
    if (!preview) return
    const { folder, scope, optIn } = preview
    setBusy(folder)
    try {
      const res = await api.storageCleanWorktrees!({ folder, dryRun: false, onlyClean: scope === 'clean', unmerged: [...optIn] })
      setReports((r) => ({
        ...r,
        [folder]: `Removed ${res.removed.length} worktree${res.removed.length === 1 ? '' : 's'} · ${size(res.freed_bytes)} freed${res.kept.length ? ` · ${res.kept.length} kept` : ''}`
      }))
      setPreview(null)
      await scan()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(null)
    }
  }

  const all = projects ?? []
  const total = all.reduce((n, p) => n + p.reclaimable_bytes, 0)

  return (
    <div className="mb-8" data-testid="storage-worktrees">
      <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-text-3">
        <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />
        Agent worktrees
        {projects && <span className="tabular-nums">· {size(total)} reclaimable</span>}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void scan()} disabled={scanning || !!busy} aria-label="Scan worktrees again">
          <RefreshCw className={scanning ? 'animate-spin' : ''} /> Scan
        </Button>
      </div>
      <p className="mb-2 text-[12px] text-text-3">
        Agents work in git worktrees inside each project’s .orcha-worktrees folder. Clean ones hold only Embodent’s own files; output is saved to its task before a worktree with output goes; unmerged commits are kept.
      </p>
      {error != null && (
        <div className="mb-2 rounded-md border border-border px-3 py-2">
          <ErrorNotice error={error} prefix="Couldn’t check agent worktrees" wrap />
        </div>
      )}
      {!projects && scanning && (
        <p className="flex items-center gap-2 text-[13px] text-text-3" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Looking at agent worktrees…
        </p>
      )}
      {projects && all.length === 0 && (
        <p className="rounded-[10px] border border-border px-4 py-4 text-center text-[13px] text-text-3" data-testid="storage-worktrees-empty">
          No agent worktrees in your projects.
        </p>
      )}
      <ul className="divide-y divide-border rounded-[10px] border border-border" aria-label="Agent worktrees by project">
        {all.map((p) => {
          const clean = p.items.filter((i) => i.state === 'clean').length
          const isOpen = open.has(p.folder)
          return (
            <li key={p.folder} className="px-4 py-3" data-testid={`storage-wt-${p.projectShort}`}>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  aria-expanded={isOpen}
                  onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(p.folder)) n.delete(p.folder); else n.add(p.folder); return n })}
                >
                  <div className="truncate text-[13px] font-medium text-text">{p.projectShort}</div>
                  <div className="truncate text-[12px] text-text-3" title={p.folder}>
                    {p.error ? p.error : `${p.items.length} worktree${p.items.length === 1 ? '' : 's'} · ${stateSummary(p.items) || 'none'}`}
                  </div>
                </button>
                <span className="shrink-0 text-[12px] tabular-nums text-text-2">{size(p.reclaimable_bytes)}</span>
                <Button variant="outline" size="sm" disabled={!!busy || clean === 0} onClick={() => void startPreview(p, 'clean')}>
                  Clean up now{clean ? ` (${clean})` : ''}
                </Button>
                <Button variant="outline" size="sm" disabled={!!busy || p.items.length === 0} onClick={() => void startPreview(p, 'all')}>
                  {busy === p.folder && !preview ? 'Checking…' : 'Clean up existing…'}
                </Button>
              </div>
              {reports[p.folder] && <p className="mt-1.5 text-[12px] text-ok" role="status">{reports[p.folder]}</p>}
              {isOpen && p.items.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1" aria-label={`Worktrees of ${p.projectShort}`}>
                  {p.items.map((w) => (
                    <li key={w.path} className="flex items-center gap-3 text-[12.5px]">
                      <span className={`w-[124px] shrink-0 ${STATE_CLASS[w.state]}`}>{STATE_LABEL[w.state]}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-text-2" title={w.reason ?? w.path}>{w.branch ?? w.name}</span>
                      <span className="shrink-0 tabular-nums text-text-3">{size(w.size_bytes)}</span>
                      {api.revealWorktree && (
                        <Button variant="ghost" size="sm" aria-label={`Show ${w.name} in Finder`} onClick={() => void api.revealWorktree!(p.folder, w.path).catch(() => {})}>
                          <FolderOpen />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {preview && preview.folder === p.folder && (
                <PreviewPanel preview={preview} busy={busy === p.folder} onToggle={(path, on) =>
                  setPreview((pv) => {
                    if (!pv) return pv
                    const n = new Set(pv.optIn)
                    if (on) n.add(path)
                    else n.delete(path)
                    return { ...pv, optIn: n }
                  })
                } onCancel={() => setPreview(null)} onRun={() => void run()} />
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Group({ title, verb, rows, children }: { title: string; verb: string; rows: WorktreeCleanEntry[]; children?: (r: WorktreeCleanEntry) => ReactNode }) {
  if (rows.length === 0) return null
  const bytes = rows.reduce((n, r) => n + (r.size_bytes ?? 0), 0)
  return (
    <section aria-label={title} className="mt-2">
      <div className="text-[12px] font-medium text-text">
        {title} <span className="font-normal text-text-3">· {rows.length} · {size(bytes)} · {verb}</span>
      </div>
      <ul className="ml-3 mt-0.5 flex flex-col gap-0.5 text-[12px]">
        {rows.map((r) => (
          <li key={r.path}>
            {children ? children(r) : <span className="font-mono text-text-2">{r.branch ?? r.name}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function PreviewPanel({ preview, busy, onToggle, onCancel, onRun }: {
  preview: Preview
  busy: boolean
  onToggle(path: string, on: boolean): void
  onCancel(): void
  onRun(): void
}) {
  const { result, optIn } = preview
  const clean = result.removed.filter((r) => r.state === 'clean')
  const output = result.removed.filter((r) => r.state === 'has-output')
  const unmerged = result.kept.filter((r) => r.state === 'unmerged')
  const otherKept = result.kept.filter((r) => r.state !== 'unmerged')
  const optInRows = unmerged.filter((r) => optIn.has(r.path))
  const count = result.removed.length + optInRows.length
  const freed = result.freed_bytes + optInRows.reduce((n, r) => n + (r.size_bytes ?? 0), 0)
  return (
    <div className="mt-2 rounded-md border border-border bg-bg/40 px-3 py-2.5" role="group" aria-label="Clean-up preview" data-testid="storage-wt-preview">
      <div className="text-[12.5px] text-text">Here’s exactly what will happen — nothing changes until you confirm.</div>
      <Group title="Clean" verb="remove" rows={clean} />
      <Group title="Has output" verb="save output to the task, then remove" rows={output}>
        {(r) => (
          <>
            <span className="font-mono text-text-2">{r.branch ?? r.name}</span>
            <ul className="ml-3 list-disc text-text-3">
              {(r.saves ?? []).slice(0, 4).map((f) => <li key={f} className="font-mono">{f}</li>)}
              {(r.saves ?? []).length > 4 && <li>…and {(r.saves ?? []).length - 4} more</li>}
            </ul>
          </>
        )}
      </Group>
      <Group title="Unmerged commits" verb="kept unless ticked (the branch is always kept)" rows={unmerged}>
        {(r) => (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={optIn.has(r.path)} onChange={(e) => onToggle(r.path, e.target.checked)} aria-label={`Remove ${r.name}, keep branch`} />
            <span className="font-mono text-text-2">{r.branch ?? r.name}</span>
          </label>
        )}
      </Group>
      <Group title="Kept" verb="has output (only clean ones are being cleaned)" rows={otherKept} />
      <Group title="In use / not Embodent" verb="skipped" rows={result.skipped} />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="destructive" size="sm" onClick={onRun} disabled={busy || count === 0}>
          {busy ? 'Cleaning up…' : count ? `Clean up ${count} · free ${size(freed)}` : 'Nothing to clean up'}
        </Button>
      </div>
    </div>
  )
}
