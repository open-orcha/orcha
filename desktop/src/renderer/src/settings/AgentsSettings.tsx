/** Settings › Agents (modelled on Orca's Agents settings, Linear-grade styling — D2 compact
 *  buttons, D15 Inter everywhere and mono ONLY for command lines / paths).
 *
 *  - Agent Permissions: Yolo | Manual. Applies ONLY to terminals the user launches from this
 *    app (never Orcha's managed agents or the notifier).
 *  - Installed (N detected) + Refresh: CLIs main found on the login-shell PATH. Each row shows
 *    the exact command line that will run, Enabled | Disabled, Default / Set default, the
 *    vendor docs, and an expander with extra args + "Test launch".
 *  - Available to install: verified catalogue entries not detected, with the official install
 *    command (copy) and docs. */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Copy, ExternalLink, Info, Play, RefreshCw } from 'lucide-react'
import {
  AGENT_REGISTRY,
  agentDef,
  commandLine,
  parseArgsInput,
  type AgentId,
  type AgentState,
  type AgentsSnapshot,
  type PermissionMode
} from '../../../shared/agents'
import { AgentMark } from '../terminal/KindIcon'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { useAgents } from '../agents/AgentsContext'

export const YOLO_HELP =
  'Yolo launches each agent with its documented skip-permission flag (e.g. Claude Code’s --dangerously-skip-permissions), so it edits files and runs commands without asking first. Manual launches without those flags (and passes Cline’s --auto-approve false, since Cline auto-approves by default), so the agent asks before acting. Only affects terminals you open from Embodent — never Embodent’s managed agents.'

export const RESTORE_HELP =
  'Shells reopen as a new shell in the folder they were last in (running processes can’t survive a quit). Claude Code tabs resume their exact conversation (claude --resume), Codex tabs likewise (codex resume); other agents start a new conversation. Up to 20 tabs are reopened. When this is off, ⌘K › Restore last session brings them back.'

/** Small two-option segmented control (radiogroup; arrow keys move). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  testId
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange(v: T): void
  disabled?: boolean
  testId?: string
}) {
  const move = (dir: 1 | -1): void => {
    const i = options.findIndex((o) => o.value === value)
    onChange(options[(i + dir + options.length) % options.length].value)
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          move(1)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          move(-1)
        }
      }}
      className={cn('inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-bg p-[2px]', disabled && 'opacity-50')}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => !on && onChange(o.value)}
            className={cn(
              'h-[22px] rounded-[5px] px-2.5 text-[12.5px] font-medium leading-none transition-colors',
              on ? 'bg-selected text-text shadow-[var(--shadow-seg)]' : 'text-text-3 hover:text-text-2'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Inline info icon with a hover/focus bubble below it (the view is hidden while Settings is
 *  open, so a DOM bubble is safe). */
function InfoTip({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="flex h-5 w-5 items-center justify-center rounded-full text-text-3 hover:text-text"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="absolute left-1/2 top-6 z-30 w-[320px] -translate-x-1/2 rounded-lg border border-border-strong bg-raised px-3 py-2 text-[12px] font-normal leading-[18px] text-text-2 shadow-[var(--shadow-pop)]"
        >
          {text}
        </span>
      )}
    </span>
  )
}

function CountPill({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className="rounded-full border border-border-strong px-2 text-[12px] font-medium leading-5 tabular-nums text-text-2">
      {children}
    </span>
  )
}

function LogoTile({ id }: { id: AgentId }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-raised">
      <AgentMark id={id} className="h-[18px] w-[18px]" />
    </span>
  )
}

function IconButton({ label, onClick, children, testId, expanded }: { label: string; onClick(): void; children: ReactNode; testId?: string; expanded?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      data-testid={testId}
      onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
    >
      {children}
    </button>
  )
}

function ArgsEditor({ agent, onSave }: { agent: AgentState; onSave(args: string[]): void }) {
  const saved = agent.extraArgs.join(' ')
  const [text, setText] = useState(saved)
  useEffect(() => setText(saved), [saved])
  const check = parseArgsInput(text)
  const dirty = text.trim() !== saved
  const inputId = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[12px] font-medium text-text-2">
        Extra arguments
      </label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          data-testid={`args-${agent.id}`}
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder="e.g. --model opus"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && check.ok && dirty) onSave(check.args)
          }}
          aria-invalid={!check.ok}
          className={cn(
            'h-7 min-w-0 flex-1 rounded-md border bg-bg px-2 font-mono text-[12px] text-text outline-none placeholder:text-text-3 focus:border-accent',
            check.ok ? 'border-border' : 'border-danger'
          )}
        />
        <Button size="default" variant="secondary" disabled={!check.ok || !dirty} onClick={() => check.ok && onSave(check.args)}>
          Save
        </Button>
      </div>
      <p className={cn('text-[12px] leading-[18px]', check.ok ? 'text-text-3' : 'text-danger')} role={check.ok ? undefined : 'alert'}>
        {check.ok
          ? 'Space-separated; passed as separate arguments. Letters, digits and _ . / : = , @ % + - only.'
          : check.error}
      </p>
    </div>
  )
}

function InstalledRow({
  agent,
  mode,
  isDefault,
  expanded,
  onToggle,
  onTestLaunch
}: {
  agent: AgentState
  mode: PermissionMode
  isDefault: boolean
  expanded: boolean
  onToggle(): void
  onTestLaunch?: (id: AgentId) => void
}) {
  const { update, openDocs } = useAgents()
  const def = agentDef(agent.id)
  const noYolo = mode === 'yolo' && !def.yolo
  return (
    <li data-testid={`agent-row-${agent.id}`} className="border-b border-border last:border-b-0">
      <div className="flex min-h-[60px] items-center gap-3 py-2.5">
        <LogoTile id={agent.id} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium text-text">{def.label}</div>
          <div data-testid={`cmd-${agent.id}`} className="truncate font-mono text-[12px] leading-[18px] text-text-3" title={commandLine(agent.id, mode, agent.extraArgs)}>
            {commandLine(agent.id, mode, agent.extraArgs)}
          </div>
          {noYolo && <div className="truncate text-[11.5px] leading-4 text-text-3" title={def.yoloNote}>{def.yoloNote}</div>}
        </div>
        <Segmented
          label={`${def.label} enabled`}
          testId={`enabled-${agent.id}`}
          value={agent.enabled ? 'on' : 'off'}
          options={[
            { value: 'on', label: 'Enabled' },
            { value: 'off', label: 'Disabled' }
          ]}
          onChange={(v) => void update({ op: 'enabled', id: agent.id, enabled: v === 'on' })}
        />
        <div className="flex w-[104px] shrink-0 justify-center">
          {isDefault ? (
            <span data-testid={`default-${agent.id}`} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-selected px-2.5 text-[12.5px] font-medium text-text">
              <Check className="h-3.5 w-3.5" /> Default
            </span>
          ) : agent.enabled ? (
            <Button variant="ghost" data-testid={`set-default-${agent.id}`} onClick={() => void update({ op: 'default', id: agent.id })}>
              Set default
            </Button>
          ) : null}
        </div>
        <IconButton label={`${def.label} docs`} onClick={() => openDocs(agent.id)}>
          <ExternalLink className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label={expanded ? `Hide ${def.label} options` : `${def.label} options`} onClick={onToggle} expanded={expanded} testId={`expand-${agent.id}`}>
          <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
        </IconButton>
      </div>
      {expanded && (
        <div data-testid={`agent-options-${agent.id}`} className="mb-3 ml-11 flex flex-col gap-3 rounded-lg border border-border bg-bg/40 p-3">
          <ArgsEditor agent={agent} onSave={(args) => void update({ op: 'extraArgs', id: agent.id, args })} />
          <div className="flex items-center gap-3">
            {onTestLaunch && (
              <Button variant="secondary" data-testid={`test-launch-${agent.id}`} onClick={() => onTestLaunch(agent.id)}>
                <Play /> Test launch
              </Button>
            )}
            <span className="min-w-0 truncate text-[12px] text-text-3">
              Opens a terminal running <code className="font-mono text-text-2">{def.bin} --version</code>
              {agent.path && (
                <>
                  {' '}
                  · <span className="font-mono" title={agent.path}>{agent.path}</span>
                </>
              )}
            </span>
          </div>
        </div>
      )}
    </li>
  )
}

function AvailableRow({ id }: { id: AgentId }) {
  const { copyInstall, openDocs } = useAgents()
  const def = agentDef(id)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <li data-testid={`available-row-${id}`} className="flex min-h-[56px] items-center gap-3 border-b border-border py-2.5 last:border-b-0">
      <LogoTile id={id} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-text-2">{def.label}</div>
        <div className="truncate font-mono text-[12px] leading-[18px] text-text-3" title={def.install}>
          {def.install}
        </div>
      </div>
      <Button
        variant="ghost"
        data-testid={`copy-install-${id}`}
        aria-label={`Copy install command for ${def.label}`}
        onClick={() => void copyInstall(id).then(() => setCopied(true)).catch(() => {})}
      >
        {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
      </Button>
      <IconButton label={`${def.label} docs`} onClick={() => openDocs(id)}>
        <ExternalLink className="h-3.5 w-3.5" />
      </IconButton>
    </li>
  )
}

/** Installed vs available split (pure; exported for tests). Registry order, Default first. */
export function splitAgents(s: AgentsSnapshot): { installed: AgentState[]; available: AgentId[] } {
  if (s.detection !== 'ready') return { installed: [], available: [] }
  const installed = s.agents.filter((a) => a.installed)
  installed.sort((a, b) => (a.id === s.defaultAgent ? -1 : b.id === s.defaultAgent ? 1 : 0))
  const available = AGENT_REGISTRY.map((a) => a.id as AgentId).filter((id) => !s.agents.find((a) => a.id === id)?.installed)
  return { installed, available }
}

export default function AgentsSettings({ onTestLaunch }: { onTestLaunch?: (id: AgentId) => void }) {
  const { snapshot, available: bridge, refreshing, error, refresh, update } = useAgents()
  const [expanded, setExpanded] = useState<AgentId | null>(null)

  if (!bridge) {
    return <p className="text-[13px] text-text-3">Agent settings need a newer Embodent build.</p>
  }

  const detecting = !snapshot || snapshot.detection === 'pending' || (refreshing && snapshot.detection !== 'ready')
  const { installed, available } = snapshot ? splitAgents(snapshot) : { installed: [], available: [] }
  const mode = snapshot?.permissionMode ?? 'yolo'
  const restoreOn = snapshot?.restoreSessions ?? true
  const resumeOn = snapshot?.resumeAgents ?? true

  return (
    <div className="flex flex-col" data-testid="agents-settings">
      <section className="flex items-start gap-6 border-b border-border pb-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[15px] font-semibold text-text">Agent Permissions</h3>
            <InfoTip label="About agent permissions" text={YOLO_HELP} />
          </div>
          <p className="mt-1 text-[13px] leading-5 text-text-3">
            Launch agents with fewer permission prompts (Yolo) or with manual checks. Applies to terminals you open from Embodent.
          </p>
        </div>
        <Segmented
          label="Agent permissions"
          testId="permission-mode"
          value={mode}
          disabled={!snapshot}
          options={[
            { value: 'yolo', label: 'Yolo' },
            { value: 'manual', label: 'Manual' }
          ]}
          onChange={(m) => void update({ op: 'permissionMode', mode: m })}
        />
      </section>

      <section className="flex flex-col gap-4 border-b border-border py-6" data-testid="session-restore-settings">
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[15px] font-semibold text-text">Restore terminal sessions on launch</h3>
              <InfoTip label="About session restore" text={RESTORE_HELP} />
            </div>
            <p className="mt-1 text-[13px] leading-5 text-text-3">
              Reopen the tabs you had open when Embodent quit — same folders, titles, pins and colours.
            </p>
          </div>
          <Segmented
            label="Restore terminal sessions on launch"
            testId="restore-sessions"
            value={restoreOn ? 'on' : 'off'}
            disabled={!snapshot}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' }
            ]}
            onChange={(v) => void update({ op: 'restoreSessions', on: v === 'on' })}
          />
        </div>
        <div className={cn('flex items-start gap-6', !restoreOn && 'opacity-50')}>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium text-text">Agent conversations</div>
            <p className="mt-0.5 text-[13px] leading-5 text-text-3">
              Resume where each Claude or Codex tab left off, or start a new conversation in the same folder.
            </p>
          </div>
          <Segmented
            label="Agent conversations on restore"
            testId="resume-agents"
            value={resumeOn ? 'resume' : 'fresh'}
            disabled={!snapshot || !restoreOn}
            options={[
              { value: 'resume', label: 'Resume' },
              { value: 'fresh', label: 'Don’t resume' }
            ]}
            onChange={(v) => void update({ op: 'resumeAgents', on: v === 'resume' })}
          />
        </div>
      </section>

      <section className="pt-6">
        <div className="flex h-8 items-center gap-2.5">
          <h3 className="text-[15px] font-semibold text-text">Installed</h3>
          {!detecting && snapshot?.detection === 'ready' && <CountPill testId="installed-count">{installed.length} detected</CountPill>}
          <Button
            variant="ghost"
            className="ml-auto"
            data-testid="agents-refresh"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} /> Refresh
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            {error}
          </p>
        )}
        {detecting ? (
          <p data-testid="agents-detecting" className="py-6 text-[13px] text-text-3">
            Looking for agent CLIs on your login shell’s PATH…
          </p>
        ) : snapshot?.detection === 'error' ? (
          <p data-testid="agents-detect-error" className="py-6 text-[13px] text-text-3">
            Couldn’t read your login shell’s PATH. Claude and Codex stay available; try Refresh.
          </p>
        ) : installed.length === 0 ? (
          <p data-testid="agents-none" className="py-6 text-[13px] text-text-3">
            No agent CLIs found on your PATH yet. Install one below, then Refresh.
          </p>
        ) : (
          <ul className="mt-2" aria-label="Installed agents">
            {installed.map((a) => (
              <InstalledRow
                key={a.id}
                agent={a}
                mode={mode}
                isDefault={snapshot!.defaultAgent === a.id}
                expanded={expanded === a.id}
                onToggle={() => setExpanded((e) => (e === a.id ? null : a.id))}
                onTestLaunch={onTestLaunch}
              />
            ))}
          </ul>
        )}
      </section>

      {available.length > 0 && (
        <section className="pt-8">
          <div className="flex h-8 items-center gap-2.5">
            <h3 className="text-[15px] font-semibold text-text-2">Available to install</h3>
            <CountPill testId="available-count">{available.length} agents</CountPill>
          </div>
          <ul className="mt-2" aria-label="Available to install">
            {available.map((id) => (
              <AvailableRow key={id} id={id} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
