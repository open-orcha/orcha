import { useEffect, useState } from 'react'
import type { InstallProgress } from '../../../../shared/types'
import { Check, Copy, ExternalLink, Laptop, RotateCw } from 'lucide-react'
import { InlineText, Notice, ObButton, StatusGlyph, StepFooter, StepHeader, type GlyphState } from '../ui'
import { usePreflightChecks } from '../usePreflightChecks'

/** User-facing name for the `orcha` CLI the desktop installs (internally still `orcha`). */
export const HELPER_LABEL = 'Embodent command-line helper'

const LINKS = {
  homebrew: 'https://brew.sh',
  docker: 'https://www.docker.com/products/docker-desktop/',
  claudeCodeDocs: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codexDocs: 'https://developers.openai.com/codex/cli'
}

const AI_COMMANDS = [
  {
    name: 'Claude Code',
    cmd: 'npm install -g @anthropic-ai/claude-code',
    doc: LINKS.claudeCodeDocs
  },
  { name: 'Codex', cmd: 'npm install -g @openai/codex', doc: LINKS.codexDocs }
]

const UNRESPONSIVE_HINT =
  'Docker isn’t responding. Quit and reopen Docker Desktop (or choose Restart from its menu), then re-check.'

/** One CLI install line: a copy-able command and a docs link. */
function CommandLine({ name, cmd, doc }: { name: string; cmd: string; doc: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="flex items-center gap-2">
      <span className="w-[84px] shrink-0 text-xs text-text-3">{name}</span>
      <code className="ob-code min-w-0 flex-1 truncate py-1" title={cmd}>
        {cmd}
      </code>
      <button type="button" className="ob-link" aria-label={`Copy the ${name} install command`} onClick={copy}>
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        type="button"
        className="ob-disclosure"
        aria-label={`${name} docs`}
        onClick={() => void window.orchaDesktop.openExternal(doc)}
      >
        Docs <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  )
}

function ExternalAction({ label, url }: { label: string; url: string }) {
  return (
    <button type="button" className="ob-link" onClick={() => void window.orchaDesktop.openExternal(url)}>
      {label} <ExternalLink className="h-3 w-3" />
    </button>
  )
}

interface Row {
  key: string
  label: string
  glyph: GlyphState
  aside: string
  action?: React.ReactNode
  extra?: React.ReactNode
}

/** Setup: checks what Embodent needs on this Mac (Docker running, Homebrew, an AI coding CLI,
 *  and the Embodent command-line helper — the `orcha` CLI, the one thing Embodent installs
 *  itself, on Continue). Every row says its real state and offers the action that fits THAT
 *  state. The check logic lives in usePreflightChecks (shared with Add a project's silent
 *  background check).
 *
 *  `reason` is set when Add a project routed here because its background check found a
 *  problem: it is said first, and `onBack` returns to where the user was. */
export default function PreflightStep({
  onContinue,
  onBack,
  reason
}: {
  onContinue: () => void
  onBack?: () => void
  reason?: string | null
}) {
  const checks = usePreflightChecks()
  const { report, probe, checking, probeLoading, slow, stuck, waitedS, checkError, dockerOk, aiOk, brewOk, ready } =
    checks
  const [installing, setInstalling] = useState(false)
  const [lastLine, setLastLine] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)

  const check = (): void => {
    setInstallError(null)
    checks.check()
  }

  useEffect(
    () =>
      window.orchaDesktop.onInstallProgress((e: InstallProgress) => {
        if (e.status === 'log') setLastLine(e.line)
      }),
    []
  )

  async function continueOn(): Promise<void> {
    if (probe?.orcha) return onContinue()
    setInstalling(true)
    setInstallError(null)
    setLastLine('')
    try {
      const res = await window.orchaDesktop.installPrereqs()
      if (!res.ok) {
        setInstallError(`The ${HELPER_LABEL} didn’t install: ${res.detail}`)
        return
      }
      onContinue()
    } catch {
      setInstallError(`The ${HELPER_LABEL} didn’t install. Check your connection and try again.`)
    } finally {
      setInstalling(false)
    }
  }

  const pending = checks.pending
  const dockerPending = !report
  const probePending = probeLoading || !probe
  const pendingRow = (key: string, label: string, aside = 'Checking…'): Row => ({ key, label, glyph: 'running', aside })

  const dockerRow: Row = dockerPending
    ? stuck
      ? {
          key: 'docker',
          label: 'Docker',
          glyph: 'warning',
          aside: `Not responding · ${waitedS}s`,
          extra: (
            <span className="ob-row-sub" data-testid="docker-stuck">
              Docker hasn’t answered yet. If Docker Desktop looks frozen, quit it from the menu bar and open it
              again, or Re-check. Embodent keeps waiting and updates this row by itself once Docker answers.
            </span>
          )
        }
      : pendingRow('docker', 'Docker', slow ? 'Waiting for Docker…' : 'Checking…')
    : report?.docker === 'ok'
      ? {
          key: 'docker',
          label: 'Docker',
          glyph: 'done',
          aside: report.autoStarted ? 'Started' : 'Running'
        }
      : report?.docker === 'not-installed'
        ? {
            key: 'docker',
            label: 'Docker',
            glyph: 'todo',
            aside: 'Not installed',
            action: <ExternalAction label="Get Docker" url={LINKS.docker} />,
            extra: (
              <span className="ob-row-sub">
                Docker Desktop, OrbStack or Colima all work. Install one, start it, then re-check.
              </span>
            )
          }
        : report?.unresponsive
          ? {
              // Docker is installed but its CLI stopped answering: starting it again won't
              // help, so there's no "Start Docker" link here — only the restart advice.
              key: 'docker',
              label: 'Docker',
              glyph: 'warning',
              aside: 'Not responding',
              extra: (
                <span className="ob-row-sub" data-testid="docker-unresponsive">
                  <InlineText text={report.hint ?? UNRESPONSIVE_HINT} />
                </span>
              )
            }
          : {
            key: 'docker',
            label: 'Docker',
            glyph: 'warning',
            aside: report?.docker === 'app-translocated' ? 'Can’t start' : 'Not running',
            action: (
              <button type="button" className="ob-link" onClick={check} disabled={checking}>
                <RotateCw className="h-3 w-3" /> Start Docker
              </button>
            ),
            extra: report?.hint ? (
              <span className="ob-row-sub">
                <InlineText text={report.hint} />
              </span>
            ) : undefined
          }

  const brewRow: Row = probePending
    ? pendingRow('homebrew', 'Homebrew')
    : brewOk
      ? {
          key: 'homebrew',
          label: 'Homebrew',
          glyph: 'done',
          aside: 'Installed'
        }
      : {
          key: 'homebrew',
          label: 'Homebrew',
          glyph: 'todo',
          aside: 'Not found',
          action: <ExternalAction label="Get Homebrew" url={LINKS.homebrew} />
        }

  const aiRow: Row = probePending
    ? pendingRow('ai', 'AI coding agent')
    : aiOk
      ? {
          key: 'ai',
          label: 'AI coding agent',
          glyph: 'done',
          aside: probe!.claude && probe!.codex ? 'Claude Code, Codex' : probe!.claude ? 'Claude Code' : 'Codex'
        }
      : {
          key: 'ai',
          label: 'AI coding agent',
          glyph: 'todo',
          aside: 'Not found',
          extra: (
            <>
              <span className="ob-row-sub">Install Claude Code or Codex in Terminal, then re-check:</span>
              {AI_COMMANDS.map((c) => (
                <CommandLine key={c.name} {...c} />
              ))}
            </>
          )
        }

  const helperRow: Row = probePending
    ? pendingRow('orcha', HELPER_LABEL)
    : installing
      ? {
          key: 'orcha',
          label: HELPER_LABEL,
          glyph: 'running',
          aside: 'Installing…',
          extra: lastLine ? (
            <span className="truncate font-mono text-[11.5px] text-text-3" title={lastLine}>
              {lastLine}
            </span>
          ) : undefined
        }
      : probe?.orcha
        ? {
            key: 'orcha',
            label: HELPER_LABEL,
            glyph: 'done',
            aside: 'Installed'
          }
        : {
            key: 'orcha',
            label: HELPER_LABEL,
            glyph: installError ? 'failed' : 'todo',
            aside: installError ? 'Didn’t install' : 'Installs when you continue'
          }

  const rows = [dockerRow, brewRow, aiRow, helperRow]
  const doneCount = rows.filter((r) => r.glyph === 'done').length

  return (
    <>
      <StepHeader
        icon={<Laptop className="h-4 w-4" aria-hidden="true" />}
        title="Check your Mac"
        subtitle="Embodent runs your agents with a few free tools. Anything missing is listed with how to get it."
      />

      {reason && (
        <Notice tone="warning" title="Embodent needs something on this Mac first">
          {reason}
        </Notice>
      )}

      {checkError ? (
        <Notice tone="danger" title="Couldn’t check this Mac" action={<ObButton onClick={check}>Re-check</ObButton>}>
          The check didn’t finish. If Docker is starting or busy, wait a moment and re-check.
        </Notice>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="ob-section-label">Requirements</span>
            <span className="ob-meta tabular-nums" aria-live="polite">
              {pending && doneCount === 0 ? 'Checking…' : `${doneCount} of ${rows.length} ready`}
            </span>
          </div>
          <div className="ob-meter" aria-hidden="true">
            <span className="ob-meter-fill" style={{ transform: `scaleX(${doneCount / rows.length})` }} />
          </div>
          <div className="ob-list ob-check-list" aria-busy={pending}>
            {rows.map((r, i) => (
              <div
                key={r.key}
                className="ob-check flex flex-col"
                data-row={r.key}
                data-glyph-state={r.glyph}
                style={{ '--i': i } as React.CSSProperties}
              >
                <div className="ob-row">
                  <span className="ob-check-glyph">
                    <StatusGlyph key={r.glyph} state={r.glyph} />
                  </span>
                  <span className="ob-row-title flex-1">{r.label}</span>
                  {r.action}
                  <span className="ob-row-aside">{r.aside}</span>
                </div>
                {r.extra && <div className="ob-row-extra ob-reveal">{r.extra}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {installError && <Notice tone="danger" title={installError} />}

      <StepFooter
        left={
          <>
            {onBack && (
              <ObButton variant="ghost" disabled={installing} onClick={onBack}>
                Back
              </ObButton>
            )}
            <ObButton variant="ghost" disabled={(checking && !slow) || installing} onClick={check}>
              Re-check
            </ObButton>
          </>
        }
        hint={
          pending || ready || checkError
            ? undefined
            : brewOk && aiOk && report?.unresponsive
              ? 'Restart Docker, then re-check'
              : brewOk && aiOk && report?.docker !== 'not-installed'
                ? 'Start Docker, then re-check'
              : 'Install what’s missing, then re-check'
        }
      >
        <ObButton
          variant="primary"
          data-onb-primary="true"
          disabled={!ready || checking || installing}
          onClick={() => void continueOn()}
        >
          {installing ? 'Installing…' : installError ? 'Try again' : 'Continue'}
        </ObButton>
      </StepFooter>
    </>
  )
}
