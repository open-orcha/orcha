import { useEffect, useMemo, useState } from 'react'
import type { GhRepo } from '../../../../shared/types'
import { validateRepoUrl } from '../../../../shared/repoUrl'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input } from '../../ui/Input'
import { Label } from '../../ui/Label'
import { AlertCircle, Loader2, Search } from 'lucide-react'

/** "From GitHub" source: gh-authenticated repo picker (when available) + a URL field that's
 *  ALWAYS offered (public repos, or a machine with no gh CLI). Resolves to a destination via
 *  suggestCloneDest + pickCloneDest, then hands {repoUrl, dest} up — cloning itself happens
 *  in the SAME provisioning step as local-folder init (OnboardingWizard.create). */
export default function GithubSourceStep({
  onBack,
  onNext
}: {
  onBack: () => void
  onNext: (repoUrl: string, dest: string) => void
}) {
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [gitInstalled, setGitInstalled] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [repos, setRepos] = useState<GhRepo[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [query, setQuery] = useState('')
  const [url, setUrl] = useState('')
  const [dest, setDest] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.orchaDesktop.githubStatus().then((s) => {
      if (cancelled) return
      setGitInstalled(s.gitInstalled)
      setAuthenticated(s.authenticated)
      setCheckingAuth(false)
      if (s.gitInstalled && s.authenticated) {
        setLoadingRepos(true)
        void window.orchaDesktop.githubRepos().then((r) => {
          if (!cancelled) {
            setRepos(r)
            setLoadingRepos(false)
          }
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const filteredRepos = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return repos
    return repos.filter((r) => r.nameWithOwner.toLowerCase().includes(q))
  }, [repos, query])

  const validation = useMemo(() => (url.trim() ? validateRepoUrl(url) : null), [url])

  function pickRepo(nameWithOwner: string): void {
    setUrl(`https://github.com/${nameWithOwner}`)
    setDest(null)
    setError(null)
  }

  // Resolve a destination for the current URL: suggest <parent>/<repoName>, then let the
  // user confirm/override the parent via the native folder picker. pickCloneDest refuses a
  // non-empty destination itself (surfaced here as an error rather than a silent no-op).
  async function chooseDestination(): Promise<void> {
    if (!validation?.ok) return
    setResolving(true)
    setError(null)
    try {
      const suggestion = await window.orchaDesktop.suggestCloneDest(validation.url)
      const picked = await window.orchaDesktop.pickCloneDest(suggestion.repoName)
      if (picked) setDest(picked)
    } catch (err) {
      const code = (err as { code?: string }).code
      setError(code === 'DEST_NOT_EMPTY' ? 'That folder isn’t empty. Choose a different one.' : 'Couldn’t resolve a destination folder.')
    } finally {
      setResolving(false)
    }
  }

  if (!checkingAuth && !gitInstalled) {
    return (
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4 animate-slide-in">
        <div className="flex flex-col gap-1">
          <span className="onb-eyebrow">Source</span>
          <h2 className="onb-title text-2xl">Clone from GitHub</h2>
        </div>
        <Card className="flex items-start gap-2 border-danger/40 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Git isn’t installed on this Mac. Install it with <code className="font-mono">xcode-select --install</code>{' '}
            or <code className="font-mono">brew install git</code>, then come back to this step.
          </span>
        </Card>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col gap-4 animate-slide-in">
      <div className="flex flex-col gap-1">
        <span className="onb-eyebrow">Source</span>
        <h2 className="onb-title text-2xl">Clone from GitHub</h2>
      </div>

      {checkingAuth ? (
        <p className="flex items-center gap-2 text-sm text-text/60">
          <Loader2 className="h-4 w-4 animate-spin text-accent" /> Checking for git and the gh CLI…
        </p>
      ) : authenticated ? (
        <Card className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-text/40" />
            <Input
              placeholder="Search your repos…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {loadingRepos ? (
            <p className="flex items-center gap-2 text-sm text-text/60">
              <Loader2 className="h-4 w-4 animate-spin text-accent" /> Loading your repos…
            </p>
          ) : (
            <ul className="flex max-h-48 flex-col gap-1 overflow-auto">
              {filteredRepos.map((r) => {
                const selected = url === `https://github.com/${r.nameWithOwner}`
                return (
                  <li key={r.nameWithOwner}>
                    <button
                      type="button"
                      onClick={() => pickRepo(r.nameWithOwner)}
                      data-selected={selected}
                      className="onb-select-card flex w-full flex-col items-start px-2 py-1.5 text-left text-sm"
                    >
                      <span className="font-medium text-text">{r.nameWithOwner}</span>
                      {r.description && <span className="text-xs text-text/50">{r.description}</span>}
                    </button>
                  </li>
                )
              })}
              {filteredRepos.length === 0 && (
                <li className="px-2 py-1.5 text-sm text-text/50">No repos match “{query}”.</li>
              )}
            </ul>
          )}
        </Card>
      ) : (
        <p className="text-sm text-text/60">
          No authenticated gh CLI found — paste a repository URL instead.
        </p>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor="repo-url">Repository URL</Label>
        <Input
          id="repo-url"
          placeholder="https://github.com/owner/repo"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setDest(null)
          }}
        />
        {url.trim() && !validation?.ok && (
          <span className="text-xs text-danger">{validation && !validation.ok ? validation.reason : ''}</span>
        )}
      </div>

      {validation?.ok && (
        <div className="flex flex-col gap-2">
          <Button variant="outline" disabled={resolving} onClick={() => void chooseDestination()}>
            {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {dest ? 'Change destination…' : 'Choose destination…'}
          </Button>
          {dest && <div className="font-mono text-xs text-text/70">{dest}</div>}
        </div>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          data-onb-primary="true"
          disabled={!validation?.ok || !dest}
          onClick={() => validation?.ok && dest && onNext(validation.url, dest)}
        >
          Clone &amp; continue
        </Button>
      </div>
    </div>
  )
}
