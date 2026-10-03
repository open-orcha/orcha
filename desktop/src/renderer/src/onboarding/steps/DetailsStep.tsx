import { useState } from 'react'
import { PenLine } from 'lucide-react'
import { Input } from '../../ui/Input'
import { ObButton, StepFooter, StepHeader, tildify } from '../ui'

const INPUT = 'h-8 rounded-[6px] bg-bg text-[13px]'

/** Name + optional objective for a NEW project. Values flow up on every keystroke so Back
 *  (and a failed provision's Back) returns to exactly what was typed. */
export default function DetailsStep({
  folder,
  initial,
  onChange,
  onBack,
  onCreate
}: {
  folder: string
  initial: { name: string; objective: string }
  onChange?: (v: { name: string; objective: string }) => void
  onBack: () => void
  onCreate: (name: string, objective: string) => void
}) {
  const [name, setName] = useState(initial.name)
  const [objective, setObjective] = useState(initial.objective)
  const update = (next: { name: string; objective: string }): void => {
    setName(next.name)
    setObjective(next.objective)
    onChange?.(next)
  }
  const nameOk = name.trim().length > 0

  return (
    <>
      <StepHeader
        icon={<PenLine className="h-4 w-4" aria-hidden="true" />}
        title="Name your project"
        subtitle={
          <>
            In <span className="font-mono text-[12.5px] text-text">{tildify(folder)}</span>
          </>
        }
      />
      <form
        className="ob-form flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (nameOk) onCreate(name.trim(), objective.trim())
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="proj-name" className="ob-label">
            Project name
          </label>
          <Input
            id="proj-name"
            className={INPUT}
            value={name}
            autoFocus
            onChange={(e) => update({ name: e.target.value, objective })}
          />
          <span className="ob-meta">Shown in the sidebar and the portal.</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="proj-obj" className="ob-label">
            Objective <span className="font-normal text-text-3">· optional</span>
          </label>
          <Input
            id="proj-obj"
            className={INPUT}
            placeholder="e.g. Ship the checkout redesign"
            value={objective}
            onChange={(e) => update({ name, objective: e.target.value })}
          />
          <span className="ob-meta">One line your agents keep in mind. You can change it later.</span>
        </div>
        <StepFooter
          left={
            <ObButton type="button" variant="ghost" onClick={onBack}>
              Back
            </ObButton>
          }
        >
          <ObButton type="submit" variant="primary" data-onb-primary="true" disabled={!nameOk}>
            Create project
          </ObButton>
        </StepFooter>
      </form>
    </>
  )
}
