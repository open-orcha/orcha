import { useCallback, useEffect, useRef, useState } from 'react'
import type { FolderChoice, FolderState, ProvisionResult, WizardVariant } from '../../../shared/types'
import './onboarding.css'
import { ObButton, OrchaMark } from './ui'
import { StepIndicator, type StepItem } from './StepIndicator'
import { SkipConfirmDialog } from './SkipConfirmDialog'
import { useProvisionStream } from './useProvisionStream'
import { bindCodeSource } from './bindCodeSource'
import { describeProvisionFailure, type ProvisionFailure } from './provisionError'
import { motionAllowed, useStageTransition } from './motion'
import { setupIssues, usePreflightChecks } from './usePreflightChecks'
import { SetupCheckNotice, setupReason } from './SetupCheckNotice'
import WelcomeStep from './steps/WelcomeStep'
import PreflightStep from './steps/PreflightStep'
import SourceStep, { type ProjectSource } from './steps/SourceStep'
import FolderStep from './steps/FolderStep'
import GithubSourceStep, { type GithubDraft } from './steps/GithubSourceStep'
import DetailsStep from './steps/DetailsStep'
import ProvisionStep, { type ProvisionStatus } from './steps/ProvisionStep'
import FleetStep from './steps/FleetStep'
import FinishStep from './steps/FinishStep'

const TITLES: Record<WizardVariant, string> = {
  'first-run': 'Set up Embodent',
  'add-project': 'Add a project'
}

/** Which screen is on stage. Several phases share one stepper position ('folder' and
 *  'github' both read as "Source"). 'welcome' (first-run only) and 'finish' are bookends
 *  without a stepper. */
type Phase = 'welcome' | 'preflight' | 'source' | 'folder' | 'github' | 'details' | 'provision' | 'fleet' | 'finish'

type StepKey = 'setup' | 'source' | 'details' | 'create' | 'agents'

/** Depth of each phase in the flow — decides whether a move slides forward or back. */
const ORDER: Record<Phase, number> = {
  welcome: 0,
  preflight: 1,
  source: 2,
  folder: 3,
  github: 3,
  details: 4,
  provision: 5,
  fleet: 6,
  finish: 7
}

/** The stepper per variant. Adding a project later never shows Setup: its checks run
 *  silently in the background and only surface when something is actually missing. */
const STEP_KEYS: Record<WizardVariant, StepKey[]> = {
  'first-run': ['setup', 'source', 'details', 'create', 'agents'],
  'add-project': ['source', 'details', 'create', 'agents']
}

/** How long the Create step holds its completion moment before moving on to Agents. Only
 *  when motion is allowed — reduced motion moves on at once. */
export const CELEBRATE_MS = 1200

const STEP_FOR: Partial<Record<Phase, StepKey>> = {
  preflight: 'setup',
  source: 'source',
  folder: 'source',
  github: 'source',
  details: 'details',
  provision: 'create',
  fleet: 'agents'
}

const STEP_LABELS: Record<StepKey, string> = {
  setup: 'Setup',
  source: 'Source',
  details: 'Details',
  create: 'Create',
  agents: 'Agents'
}

/** What the last provisioning attempt asked for — kept so "Try again" re-runs exactly it and
 *  "Back" returns to the step that produced it with every input still filled in. */
type Attempt =
  | {
      kind: 'local'
      choice: FolderChoice
      state: FolderState
      name: string
      objective: string
    }
  | { kind: 'github'; repoUrl: string; dest: string }

/** Drives welcome → setup → source → (folder → details | github) → create → agents → finish.
 *
 *  First run walks all of it. "Add a project" starts at Source: the Setup checks run silently
 *  in the background and only surface — as a compact notice with the fix and "Check again",
 *  or by routing to Setup with the reason when the user tries to create — if something
 *  required is missing. Back from Source there closes the wizard; it never lands on Setup.
 *
 *  Every move between steps is a direction-aware transition (see motion.ts / onboarding.css);
 *  under reduced motion it is instant.
 *
 *  Input is preserved across every back/forward move (folder choice, name, objective, repo
 *  URL and destination live here, not in the step components), and a failed provision is
 *  never a dead end: the Create step offers Try again (same request) and Back (to the step
 *  that produced it). Finish opens the created project on its next useful screen. */
export default function OnboardingWizard({
  onDone,
  variant = 'first-run',
  onCancel,
  onOpenApiKeys
}: {
  onDone: () => void
  variant?: WizardVariant
  onCancel?: () => void
  /** Opens Settings › API keys over the wizard (Setup's "Use an API key instead"). */
  onOpenApiKeys?: () => void
}) {
  const [phase, setPhaseState] = useState<Phase>(variant === 'first-run' ? 'welcome' : 'source')
  const phaseRef = useRef(phase)
  const transition = useStageTransition()
  const celebrateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setPhase = useCallback(
    (next: Phase): void => {
      if (celebrateTimer.current) {
        clearTimeout(celebrateTimer.current)
        celebrateTimer.current = null
      }
      const from = phaseRef.current
      if (next === from) return
      phaseRef.current = next
      transition(ORDER[next] >= ORDER[from] ? 'forward' : 'back', () => setPhaseState(next))
    },
    [transition]
  )
  useEffect(
    () => () => {
      if (celebrateTimer.current) clearTimeout(celebrateTimer.current)
    },
    []
  )
  // Add a project: the Setup checks, silently. First run shows them as a step instead.
  const background = usePreflightChecks(variant === 'add-project')
  const issues = variant === 'add-project' ? setupIssues(background) : []
  /** Add a project routed to Setup: why, and where to return afterwards. */
  const [detour, setDetour] = useState<{ reason: string | null; from: Phase } | null>(null)
  const [source, setSource] = useState<ProjectSource | null>(null)
  const [choice, setChoice] = useState<FolderChoice | null>(null)
  const [folderState, setFolderState] = useState<FolderState | null>(null)
  const [details, setDetails] = useState<{
    name: string
    objective: string
  } | null>(null)
  const [github, setGithub] = useState<GithubDraft>({ url: '', dest: null })
  const [status, setStatus] = useState<ProvisionStatus>('idle')
  const [failure, setFailure] = useState<ProvisionFailure | null>(null)
  const [result, setResult] = useState<ProvisionResult | null>(null)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [createdAgents, setCreatedAgents] = useState<string[]>([])
  const [codeSourceBound, setCodeSourceBound] = useState(false)
  const [confirmingSkip, setConfirmingSkip] = useState(false)
  const [opening, setOpening] = useState(false)
  const { events, begin } = useProvisionStream()
  const scrollRef = useRef<HTMLDivElement>(null)

  const running = status === 'running'
  const canSkip = !!onCancel && !running && phase !== 'finish'

  // Each step starts at the top of the panel.
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 })
  }, [phase])

  // Enter triggers the step's single primary (ignored while typing); Escape asks before
  // abandoning an add-project flow, and closes that question again.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (confirmingSkip) {
          e.preventDefault()
          setConfirmingSkip(false)
        } else if (canSkip) {
          e.preventDefault()
          setConfirmingSkip(true)
        }
        return
      }
      if (e.key !== 'Enter' || confirmingSkip) return
      const target = e.target as HTMLElement | null
      if (target && /^(input|textarea|select|button)$/i.test(target.tagName)) return
      document.querySelector<HTMLButtonElement>('[data-onb-primary="true"]:not(:disabled)')?.click()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canSkip, confirmingSkip])

  const gitTip =
    attempt?.kind === 'local' && !attempt.state.isGitRepo
      ? 'This folder isn’t a git repository yet. Run `git init` in it to unlock the local code features.'
      : null

  function openSetup(from: Phase): void {
    setDetour({ reason: setupReason(issues), from })
    setPhase('preflight')
  }

  function leaveSetup(): void {
    const back = detour?.from ?? 'source'
    setDetour(null)
    background.check()
    setPhase(back)
  }

  async function runAttempt(a: Attempt, retry = false): Promise<void> {
    // Add a project: never start a create the background check already knows will fail —
    // route to Setup with the reason instead (nothing entered is lost).
    if (variant === 'add-project' && !retry && issues.length > 0) {
      openSetup(phaseRef.current)
      return
    }
    setAttempt(a)
    setPhase('provision')
    setStatus('running')
    setFailure(null)
    setResult(null)
    begin()
    try {
      let res: ProvisionResult
      if (a.kind === 'local') {
        // A folder that already holds an Orcha project reconnects (mode 'upgrade': keeps its
        // ports/config, never re-creates the container) instead of re-initializing over it.
        res = await window.orchaDesktop.provision({
          folder: a.choice.folder,
          mode: a.state.initialized ? 'upgrade' : 'init',
          name: a.name,
          objective: a.objective
        })
      } else if (retry && (await folderHasContent(a.dest))) {
        // Retrying after the clone itself succeeded: the destination now holds the repo, so
        // re-cloning would be refused. Provision the existing clone instead.
        res = await window.orchaDesktop.provision({
          folder: a.dest,
          mode: 'init'
        })
      } else {
        res = await window.orchaDesktop.cloneAndProvision({
          repoUrl: a.repoUrl,
          dest: a.dest
        })
      }
      setResult(res)
      setStatus('done')
      const isGitRepo = a.kind === 'github' || a.state.isGitRepo
      // Fire-and-forget: never gates the wizard; resolves false on older portals.
      void bindCodeSource(res.apiPort, isGitRepo).then(setCodeSourceBound)
      // Pause on warnings / the git tip so they're actually read; otherwise move on.
      const pause = res.warnings.length > 0 || (a.kind === 'local' && !a.state.isGitRepo)
      if (!pause) {
        // Hold the completion moment briefly (motion only), then on to Agents.
        if (motionAllowed()) {
          celebrateTimer.current = setTimeout(() => {
            celebrateTimer.current = null
            if (phaseRef.current === 'provision') setPhase('fleet')
          }, CELEBRATE_MS)
        } else setPhase('fleet')
      }
    } catch (err) {
      setFailure(describeProvisionFailure(err))
      setStatus('failed')
    }
  }

  /** True when a clone destination already has files (i.e. the clone step completed). */
  async function folderHasContent(dest: string): Promise<boolean> {
    const cloned = events.some((e) => e.step === 'clone-repo' && e.status === 'ok')
    if (cloned) return true
    try {
      const s = await window.orchaDesktop.inspectFolder(dest)
      return s.isGitRepo
    } catch {
      return false
    }
  }

  function backFromFailure(): void {
    setStatus('idle')
    setFailure(null)
    if (attempt?.kind === 'github') setPhase('github')
    else if (attempt?.kind === 'local' && !attempt.state.initialized) setPhase('details')
    else setPhase('folder')
  }

  async function openProject(project: string, path: string): Promise<void> {
    setOpening(true)
    try {
      await window.orchaDesktop.portalShow(project, path)
    } catch {
      // Older main process / stack not listed yet — fall back to the default landing.
      await window.orchaDesktop.openOnboardingPortal(project).catch(() => undefined)
    }
    onDone()
  }

  // ---- stepper ----------------------------------------------------------------------
  const skipDetails = source === 'github' || !!folderState?.initialized
  // The stepper always shows the same five steps so the count never shifts mid-flow; a step
  // that doesn't apply to this path (Details for GitHub or an existing Orcha folder) is
  // rendered as skipped rather than removed.
  const stepKeys = STEP_KEYS[variant]
  const mapped = STEP_FOR[phase]
  // Add a project's detour to Setup isn't one of its steps: no stepper there.
  const currentKey = mapped && stepKeys.includes(mapped) ? mapped : undefined
  const currentIdx = currentKey ? stepKeys.indexOf(currentKey) : -1
  const steps: StepItem[] = stepKeys.map((key, i) => ({
    key,
    label: STEP_LABELS[key],
    state:
      key === 'details' && skipDetails
        ? 'skipped'
        : i < currentIdx
          ? 'done'
          : i === currentIdx
            ? 'current'
            : 'upcoming'
  }))
  // Jumping back is only meaningful before anything has been created.
  const canJump = ['preflight', 'source', 'folder', 'github', 'details'].includes(phase)
  function jump(key: string): void {
    if (key === 'setup' && variant === 'first-run') setPhase('preflight')
    else if (key === 'source') setPhase(source === 'github' ? 'github' : source === 'local' ? 'folder' : 'source')
    else if (key === 'details') setPhase('details')
  }

  const projectLabel =
    result?.project.replace(/^orcha-/, '') ??
    (attempt?.kind === 'local'
      ? attempt.name || attempt.state.suggestedName
      : attempt?.kind === 'github'
        ? (attempt.dest.split('/').filter(Boolean).pop() ?? 'your project')
        : 'your project')

  // Only before anything is created, and only when the background check found a problem.
  const setupNotice =
    issues.length > 0 && ['source', 'folder', 'github', 'details'].includes(phase) ? (
      <SetupCheckNotice
        issues={issues}
        checking={background.checking}
        onRecheck={background.check}
        onOpenSetup={() => openSetup(phase)}
      />
    ) : null

  return (
    <div className="ob-window">
      <main className="ob-panel" aria-label={TITLES[variant]}>
        <div className="ob-panel-head">
          <div className="ob-panel-title">
            <OrchaMark size={18} />
            <span className="truncate">{TITLES[variant]}</span>
          </div>
          {canSkip && (
            <ObButton variant="ghost" onClick={() => setConfirmingSkip(true)}>
              Cancel
            </ObButton>
          )}
        </div>
        <div className="ob-scroll" ref={scrollRef}>
          <div className="ob-col">
            {currentKey && (
              <div className="ob-stepper-row">
                <StepIndicator steps={steps} onJump={canJump ? jump : undefined} />
              </div>
            )}
            <div key={phase} className="ob-stage flex flex-col gap-6" data-phase={phase}>
              {setupNotice && phase !== 'source' && setupNotice}
              {phase === 'welcome' && <WelcomeStep onContinue={() => setPhase('preflight')} />}
              {phase === 'preflight' &&
                (variant === 'add-project' ? (
                  <PreflightStep reason={detour?.reason} onBack={leaveSetup} onContinue={leaveSetup} onUseApiKey={onOpenApiKeys} />
                ) : (
                  <PreflightStep onContinue={() => setPhase('source')} onUseApiKey={onOpenApiKeys} />
                ))}
              {phase === 'source' && (
                <SourceStep
                  selected={source}
                  notice={setupNotice}
                  onBack={variant === 'first-run' ? () => setPhase('preflight') : onCancel}
                  onChoose={(s) => {
                    setSource(s)
                    setPhase(s === 'local' ? 'folder' : 'github')
                  }}
                />
              )}
              {phase === 'folder' && (
                <FolderStep
                  choice={choice}
                  state={folderState}
                  onPicked={(c, s) => {
                    if (c.folder !== choice?.folder) setDetails(null)
                    setChoice(c)
                    setFolderState(s)
                  }}
                  onBack={() => setPhase('source')}
                  onNext={(c, s) => {
                    // Reconnecting reads the existing config — there's nothing to ask on
                    // Details, so go straight to Create.
                    if (s.initialized)
                      void runAttempt({
                        kind: 'local',
                        choice: c,
                        state: s,
                        name: s.suggestedName,
                        objective: ''
                      })
                    else setPhase('details')
                  }}
                />
              )}
              {phase === 'github' && (
                <GithubSourceStep
                  draft={github}
                  onDraftChange={setGithub}
                  onBack={() => setPhase('source')}
                  onNext={(repoUrl, dest) => void runAttempt({ kind: 'github', repoUrl, dest })}
                />
              )}
              {phase === 'details' && choice && folderState && (
                <DetailsStep
                  folder={choice.folder}
                  initial={
                    details ?? {
                      name: folderState.suggestedName,
                      objective: ''
                    }
                  }
                  onChange={setDetails}
                  onBack={() => setPhase('folder')}
                  onCreate={(name, objective) =>
                    void runAttempt({
                      kind: 'local',
                      choice,
                      state: folderState,
                      name,
                      objective
                    })
                  }
                />
              )}
              {phase === 'provision' && (
                <ProvisionStep
                  projectName={projectLabel}
                  events={events}
                  status={status}
                  failure={failure}
                  warnings={result?.warnings ?? []}
                  gitTip={status === 'done' ? gitTip : null}
                  withClone={attempt?.kind === 'github'}
                  mode={attempt?.kind === 'local' && attempt.state.initialized ? 'upgrade' : 'init'}
                  onContinue={() => setPhase('fleet')}
                  onRetry={() => attempt && void runAttempt(attempt, true)}
                  onBack={backFromFailure}
                />
              )}
              {phase === 'fleet' && result && (
                <FleetStep
                  apiPort={result.apiPort}
                  folder={
                    attempt?.kind === 'local' ? attempt.choice.folder : attempt?.kind === 'github' ? attempt.dest : null
                  }
                  onDone={(created) => {
                    setCreatedAgents(created)
                    setPhase('finish')
                  }}
                  onUnavailable={() => setPhase('finish')}
                />
              )}
              {phase === 'finish' && result && (
                <FinishStep
                  project={result.project}
                  folder={
                    attempt?.kind === 'local' ? attempt.choice.folder : attempt?.kind === 'github' ? attempt.dest : null
                  }
                  portalUrl={`http://localhost:${result.apiPort}`}
                  agents={createdAgents}
                  codeSourceBound={codeSourceBound}
                  opening={opening}
                  onOpen={(path) => void openProject(result.project, path)}
                />
              )}
            </div>
          </div>
        </div>
      </main>
      {confirmingSkip && (
        <SkipConfirmDialog
          variant={variant}
          projectCreated={result !== null}
          onConfirm={() => {
            setConfirmingSkip(false)
            onCancel?.()
          }}
          onCancel={() => setConfirmingSkip(false)}
        />
      )}
    </div>
  )
}
