import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

/** ONE confirm dialog, reused for every way a user can bail early: the Skip affordance,
 *  Escape, or clicking off the wizard. Blur only lives on this full-screen scrim — never
 *  on content surfaces. */
export function SkipConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="onb-scrim" role="presentation" onClick={onCancel}>
      <Card
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="skip-confirm-title"
        className="onb-rise-in flex w-80 flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="skip-confirm-title" className="text-base font-semibold text-text">
          Skip setup?
        </h3>
        <p className="onb-body">It won't take long!</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Keep going
          </Button>
          <Button variant="outline" onClick={onConfirm}>
            Skip
          </Button>
        </div>
      </Card>
    </div>
  )
}
