import { useState } from 'react'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Label } from '../../ui/Label'

export default function DetailsStep({
  suggestedName,
  onBack,
  onCreate
}: {
  suggestedName: string
  onBack: () => void
  onCreate: (name: string, objective: string) => void
}) {
  const [name, setName] = useState(suggestedName)
  const [objective, setObjective] = useState('')
  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">Project details</h2>
      <div className="flex flex-col gap-1">
        <Label htmlFor="proj-name">Project name</Label>
        <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="proj-obj">Objective (optional)</Label>
        <Input id="proj-obj" value={objective} onChange={(e) => setObjective(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button disabled={!name.trim()} onClick={() => onCreate(name.trim(), objective.trim())}>
          Create project
        </Button>
      </div>
    </div>
  )
}
