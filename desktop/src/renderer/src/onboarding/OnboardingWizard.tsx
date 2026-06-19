import { useState } from 'react'
import type { BridgeError, FolderChoice } from '../../../shared/types'
import { Stepper } from '../ui/Stepper'
import { useProvisionStream } from './useProvisionStream'
import PreflightStep from './steps/PreflightStep'
import FolderStep from './steps/FolderStep'
import DetailsStep from './steps/DetailsStep'
import ProvisionStep from './steps/ProvisionStep'

const STEPS = ['Docker', 'Folder', 'Details', 'Create']

export default function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [choice, setChoice] = useState<FolderChoice | null>(null)
  const [suggestedName, setSuggestedName] = useState('')
  const [provisioning, setProvisioning] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { events } = useProvisionStream(null)

  async function create(name: string, objective: string) {
    if (!choice) return
    setStep(3)
    setProvisioning(true)
    setError(null)
    try {
      const res = await window.orchaDesktop.provision({ folder: choice.folder, mode: 'init', name, objective })
      setDone(true)
      await window.orchaDesktop.openOnboardingPortal(res.project)
      onDone()
    } catch (err) {
      const be = err as BridgeError
      setError('stderr' in be ? be.stderr : be.code)
    } finally {
      setProvisioning(false)
    }
  }

  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col gap-6 p-8 animate-fade-in">
      <h1 className="text-xl font-semibold">Set up Orcha</h1>
      <Stepper steps={STEPS} current={step} />
      <div className="flex-1">
        {step === 0 && <PreflightStep onContinue={() => setStep(1)} />}
        {step === 1 && (
          <FolderStep
            onBack={() => setStep(0)}
            onNext={(c, s) => {
              setChoice(c)
              setSuggestedName(s.suggestedName)
              setStep(2)
            }}
          />
        )}
        {step === 2 && (
          <DetailsStep suggestedName={suggestedName} onBack={() => setStep(1)} onCreate={create} />
        )}
        {step === 3 && <ProvisionStep events={events} done={done && !provisioning} error={error} />}
      </div>
    </main>
  )
}
