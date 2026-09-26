import { useState } from 'react'
import { MoreHorizontal, Trash2 } from 'lucide-react'
import type { Stack } from '../../../shared/types'
import useStackActions from '../components/useStackActions'
import ConfirmResetModal from '../components/ConfirmResetModal'
import { Button } from '../ui/Button'

/** A stopped stack can't list its containers (nothing to fetch a card from — the portal
 *  isn't up), so it renders as one muted row instead of a project card: honest state rather
 *  than a fake/empty card. Start brings the portal up; the overflow menu carries Remove
 *  (Delete & reset) — no loud button row on a stopped stack. */
export default function StoppedStackRow({ stack, onChanged }: { stack: Stack; onChanged: () => void }) {
  const { busy, error, toggleLabel, toggleStack, resetStack } = useStackActions(stack, onChanged)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)

  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-border/60 px-4 py-2.5 text-sm text-text/50"
      data-testid="stopped-stack-row"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text/25" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{stack.projectShort}</span>
      <span className="shrink-0 text-xs text-text/35">not running</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={toggleStack}>
        {toggleLabel}
      </Button>
      <div className="relative shrink-0">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`More actions for ${stack.projectShort}`}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-10 mt-1 w-40 rounded-lg border border-border bg-card p-1 shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-danger hover:bg-danger/10"
              onClick={() => {
                setMenuOpen(false)
                setConfirming(true)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove…
            </button>
          </div>
        )}
      </div>
      {error && !confirming && <span className="shrink-0 text-xs text-danger">{error}</span>}
      {confirming && (
        <ConfirmResetModal
          project={stack.project}
          busy={busy}
          error={error}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            void resetStack().then((ok) => {
              if (ok) setConfirming(false)
            })
          }}
        />
      )}
    </div>
  )
}
