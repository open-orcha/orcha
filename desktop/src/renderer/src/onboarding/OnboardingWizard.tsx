import { useEffect, useState } from 'react'
import type { BridgeError, FolderChoice, FolderState, WizardVariant } from '../../../shared/types'
import { Button } from '../ui/Button'
import { ProgressPills, type PillSegment } from './ProgressPills'
import { SkipConfirmDialog } from './SkipConfirmDialog'
import { useProvisionStream } from './useProvisionStream'
import { bindCodeSource } from './bindCodeSource'
import WelcomeStep from './steps/WelcomeStep'
import PreflightStep from './steps/PreflightStep'
import SourceStep, { type ProjectSource } from './steps/SourceStep'
import FolderStep from './steps/FolderStep'
import GithubSourceStep from './steps/GithubSourceStep'
import DetailsStep from './steps/DetailsStep'
import ProvisionStep from './steps/ProvisionStep'
import FleetStep from './steps/FleetStep'
import FinishStep from './steps/FinishStep'

const TITLES: Record<WizardVariant, string> = {
  'first-run': 'Set up Orcha',
  'add-project': 'Add a project'
}

/** Which screen is on-stage. Distinct from the pill segment (below) — a few phases share a
 *  pill position (e.g. 'source' covers both the chooser and each source's own picker) since
 *  the two sources take different-length paths to the same provision step.
 *
 *  'welcome' only appears for first-run (there's no wizard chrome to skip back to on
 *  add-project — see `PHASES_FOR`). 'fleet' and 'finish' are new post-provision phases;
 *  'fleet' silently self-skips (via FleetStep's onUnavailable) on portals that predate the
 *  roster/suggest endpoint. */
type Phase =
  | 'welcome'
  | 'preflight'
  | 'source'
  | 'folder'
  | 'github'
  | 'details'
  | 'provision'
  | 'fleet'
  | 'finish'

/** Pill segment for each phase — 'folder'/'github' both read as "Source"; provisioning
 *  always reads as "Create" whether it got there via Details or a straight-through clone.
 *  'welcome' and 'finish' aren't part of the pill row (bookend screens, not "steps"). */
const SEGMENT_FOR: Partial<Record<Phase, string>> = {
  preflight: 'setup',
  source: 'source',
  folder: 'source',
  github: 'source',
  details: 'details',
  provision: 'create',
  fleet: 'fleet'
}

const SEGMENT_LABELS: { key: string; label: string }[] = [
  { key: 'setup', label: 'Setup' },
  { key: 'source', label: 'Source' },
  { key: 'details', label: 'Details' },
  { key: 'create', label: 'Create' },
  { key: 'fleet', label: 'Fleet' }
]

/** Auto-skip walker: the ordered phase list for a variant, minus phases irrelevant to it.
 *  first-run gets the full cinematic open (Welcome); add-project drops straight into Setup
 *  since a manager window is already on screen. Both variants get Fleet/Finish — a fleet is
 *  worth suggesting whether this is the very first project or the fifth. */
function phasesFor(variant: WizardVariant): Phase[] {
  const base: Phase[] = ['preflight', 'source', 'provision', 'fleet', 'finish']
  return variant === 'first-run' ? ['welcome', ...base] : base
}

/** Drives welcome → preflight → source → (folder details | github clone) → provision →
 *  fleet → finish for BOTH first-run onboarding (zero stacks) and "Add project" from an
 *  existing manager — same step components either way, only framing (title, cancel
 *  affordance, welcome screen) differs. `variant` picks the framing; `onCancel`
 *  (add-project only) backs out to the manager without provisioning anything — safe any
 *  time, since orcha init/upgrade is re-runnable.
 *
 *  Two sources converge on the same provisioning step:
 *   - 'local': FolderStep picks/creates a folder → DetailsStep (skipped on reconnect) →
 *     provision({mode: initialized ? 'upgrade' : 'init'}).
 *   - 'github': GithubSourceStep clones a repo into a fresh destination → straight to
 *     provision({mode: 'init'}) — a repo we just cloned is never already .orcha-initialized,
 *     and it's always a git repo, so no Details step and no git-init tip either.
 *
 *  Provisioning success moves to 'fleet' (GET .../roster/suggest on the just-provisioned
 *  stack) rather than opening the portal directly; FleetStep itself skips straight to
 *  'finish' when the endpoint isn't available (older/open CLI portals). 'finish' is the
 *  terminal screen — its CTA is what actually opens the portal and calls onDone. */
export default function OnboardingWizard({
  onDone,
  variant = 'first-run',
  onCancel
}: {
  onDone: () => void
  variant?: WizardVariant
  onCancel?: () => void
}) {
  const phases = phasesFor(variant)
  const [phase, setPhase] = useState<Phase>(phases[0])
  const [source, setSource] = useState<ProjectSource | null>(null)
  const [choice, setChoice] = useState<FolderChoice | null>(null)
  const [folderState, setFolderState] = useState<FolderState | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [project, setProject] = useState<string | null>(null)
  const [apiPort, setApiPort] = useState<number | null>(null)
  const [fleetCreated, setFleetCreated] = useState(false)
  const [codeSourceBound, setCodeSourceBound] = useState(false)
  const [projectFolder, setProjectFolder] = useState<string | null>(null)
  const [confirmingSkip, setConfirmingSkip] = useState(false)
  const { events } = useProvisionStream(null)

  // Git tip: shown once provisioning succeeds, only for a folder that wasn't a git repo.
  // Only reachable via the local-folder source — a clone is always a git repo.
  const gitTip =
    source === 'local' && folderState && !folderState.isGitRepo
      ? 'Tip: `git init` in this folder unlocks the local code-source features.'
      : null

  // Enter advances the current phase's primary action, ignored while typing (inputs/
  // textareas) so it doesn't fight normal text entry. Escape opens the one shared skip
  // confirm dialog rather than silently discarding progress.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && canSkip()) {
        e.preventDefault()
        setConfirmingSkip(true)
        return
      }
      if (e.key !== 'Enter') return
      const target = e.target as HTMLElement | null
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return
      const primary = document.querySelector<HTMLButtonElement>('[data-onb-primary="true"]:not(:disabled)')
      primary?.click()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, provisioning])

  function canSkip(): boolean {
    return !!onCancel && !provisioning && phase !== 'finish'
  }

  async function openPortalAndFinish(proj: string): Promise<void> {
    await window.orchaDesktop.openOnboardingPortal(proj)
    onDone()
  }

  function finishProvision(
    res: { project: string; apiPort: number; warnings: string[] },
    showGitTip: boolean,
    isGitRepo: boolean
  ): void {
    setDone(true)
    setProject(res.project)
    setApiPort(res.apiPort)
    // Auto-bind the code source (fixes the "Code Space blank after clone/pick" bug) —
    // fire-and-forget: never gates the wizard walker, and bindCodeSource itself never
    // throws (feature-detects the endpoint, swallows any non-200). The Finish step's
    // summary line only appears once this resolves true.
    void bindCodeSource(res.apiPort, isGitRepo).then(setCodeSourceBound)
    // If something needs the user's attention (e.g. the agent worker couldn't start, or
    // this folder isn't a git repo yet), pause on a plain-language note rather than
    // silently walking them into the Fleet step.
    if (res.warnings.length > 0 || showGitTip) {
      setWarnings(res.warnings)
    } else {
      setPhase('fleet')
    }
  }

  function failProvision(err: unknown): void {
    const be = err as BridgeError
    setError('stderr' in be ? be.stderr : 'reason' in be ? be.reason : be.code)
  }

  // choice/state come in as explicit args (not read off earlier state) so the reconnect
  // path — which calls this straight out of FolderStep's onNext — always provisions
  // against the folder that was JUST picked, not a stale render's closure.
  async function create(choice: FolderChoice, state: FolderState, name: string, objective: string): Promise<void> {
    setPhase('provision')
    setProvisioning(true)
    setError(null)
    setProjectFolder(choice.folder)
    try {
      // A folder with .orcha already provisioned reconnects (mode 'upgrade': preserves
      // the existing ports/config, skips container-create + human-register) instead of
      // re-running init, which would mint a fresh project name/ports over a live stack.
      const res = await window.orchaDesktop.provision({
        folder: choice.folder,
        mode: state.initialized ? 'upgrade' : 'init',
        name,
        objective
      })
      finishProvision(res, !state.isGitRepo, state.isGitRepo)
    } catch (err) {
      failProvision(err)
    } finally {
      setProvisioning(false)
    }
  }

  // From GitHub: clone into `dest` (streams 'clone-repo' progress on the same provisioning
  // channel), then the exact same provision pipeline runs server-side on the clone.
  async function cloneAndCreate(repoUrl: string, dest: string): Promise<void> {
    setPhase('provision')
    setProvisioning(true)
    setError(null)
    setProjectFolder(dest)
    try {
      const res = await window.orchaDesktop.cloneAndProvision({ repoUrl, dest })
      // A repo we just cloned is always a git repo.
      finishProvision(res, false, true)
    } catch (err) {
      failProvision(err)
    } finally {
      setProvisioning(false)
    }
  }

  const segmentKey = SEGMENT_FOR[phase]
  const segments: PillSegment[] = segmentKey
    ? SEGMENT_LABELS.map((s) => ({
        key: s.key,
        label: s.label,
        state:
          s.key === segmentKey
            ? 'current'
            : SEGMENT_LABELS.findIndex((x) => x.key === s.key) <
                SEGMENT_LABELS.findIndex((x) => x.key === segmentKey)
              ? 'done'
              : 'upcoming'
      }))
    : []

  return (
    <main className="onb-stage flex h-full flex-col items-center overflow-y-auto p-8 animate-fade-in">
      <div className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col justify-center gap-6 py-8">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">{TITLES[variant]}</h1>
          {canSkip() && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingSkip(true)}>
              Cancel
            </Button>
          )}
        </div>
        {segments.length > 0 && (
          <div className="flex justify-center">
            <ProgressPills
              segments={segments}
              onJump={(key) => {
                // Only jump to phases already visited — 'done' segments only, mirroring
                // back-navigation. Pick the canonical phase for that segment.
                const target = (Object.entries(SEGMENT_FOR) as [Phase, string][]).find(([, v]) => v === key)?.[0]
                const seg = segments.find((s) => s.key === key)
                if (target && seg?.state === 'done') setPhase(target)
              }}
            />
          </div>
        )}
        <div className="flex flex-1 flex-col justify-center">
          {phase === 'welcome' && <WelcomeStep onContinue={() => setPhase('preflight')} />}
          {phase === 'preflight' && <PreflightStep onContinue={() => setPhase('source')} />}
          {phase === 'source' && (
            <SourceStep
              onChoose={(s) => {
                setSource(s)
                setPhase(s === 'local' ? 'folder' : 'github')
              }}
            />
          )}
          {phase === 'folder' && (
            <FolderStep
              onBack={() => setPhase('source')}
              onNext={(c, s) => {
                setChoice(c)
                setFolderState(s)
                // Reconnecting ignores name/objective (mode 'upgrade' reads the existing
                // config), so there's nothing useful to ask on the Details step — skip it.
                if (s.initialized) {
                  void create(c, s, s.suggestedName, '')
                } else {
                  setPhase('details')
                }
              }}
            />
          )}
          {phase === 'github' && (
            <GithubSourceStep
              onBack={() => setPhase('source')}
              onNext={(repoUrl, dest) => void cloneAndCreate(repoUrl, dest)}
            />
          )}
          {phase === 'details' && (
            <DetailsStep
              suggestedName={folderState?.suggestedName ?? ''}
              onBack={() => setPhase('folder')}
              onCreate={(name, objective) =>
                choice && folderState && void create(choice, folderState, name, objective)
              }
            />
          )}
          {phase === 'provision' && (
            <ProvisionStep
              events={events}
              done={done && !provisioning}
              error={error}
              warnings={warnings}
              gitTip={done && !provisioning ? gitTip : null}
              withClone={source === 'github'}
              onContinue={project ? () => setPhase('fleet') : undefined}
            />
          )}
          {phase === 'fleet' && apiPort !== null && (
            <FleetStep
              apiPort={apiPort}
              folder={projectFolder}
              onDone={() => {
                setFleetCreated(true)
                setPhase('finish')
              }}
              onUnavailable={() => setPhase('finish')}
            />
          )}
          {phase === 'finish' && project && (
            <FinishStep
              project={project}
              portalUrl={apiPort !== null ? `http://localhost:${apiPort}` : ''}
              fleetCreated={fleetCreated}
              codeSourceBound={codeSourceBound}
              onOpenPortal={() => void openPortalAndFinish(project)}
            />
          )}
        </div>
      </div>
      {confirmingSkip && (
        <SkipConfirmDialog
          onConfirm={() => {
            setConfirmingSkip(false)
            onCancel?.()
          }}
          onCancel={() => setConfirmingSkip(false)}
        />
      )}
    </main>
  )
}
