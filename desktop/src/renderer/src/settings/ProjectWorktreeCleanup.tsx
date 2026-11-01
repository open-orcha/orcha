import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import ErrorNotice from '../components/ErrorNotice'
import { formatBytes } from '../host/removeProject'
import type { ProjectCleanupResult } from '../../../shared/types'

export function ProjectWorktreeCleanup({ folder }: { folder: string }) {
  const api = window.orchaDesktop.storageProjectCleanup
  const [result, setResult] = useState<ProjectCleanupResult | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (!api || !activeId || !busy) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api({ folder, phase: 'status', planId: activeId })
        if (!disposed) setResult(next)
      } catch { /* The preview file appears after discovery; the main call reports errors. */ }
      if (!disposed) timer = setTimeout(poll, 1500)
    }
    timer = setTimeout(poll, 1500)
    return () => { disposed = true; clearTimeout(timer) }
  }, [api, folder, activeId, busy])
  if (!api) return null
  const start = async (phase: 'preview' | 'execute') => {
    const planId = phase === 'preview' ? crypto.randomUUID() : result?.plan_id
    if (!planId) return
    setActiveId(planId)
    setBusy(true)
    setError(null)
    if (phase === 'preview') setResult(null)
    try { setResult(await api({ folder, phase, planId })) }
    catch (e) { setError(e) }
    finally { setBusy(false) }
  }
  return <section className="mt-2 text-[12px]" aria-label="Project-wide cleanup">
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void start('preview')}>Preview project-wide cleanup</Button>
    <p>Includes worktrees outside the usual folder. Active work stays; files are saved privately, and commits and branches are kept.</p>
    {busy && <p role="status">{result ? `Checked ${result.scanned} of ${result.total} folders…` : 'Starting the preview…'}</p>}
    {error != null && <ErrorNotice error={error} prefix="Cleanup could not finish" wrap />}
    {result && <>
      <p>{result.candidate_count} eligible · {formatBytes(result.candidate_bytes)} before saving files
        {result.unknown_sizes ? ` · ${result.unknown_sizes} sizes unavailable` : ''}. Saved files still use disk space.</p>
      <ul>{result.items.map(row => <li key={row.path} title={row.path}>
        {row.name}: {row.outcome || row.state} — {row.reason}
        {row.unmerged_commits ? ` · ${row.unmerged_commits} unmerged commits kept` : ''}
        {row.output_count ? ` · ${row.output_count} files to preserve` : ''}
        {row.discarded_caches?.length ? <div>Dependency/cache folders not saved: {row.discarded_caches.join(", ")}</div> : null}
        {row.saved_to && <div>Saved at {row.saved_to}</div>}
      </li>)}</ul>
      {!busy && result.status === 'ready' && result.candidate_count > 0 &&
        <Button variant="outline" size="sm" onClick={() => void start('execute')}>Save work and remove {result.candidate_count} folders</Button>}
      {result.status === 'done' && <p role="status">Removed {result.removed.length} folders.</p>}
    </>}
  </section>
}
