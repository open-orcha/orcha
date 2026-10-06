import { useState } from 'react'
import { Folder, FolderOpen, FolderPlus } from 'lucide-react'
import type { FolderChoice, FolderMode, FolderState } from '../../../../shared/types'
import { Notice, ObButton, StepFooter, StepHeader, tildify } from '../ui'

/** Local folder source: pick an existing folder or create one, then show what Orcha found
 *  in it. The choice itself lives in the wizard (so Back/Forward and a failed provision never
 *  lose it); this step only picks + inspects.
 *
 *  Protections: an already-initialized folder is RECONNECTED (never re-initialized over a
 *  live project — the wizard provisions it in 'upgrade' mode and skips Details), and a folder
 *  Orcha can't write to can't be used at all. */
export default function FolderStep({
  choice,
  state,
  onPicked,
  onBack,
  onNext
}: {
  choice: FolderChoice | null
  state: FolderState | null
  onPicked: (choice: FolderChoice, state: FolderState) => void
  onBack: () => void
  onNext: (choice: FolderChoice, state: FolderState) => void
}) {
  const [inspecting, setInspecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 'existing' opens a plain folder picker; 'new-blank' opens it WITH the native
  // "New Folder" button so the user can create one on the spot.
  async function choose(mode: FolderMode): Promise<void> {
    setError(null)
    let c: FolderChoice | null
    try {
      c = await window.orchaDesktop.pickFolder(mode)
    } catch {
      setError('The folder picker couldn’t open. Try again.')
      return
    }
    if (!c) return
    setInspecting(true)
    try {
      onPicked(c, await window.orchaDesktop.inspectFolder(c.folder))
    } catch {
      setError('Embodent couldn’t read that folder. Check its permissions, or choose another one.')
    } finally {
      setInspecting(false)
    }
  }

  const name = choice ? (choice.folder.split('/').filter(Boolean).pop() ?? choice.folder) : ''
  const usable = !!choice && !!state && state.writable && !inspecting

  return (
    <>
      <StepHeader
        icon={<FolderOpen className="h-4 w-4" aria-hidden="true" />}
        title="Choose a project folder"
        subtitle="Pick the folder that holds your code, or create an empty one for a new project."
      />

      <div className="ob-picker" data-empty={!choice}>
        {!choice && (
          <span className="ob-picker-art" aria-hidden="true">
            <Folder className="h-5 w-5" />
          </span>
        )}
        {!choice && <span className="ob-meta">Your code stays where it is — Embodent adds a small config next to it.</span>}
        <div className="flex flex-wrap justify-center gap-2">
        <ObButton onClick={() => void choose('existing')} disabled={inspecting}>
          <Folder className="h-3.5 w-3.5" aria-hidden="true" />
          {choice ? 'Choose a different folder…' : 'Choose existing folder…'}
        </ObButton>
        <ObButton variant="ghost" onClick={() => void choose('new-blank')} disabled={inspecting}>
          <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
          Create new folder…
        </ObButton>
        </div>
      </div>

      {choice && (
        <div className="ob-list ob-reveal" aria-live="polite" key={choice.folder}>
          <div className="ob-row" style={{ minHeight: 52 }}>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-text-2">
              <Folder className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <span className="ob-row-main">
              <span className="ob-row-title">{name}</span>
              <span className="ob-row-sub truncate font-mono" title={choice.folder}>
                {tildify(choice.folder)}
              </span>
            </span>
            {inspecting ? (
              <span className="ob-row-aside">Inspecting…</span>
            ) : (
              state && (
                <span className="flex shrink-0 items-center gap-1.5">
                  {state.initialized && (
                    <span className="ob-chip">
                      <span className="ob-dot" style={{ color: 'var(--color-accent)' }} />
                      Orcha project
                    </span>
                  )}
                  <span className="ob-chip">
                    <span
                      className="ob-dot"
                      style={{
                        color: state.isGitRepo ? 'var(--color-ok)' : 'var(--color-text-3)'
                      }}
                    />
                    {state.isGitRepo ? 'Git repository' : 'No git yet'}
                  </span>
                </span>
              )
            )}
          </div>
        </div>
      )}

      {state && choice && !inspecting && state.initialized && state.writable && (
        <Notice title="This folder already has an Orcha project">
          Continuing reconnects to it. Its settings, agents and history are kept — nothing is overwritten.
        </Notice>
      )}
      {state && choice && !inspecting && !state.writable && (
        <Notice tone="danger" title="Embodent can’t write to this folder">
          Choose a folder you own, or change this folder’s permissions and choose it again.
        </Notice>
      )}
      {error && <Notice tone="danger" title={error} />}

      <StepFooter
        left={
          <ObButton variant="ghost" onClick={onBack}>
            Back
          </ObButton>
        }
      >
        <ObButton
          variant="primary"
          data-onb-primary="true"
          disabled={!usable}
          onClick={() => choice && state && onNext(choice, state)}
        >
          {state?.initialized ? 'Reconnect' : 'Next'}
        </ObButton>
      </StepFooter>
    </>
  )
}
