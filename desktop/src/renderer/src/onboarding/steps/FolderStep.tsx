import { useState } from 'react'
import type { FolderChoice, FolderState } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'

export default function FolderStep({
  onBack,
  onNext
}: {
  onBack: () => void
  onNext: (choice: FolderChoice, state: FolderState) => void
}) {
  const [choice, setChoice] = useState<FolderChoice | null>(null)
  const [state, setState] = useState<FolderState | null>(null)

  async function choose() {
    const c = await window.orchaDesktop.pickFolder('existing')
    if (!c) return
    setChoice(c)
    setState(await window.orchaDesktop.inspectFolder(c.folder))
  }

  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">Choose a project folder</h2>
      <Button variant="outline" onClick={() => void choose()}>
        Choose folder…
      </Button>
      {choice && (
        <Card className="text-sm">
          <div className="font-mono text-xs text-text/70">{choice.folder}</div>
          {state?.initialized && (
            <div className="mt-2 text-danger">
              This folder already has an Orcha project — it will be reconnected, not overwritten.
            </div>
          )}
        </Card>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button disabled={!choice || !state} onClick={() => choice && state && onNext(choice, state)}>
          Next
        </Button>
      </div>
    </div>
  )
}
