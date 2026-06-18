import { useEffect, useState } from 'react'
import type { BridgeError, FolderChoice, PreflightReport, ProgressEvent } from '../../../shared/types'
import { useProvisionStream } from './useProvisionStream'

type Phase = 'preflight' | 'folder' | 'provision' | 'done'

export default function OnboardingApp() {
  const [phase, setPhase] = useState<Phase>('preflight')
  const [pf, setPf] = useState<PreflightReport | null>(null)
  const [choice, setChoice] = useState<FolderChoice | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { events } = useProvisionStream(null)

  useEffect(() => {
    void window.orchaDesktop.preflight().then(setPf)
  }, [])

  async function chooseFolder() {
    const c = await window.orchaDesktop.pickFolder('existing')
    if (!c) return
    setChoice(c)
    const state = await window.orchaDesktop.inspectFolder(c.folder)
    setName(state.suggestedName)
  }

  async function createProject() {
    if (!choice) return
    setPhase('provision')
    setError(null)
    try {
      const res = await window.orchaDesktop.provision({ folder: choice.folder, mode: 'init', name })
      setPhase('done')
      await window.orchaDesktop.openOnboardingPortal(res.project)
    } catch (err) {
      const be = err as BridgeError
      setError('stderr' in be ? be.stderr : be.code)
      setPhase('folder') // allow retry
    }
  }

  if (phase === 'preflight') {
    const ok = pf?.docker === 'ok'
    return (
      <div className="onboarding">
        <h1>Set up Orcha</h1>
        <p>Checking Docker…</p>
        {pf && !ok && <div className="banner">{pf.hint}</div>}
        {pf && !ok && (
          <button onClick={() => void window.orchaDesktop.preflight().then(setPf)}>Re-check</button>
        )}
        <button disabled={!ok} onClick={() => setPhase('folder')}>
          Continue
        </button>
      </div>
    )
  }

  if (phase === 'folder') {
    return (
      <div className="onboarding">
        <h1>Choose a project folder</h1>
        <button onClick={() => void chooseFolder()}>Choose folder…</button>
        {choice && (
          <>
            <p>{choice.folder}</p>
            <label>
              Project name
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button onClick={() => void createProject()}>Create project</button>
          </>
        )}
        {error && <div className="banner banner-error">{error}</div>}
      </div>
    )
  }

  // provision / done
  return (
    <div className="onboarding">
      <h1>{phase === 'done' ? 'Project ready' : 'Provisioning…'}</h1>
      <ul className="provision-log">
        {events.map((e: ProgressEvent, i) => (
          <li key={i} data-step={e.step} data-status={e.status}>
            {e.step} — {e.status}
            {e.status === 'log' && 'line' in e ? `: ${e.line}` : ''}
            {e.status === 'fail' && 'detail' in e ? `: ${e.detail}` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}
