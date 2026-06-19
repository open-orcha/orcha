import { useEffect, useState } from 'react'
import type { InstallProgress, PreflightReport, PrereqProbe } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { AlertCircle, Check, CheckCircle2, Circle, Copy, ExternalLink, Loader2 } from 'lucide-react'

const LINKS = {
  homebrew: 'https://brew.sh',
  docker: 'https://www.docker.com/products/docker-desktop/',
  claudeCodeDocs: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codexDocs: 'https://developers.openai.com/codex/cli'
}

/** A copy-able Terminal command shown for a requirement the user installs themselves. */
type InstallCommand = { name: string; cmd: string; doc: string }

/** Tools the user must install themselves before Orcha can run agents. Orcha does NOT install
 *  these — each has its own installer / sign-in — it just checks for them and gates Continue.
 *  The one thing Orcha installs is its own CLI helper (handled separately, on Continue).
 *
 *  `url` → a single "get it" link (Homebrew, Docker). `commands` → copy-able CLI install lines
 *  shown inline (the AI coding agent), so the user installs the CLI directly instead of being
 *  sent to a marketing/download page. */
const REQUIREMENTS: {
  key: 'homebrew' | 'docker' | 'ai'
  label: string
  how?: string
  url?: string
  commands?: InstallCommand[]
}[] = [
  { key: 'homebrew', label: 'Homebrew', how: 'Get Homebrew (brew.sh)', url: LINKS.homebrew },
  {
    key: 'docker',
    label: 'Docker',
    how: 'Get Docker Desktop (or OrbStack) and start it',
    url: LINKS.docker
  },
  {
    key: 'ai',
    label: 'Claude Code or Codex (install one)',
    commands: [
      {
        name: 'Claude Code',
        cmd: 'npm install -g @anthropic-ai/claude-code',
        doc: LINKS.claudeCodeDocs
      },
      { name: 'Codex', cmd: 'npm install -g @openai/codex', doc: LINKS.codexDocs }
    ]
  }
]

/** One CLI install line: tool name, a copy-able command, and a docs link. */
function CommandLine({ name, cmd, doc }: InstallCommand): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-text/70">{name}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-text/5 px-2 py-1 font-mono text-xs text-text">
          {cmd}
        </code>
        <button
          type="button"
          title="Copy command"
          className="flex items-center gap-1 text-xs text-accent hover:underline"
          onClick={copy}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-text/50 hover:underline"
          onClick={() => void window.orchaDesktop.openExternal(doc)}
        >
          Docs <ExternalLink className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

export default function PreflightStep({ onContinue }: { onContinue: () => void }) {
  const [report, setReport] = useState<PreflightReport | null>(null)
  const [probe, setProbe] = useState<PrereqProbe | null>(null)
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [lastLine, setLastLine] = useState('')
  const [error, setError] = useState<string | null>(null)

  const check = (): void => {
    setChecking(true)
    setError(null)
    void Promise.all([window.orchaDesktop.preflight(), window.orchaDesktop.probePrereqs()]).then(
      ([r, p]) => {
        setReport(r)
        setProbe(p)
        setChecking(false)
      }
    )
  }
  useEffect(() => check(), [])

  // Live install progress (only the Orcha helper install streams here).
  useEffect(
    () =>
      window.orchaDesktop.onInstallProgress((e: InstallProgress) => {
        if (e.status === 'log') setLastLine(e.line)
      }),
    []
  )

  // Is a given requirement satisfied? Docker uses the daemon-up preflight (it also auto-starts
  // Docker); the AI agent is satisfied by EITHER Claude Code or Codex.
  const have = (key: 'homebrew' | 'docker' | 'ai'): boolean => {
    if (key === 'docker') return report?.docker === 'ok'
    if (key === 'ai') return !!probe && (probe.claude || probe.codex)
    return !!probe?.homebrew
  }
  const ready = !!probe && !!report && REQUIREMENTS.every((r) => have(r.key))

  // Continue installs the Orcha helper (the only thing we install) if it's missing, then moves
  // on. If it's already present we go straight through.
  async function continueOn(): Promise<void> {
    if (probe?.orcha) return onContinue()
    setInstalling(true)
    setError(null)
    setLastLine('')
    try {
      const res = await window.orchaDesktop.installPrereqs()
      if (!res.ok) {
        setError(`Couldn’t install the Orcha helper (${res.detail}). You can try again.`)
        return
      }
      onContinue()
    } catch {
      setError('Couldn’t install the Orcha helper. Please try again.')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">What Orcha needs</h2>
      <p className="text-sm text-text/70">
        Orcha needs these free tools on your Mac before it can run agents. Install any that aren’t
        checked off, then click Re-check. Orcha installs its own helper for you.
      </p>

      <Card className="flex flex-col gap-3 text-sm">
        {checking && !probe ? (
          <span className="flex items-center gap-2 text-text/70">
            <Loader2 className="h-4 w-4 animate-spin text-accent" /> Checking what’s installed…
          </span>
        ) : (
          REQUIREMENTS.map((r) => {
            const ok = have(r.key)
            return (
              <div key={r.key} className="flex items-start gap-2">
                {ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                ) : (
                  <Circle className="mt-0.5 h-4 w-4 shrink-0 text-text/30" />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={ok ? 'text-text' : 'text-text/70'}>{r.label}</span>
                  {!ok && r.commands && (
                    <div className="flex flex-col gap-2">
                      <span className="text-xs text-text/50">
                        Run one of these in Terminal, then click Re-check:
                      </span>
                      {r.commands.map((c) => (
                        <CommandLine key={c.name} {...c} />
                      ))}
                    </div>
                  )}
                  {!ok && r.url && (
                    <button
                      type="button"
                      className="flex w-fit items-center gap-1 text-xs text-accent hover:underline"
                      onClick={() => void window.orchaDesktop.openExternal(r.url!)}
                    >
                      {r.how} <ExternalLink className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </Card>

      {installing && (
        <p className="flex items-center gap-2 text-sm text-text/70">
          <Loader2 className="h-4 w-4 animate-spin text-accent" /> Installing the Orcha helper…
        </p>
      )}
      {installing && lastLine && (
        <p className="truncate font-mono text-xs text-text/50" title={lastLine}>
          {lastLine}
        </p>
      )}
      {error && (
        <p className="flex items-start gap-2 text-sm text-red-500">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      {!ready && !checking && report?.docker !== 'ok' && report?.hint && (
        <p className="text-sm text-text/70">{report.hint}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={checking || installing} onClick={check}>
          Re-check
        </Button>
        <Button disabled={!ready || checking || installing} onClick={() => void continueOn()}>
          {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Continue
        </Button>
      </div>
    </div>
  )
}
