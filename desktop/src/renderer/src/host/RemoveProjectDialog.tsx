import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, Loader2, Minus } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import ErrorNotice from '../components/ErrorNotice'
import { useHostModal } from './useHostModal'
import { formatBytes, PHASE_LABEL } from './removeProject'
import type { RemoveOptions, RemovePhase, RemovePlan } from '../../../shared/types'

export interface RemoveProjectDialogProps {
  /** The project's display name (the sidebar row). */
  name: string
  /** Compose project (orcha-*). */
  project: string
  /** Short stack name — what the user types to confirm deleting data. */
  projectShort: string
  /** Other projects in the same stack (they go with it). */
  siblings?: string[]
  /** Terminal tabs still running for this project (closed when it is removed). */
  liveTerminals: number
  /** Loads the exact summary (names, sizes). */
  loadPlan?: () => Promise<RemovePlan>
  busy: boolean
  phase: RemovePhase | null
  /** The last attempt's failure, or null. The primary becomes "Try again". */
  error: unknown
  onCancel(): void
  onConfirm(opts: RemoveOptions): void
}

function Row({ icon, children, testId }: { icon: 'remove' | 'keep'; children: ReactNode; testId?: string }) {
  return (
    <li className="flex items-start gap-2" data-testid={testId}>
      {icon === 'remove' ? (
        <Minus className="mt-[3px] h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
      ) : (
        <Check className="mt-[3px] h-3.5 w-3.5 shrink-0 text-ok" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  )
}

const sized = (label: string, size: number | null | undefined): string => {
  const s = formatBytes(size ?? null)
  return s ? `${label} · ${s}` : label
}

/** "Remove project…" confirmation (Linear-style, danger tone). Default = Remove from Embodent:
 *  containers, agent sandboxes, network, portal image and background helpers go; the data and
 *  every file stay. "Also delete all project data" needs the exact project name typed;
 *  "Remove Embodent's files from the folder" is a separate opt-in. Shows progress while it
 *  runs and a plain-words error with Try again. Host dialog → the native portal view is hidden
 *  while it is open; Escape cancels (not while running); focus starts on Cancel. */
export default function RemoveProjectDialog(props: RemoveProjectDialogProps) {
  const { name, projectShort, busy, phase, error, onCancel } = props
  useHostModal(true)
  const [deleteData, setDeleteData] = useState(false)
  const [removeFiles, setRemoveFiles] = useState(false)
  const [saveOutput, setSaveOutput] = useState(true)
  const [typed, setTyped] = useState('')
  const [plan, setPlan] = useState<RemovePlan | null>(null)
  const [planError, setPlanError] = useState<unknown>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const ids = useId()

  const loadPlan = props.loadPlan
  const load = useCallback(() => {
    if (!loadPlan) return
    setPlanError(null)
    loadPlan().then(setPlan, (e: unknown) => setPlanError(e))
  }, [loadPlan])
  useEffect(() => load(), [load])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => previous?.focus?.()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const nameMatches = typed.trim() === projectShort
  const canConfirm = !busy && (!deleteData || nameMatches)
  const folder = plan?.folder ?? null
  const filesAllowed = !!plan && !!folder && plan.folderMatches
  const containerCount = (plan?.containers.length ?? 0) + (plan?.sandboxes.length ?? 0)
  // Agent worktrees, as the CLI classified them (Embodent's scaffolding never counts as a change).
  const wts = plan?.worktrees ?? []
  const outputWts = wts.filter((w) => w.state === 'has-output')
  const keptWts = wts.filter((w) => w.state === 'unmerged' || w.state === 'in-use' || w.state === 'not-quorate')
  const goingWts = wts.length - keptWts.length - (saveOutput ? 0 : outputWts.length)
  const outputFiles = outputWts.flatMap((w) => w.files ?? [])
  const dataSize = plan ? plan.volumes.reduce<number | null>((t, v) => (v.size === null ? t : (t ?? 0) + v.size), null) : null

  const primary = busy ? (phase ? PHASE_LABEL[phase] : 'Removing…') : error != null ? 'Try again' : deleteData ? 'Remove and delete data' : 'Remove project'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--scrim)] animate-fade-in" onClick={busy ? undefined : onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        aria-describedby={`${ids}-body`}
        data-testid="remove-project-dialog"
        className="mx-4 flex max-h-[calc(100vh-48px)] w-full max-w-[480px] flex-col rounded-[10px] border border-border-strong bg-raised shadow-[var(--shadow-dialog)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-h-0 overflow-y-auto p-5">
          <h2 id={`${ids}-title`} className="text-[15px] font-semibold text-text">
            Remove “{name}”?
          </h2>
          <div id={`${ids}-body`} className="mt-2 flex flex-col gap-3 text-[13px] leading-relaxed text-text-2">
            <p>
              Embodent stops this project and takes it out of the sidebar.{' '}
              {deleteData ? (
                <span className="text-text">Your code is kept; the project’s data is deleted.</span>
              ) : (
                <span className="text-text">Your code and the project’s data are kept; add the folder again to bring it back.</span>
              )}
            </p>
            {props.siblings && props.siblings.length > 0 && (
              <p>
                It shares its stack with <span className="text-text">{props.siblings.join(', ')}</span>, which {props.siblings.length === 1 ? 'is' : 'are'} removed too.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2" data-testid="remove-summary">
              <div>
                <div className="mb-1 text-[12px] font-medium text-text-3">Removed</div>
                <ul className="flex flex-col gap-1">
                  <Row icon="remove">
                    {plan
                      ? `${containerCount} container${containerCount === 1 ? '' : 's'}${plan.sandboxes.length ? ` (incl. ${plan.sandboxes.length} agent sandbox${plan.sandboxes.length === 1 ? '' : 'es'})` : ''}`
                      : 'Containers and agent sandboxes'}
                  </Row>
                  <Row icon="remove">{plan && plan.networks.length === 0 ? 'Network (already gone)' : 'Its Docker network'}</Row>
                  <Row icon="remove">
                    {plan && plan.images.length > 0
                      ? sized('Portal image', plan.images.reduce<number | null>((t, i) => (i.size === null ? t : (t ?? 0) + i.size), null))
                      : 'Portal image (rebuilt if you add it again)'}
                  </Row>
                  <Row icon="remove">Background helpers (notifier, terminal bridge)</Row>
                  {props.liveTerminals > 0 && (
                    <Row icon="remove" testId="remove-terminals">
                      {props.liveTerminals} running terminal{props.liveTerminals === 1 ? '' : 's'} in this project (closed)
                    </Row>
                  )}
                  {deleteData && (
                    <Row icon="remove" testId="remove-data-row">
                      <span className="text-danger">{sized('All project data: tasks, agents, history', dataSize)}</span>
                    </Row>
                  )}
                  {removeFiles && filesAllowed && (
                    <Row icon="remove" testId="remove-files-row">
                      Embodent’s files in the folder{goingWts > 0 ? ` and ${goingWts} agent worktree${goingWts === 1 ? '' : 's'}` : ''}
                    </Row>
                  )}
                  {removeFiles && filesAllowed && saveOutput && outputWts.length > 0 && (
                    <Row icon="keep" testId="remove-save-output-row">
                      Output of {outputWts.length} worktree{outputWts.length === 1 ? '' : 's'} saved first ({outputFiles.length} file{outputFiles.length === 1 ? '' : 's'})
                    </Row>
                  )}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-[12px] font-medium text-text-3">Kept</div>
                <ul className="flex flex-col gap-1">
                  <Row icon="keep">
                    Your code and git repo
                    {folder && (
                      <span className="block truncate text-[12px] text-text-3" title={folder}>
                        {folder}
                      </span>
                    )}
                  </Row>
                  {!deleteData && <Row icon="keep" testId="keep-data-row">{sized('Project data: tasks, agents, history', dataSize)}</Row>}
                  {!removeFiles && <Row icon="keep">Embodent’s files in the folder</Row>}
                  {removeFiles && filesAllowed && keptWts.length > 0 && (
                    <Row icon="keep" testId="keep-worktrees-row">
                      {keptWts.length} agent worktree{keptWts.length === 1 ? '' : 's'} with unmerged commits or in use
                    </Row>
                  )}
                  {removeFiles && filesAllowed && !saveOutput && outputWts.length > 0 && (
                    <Row icon="keep">{outputWts.length} agent worktree{outputWts.length === 1 ? '' : 's'} with unsaved output</Row>
                  )}
                </ul>
              </div>
            </div>
            {!plan && !planError && props.loadPlan && (
              <p className="flex items-center gap-1.5 text-[12px] text-text-3" role="status">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Measuring what this project uses…
              </p>
            )}
            {planError != null && !busy && (
              <div className="flex items-center gap-2 text-[12px]">
                <ErrorNotice error={planError} prefix="Couldn’t list the project’s resources" compact wrap className="min-w-0 flex-1" />
                <Button variant="ghost" size="sm" onClick={load}>
                  Retry
                </Button>
              </div>
            )}

            <div className="flex flex-col gap-2 rounded-md border border-border bg-bg/40 p-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-[3px] accent-[var(--color-danger)]"
                  checked={deleteData}
                  disabled={busy}
                  onChange={(e) => {
                    setDeleteData(e.target.checked)
                    setTyped('')
                  }}
                  aria-describedby={`${ids}-data-hint`}
                />
                <span>
                  <span className="font-medium text-text">Also delete all project data</span>
                  <span id={`${ids}-data-hint`} className="block text-[12px] text-text-3">
                    Every task, agent and conversation. This can’t be undone.
                  </span>
                </span>
              </label>
              {deleteData && (
                <label className="ml-6 flex flex-col gap-1.5">
                  <span>
                    Type <span className="font-mono text-[12px] text-text">{projectShort}</span> to confirm
                  </span>
                  <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={projectShort}
                    disabled={busy}
                    autoFocus
                    aria-label="Type the project name to confirm deleting its data"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
              )}
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-[3px]"
                  checked={removeFiles}
                  disabled={busy || !filesAllowed}
                  onChange={(e) => setRemoveFiles(e.target.checked)}
                  aria-describedby={`${ids}-files-hint`}
                />
                <span>
                  <span className="font-medium text-text">Remove Embodent’s files from the folder</span>
                  <span id={`${ids}-files-hint`} className="block text-[12px] text-text-3">
                    {!plan
                      ? 'Available once the folder has been checked.'
                      : !filesAllowed
                      ? 'Not available: the folder isn’t known or no longer belongs to this project.'
                      : '.orcha/, agent worktrees, Embodent’s hooks, /orcha-* commands and skills. Your code, your own .claude settings and the git repo stay.'}
                  </span>
                </span>
              </label>
              {removeFiles && filesAllowed && outputWts.length > 0 && (
                <label className="ml-6 flex items-start gap-2" data-testid="remove-save-output">
                  <input
                    type="checkbox"
                    className="mt-[3px]"
                    checked={saveOutput}
                    disabled={busy}
                    onChange={(e) => setSaveOutput(e.target.checked)}
                    aria-describedby={`${ids}-save-hint`}
                  />
                  <span>
                    <span className="font-medium text-text">Save agent output first</span>
                    <span id={`${ids}-save-hint`} className="block text-[12px] text-text-3">
                      {outputWts.length} worktree{outputWts.length === 1 ? ' has' : 's have'} files an agent made
                      {outputFiles.length ? ` (${outputFiles.slice(0, 3).join(', ')}${outputFiles.length > 3 ? `, +${outputFiles.length - 3} more` : ''})` : ''}.
                      They’re attached to their task, or kept in .orcha/saved-output. Unticked, those worktrees are kept.
                    </span>
                  </span>
                </label>
              )}
            </div>

            {busy && phase && (
              <p className="flex items-center gap-1.5 text-text" role="status" data-testid="remove-progress">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> {PHASE_LABEL[phase]}
              </p>
            )}
            {error != null && !busy && (
              <div className="rounded-md border border-border bg-bg/40 px-2.5 py-2">
                <ErrorNotice error={error} prefix="Couldn’t remove" wrap />
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canConfirm}
            onClick={() =>
              props.onConfirm({
                deleteData,
                removeFiles: removeFiles && filesAllowed,
                ...(removeFiles && filesAllowed && outputWts.length > 0 ? { saveOutput } : {})
              })
            }
          >
            {primary}
          </Button>
        </div>
      </div>
    </div>
  )
}
