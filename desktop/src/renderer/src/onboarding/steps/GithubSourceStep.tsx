import { useEffect, useMemo, useState } from 'react'
import { Check, FolderGit2, GitBranch, Search } from 'lucide-react'
import type { GhRepo } from '../../../../shared/types'
import { validateRepoUrl } from '../../../../shared/repoUrl'
import { Input } from '../../ui/Input'
import { InlineText, Notice, ObButton, StatusGlyph, StepFooter, StepHeader, tildify } from '../ui'

const INPUT = 'h-8 rounded-[6px] bg-bg text-[13px]'

/** The GitHub source's inputs, owned by the wizard so they survive Back and a failed clone. */
export interface GithubDraft {
  url: string
  /** Absolute clone destination (prefilled from suggestCloneDest, or picked). */
  dest: string | null
}

function joinDest(parent: string, repoName: string): string {
  return `${parent.replace(/\/+$/, '')}/${repoName}`
}

/** "From GitHub": pick one of your repos (when the gh CLI is signed in) or paste a URL.
 *  The destination is prefilled from suggestCloneDest — Clone is ready as soon as a repo
 *  is chosen — with a small Change… that opens the folder picker. The clone itself runs in
 *  the Create step, on the same progress UI as local provisioning. */
export default function GithubSourceStep({
  draft,
  onDraftChange,
  onBack,
  onNext
}: {
  draft: GithubDraft
  onDraftChange: (d: GithubDraft) => void
  onBack: () => void
  onNext: (repoUrl: string, dest: string) => void
}) {
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [gitInstalled, setGitInstalled] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [repos, setRepos] = useState<GhRepo[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [query, setQuery] = useState('')
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { url, dest } = draft

  useEffect(() => {
    let cancelled = false
    window.orchaDesktop
      .githubStatus()
      .then((s) => {
        if (cancelled) return
        setGitInstalled(s.gitInstalled)
        setAuthenticated(s.authenticated)
        if (s.gitInstalled && s.authenticated) {
          setLoadingRepos(true)
          window.orchaDesktop
            .githubRepos()
            .then((r) => !cancelled && setRepos(r))
            .catch(() => !cancelled && setRepos([]))
            .finally(() => !cancelled && setLoadingRepos(false))
        }
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setCheckingAuth(false))
    return () => {
      cancelled = true
    }
  }, [])

  const filteredRepos = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? repos.filter((r) => r.nameWithOwner.toLowerCase().includes(q)) : repos
  }, [repos, query])

  const validation = useMemo(() => (url.trim() ? validateRepoUrl(url) : null), [url])
  const validUrl = validation?.ok ? validation.url : null

  // Prefill the destination whenever a valid URL has none yet.
  useEffect(() => {
    if (!validUrl || dest) return
    let cancelled = false
    window.orchaDesktop
      .suggestCloneDest(validUrl)
      .then((s) => {
        if (!cancelled) onDraftChange({ url, dest: joinDest(s.parent, s.repoName) })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validUrl, dest])

  function setUrl(next: string): void {
    setError(null)
    onDraftChange({ url: next, dest: null })
  }

  async function changeDestination(): Promise<void> {
    if (!validUrl) return
    setPicking(true)
    setError(null)
    try {
      const suggestion = await window.orchaDesktop.suggestCloneDest(validUrl)
      const picked = await window.orchaDesktop.pickCloneDest(suggestion.repoName)
      if (picked) onDraftChange({ url, dest: picked })
    } catch (err) {
      const code = (err as { code?: string })?.code
      setError(
        code === 'DEST_NOT_EMPTY'
          ? 'That folder isn’t empty. Choose an empty folder for the clone.'
          : 'Couldn’t use that folder. Choose another one.'
      )
    } finally {
      setPicking(false)
    }
  }

  const back = (
    <ObButton variant="ghost" onClick={onBack}>
      Back
    </ObButton>
  )

  if (!checkingAuth && !gitInstalled) {
    return (
      <>
        <StepHeader icon={<GitBranch className="h-4 w-4" aria-hidden="true" />} title="Clone from GitHub" />
        <Notice tone="warning" title="Git isn’t installed on this Mac">
          <InlineText text="Install it with `xcode-select --install` or `brew install git`, then come back to this step." />
        </Notice>
        <StepFooter left={back} />
      </>
    )
  }

  return (
    <>
      <StepHeader
        icon={<GitBranch className="h-4 w-4" aria-hidden="true" />}
        title="Clone from GitHub"
        subtitle="Embodent clones the repository to this Mac and sets it up there." />

      {checkingAuth ? (
        <div className="flex items-center gap-2 text-[13px] text-text-2">
          <StatusGlyph state="running" /> Checking for git and the GitHub CLI…
        </div>
      ) : authenticated ? (
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3"
              aria-hidden="true"
            />
            <Input
              aria-label="Search your repositories"
              placeholder="Search your repositories…"
              className={`${INPUT} pl-8`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="ob-list max-h-[232px] overflow-y-auto">
            {loadingRepos ? (
              <div className="ob-row text-text-2">
                <StatusGlyph state="running" /> Loading your repositories…
              </div>
            ) : filteredRepos.length === 0 ? (
              <div className="ob-row text-text-3">
                {repos.length === 0 ? 'No repositories found for your account.' : `No repositories match “${query}”.`}
              </div>
            ) : (
              filteredRepos.map((r) => {
                const selected = validUrl === `https://github.com/${r.nameWithOwner}`
                return (
                  <button
                    key={r.nameWithOwner}
                    type="button"
                    className="ob-row"
                    data-selected={selected}
                    aria-pressed={selected}
                    onClick={() => setUrl(`https://github.com/${r.nameWithOwner}`)}
                  >
                    <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden="true" />
                    <span className="ob-row-main">
                      <span className="ob-row-title">{r.nameWithOwner}</span>
                      {r.description && <span className="ob-row-sub truncate">{r.description}</span>}
                    </span>
                    {selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />}
                  </button>
                )
              })
            )}
          </div>
        </div>
      ) : (
        <Notice title="Paste a repository URL">
          <InlineText text="The GitHub CLI isn’t signed in, so your repositories can’t be listed. Run `gh auth login` to pick from them, or paste a URL below." />
        </Notice>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="repo-url" className="ob-label">
          Repository URL
        </label>
        <Input
          id="repo-url"
          className={INPUT}
          placeholder="https://github.com/owner/repo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        {url.trim() && validation && !validation.ok && <span className="text-xs text-danger">{validation.reason}</span>}
      </div>

      {validUrl && (
        <div className="flex flex-col gap-1.5">
          <span className="ob-label">Clone into</span>
          <div className="flex min-h-8 items-center gap-3">
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text" title={dest ?? undefined}>
              {dest ? tildify(dest) : <span className="text-text-3">Finding a folder…</span>}
            </span>
            <button type="button" className="ob-link" disabled={picking} onClick={() => void changeDestination()}>
              {picking ? 'Choosing…' : 'Change…'}
            </button>
          </div>
          {dest && <span className="ob-meta">Must be a new or empty folder.</span>}
        </div>
      )}

      {error && <Notice tone="danger" title={error} />}

      <StepFooter left={back}>
        <ObButton
          variant="primary"
          data-onb-primary="true"
          disabled={!validUrl || !dest}
          onClick={() => validUrl && dest && onNext(validUrl, dest)}
        >
          Clone &amp; continue
        </ObButton>
      </StepFooter>
    </>
  )
}
