import { FolderOpen, FolderGit2, Cloud, CloudCog } from 'lucide-react'
import { Badge } from '../../ui/Badge'

/** The two sources that actually work today. Stays 'github' (not 'git') because the step
 *  behind it is the gh-authenticated picker + URL field in GithubSourceStep; the URL field
 *  accepts GitLab/Bitbucket too, which the card copy now says. */
export type ProjectSource = 'local' | 'github'

/** Setup modes that are designed but not built (GH #238 options 3 + 4). They render as
 *  non-selectable preview cards so the chooser shows the full set of ways a project can be
 *  set up WITHOUT collecting input that dead-ends (CodeCleanupAgent's review note #1).
 *  Flip to false to hide them entirely — a one-line product call, no other code changes. */
export const SHOW_PREVIEW_SOURCES = true

interface PreviewSource {
  key: 'icloud' | 'cloud'
  title: string
  Icon: typeof Cloud
  /** Plain-language, deliberately explicit about what the mode will and will NOT do. */
  lines: string[]
}

const PREVIEW_SOURCES: PreviewSource[] = [
  {
    key: 'icloud',
    title: 'iCloud Drive folder',
    Icon: Cloud,
    lines: [
      'A local Orcha project whose folder lives in iCloud Drive, so the code and .orcha config appear on your other Macs.',
      'Agents, tasks, history and the database do not sync — each Mac runs its own Orcha. The folder must stay downloaded (Optimize Mac Storage off) and .orcha config can contain secrets.'
    ]
  },
  {
    key: 'cloud',
    title: 'Cloud-hosted Orcha',
    Icon: CloudCog,
    lines: [
      'Connect this app to an Orcha that already runs on a remote host — no Docker on this Mac.',
      'Pairs with the host in your browser; nothing is cloned or provisioned locally.'
    ]
  }
]

/** First fork in the wizard: where does the project come from. Local folder keeps the
 *  original onboarding path (FolderStep → DetailsStep); the git card clones first
 *  (GithubSourceStep), then rejoins the SAME provision step as local. The two preview
 *  cards are inert (disabled, no onChoose) until their follow-up issues land. */
export default function SourceStep({ onChoose }: { onChoose: (source: ProjectSource) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col items-center gap-6 animate-slide-in">
      <div className="flex flex-col items-center gap-1 text-center">
        <span className="onb-eyebrow">Source</span>
        <h2 className="onb-title text-2xl">Where's the project?</h2>
      </div>
      <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
        <button type="button" onClick={() => onChoose('local')} className="text-left">
          <div className="onb-select-card flex h-full flex-col gap-3 p-6">
            <FolderOpen className="h-6 w-6 text-accent" />
            <span className="text-base font-medium text-text">Local folder</span>
            <span className="text-sm text-text/60">Pick an existing folder, or create a new one.</span>
          </div>
        </button>
        <button type="button" onClick={() => onChoose('github')} className="text-left">
          <div className="onb-select-card flex h-full flex-col gap-3 p-6">
            <FolderGit2 className="h-6 w-6 text-accent" />
            <span className="text-base font-medium text-text">From GitHub, GitLab or Bitbucket</span>
            <span className="text-sm text-text/60">
              Clone one of your GitHub repos, or paste an https:// repository URL. SSH URLs aren’t supported.
            </span>
          </div>
        </button>
        {SHOW_PREVIEW_SOURCES &&
          PREVIEW_SOURCES.map(({ key, title, Icon, lines }) => (
            <button
              key={key}
              type="button"
              disabled
              aria-disabled="true"
              data-preview-source={key}
              className="cursor-not-allowed text-left opacity-70"
            >
              <div className="onb-select-card flex h-full flex-col gap-3 p-6">
                <div className="flex items-center justify-between">
                  <Icon className="h-6 w-6 text-text/50" />
                  <Badge>Coming soon</Badge>
                </div>
                <span className="text-base font-medium text-text">{title}</span>
                {lines.map((line) => (
                  <span key={line} className="text-sm text-text/60">
                    {line}
                  </span>
                ))}
              </div>
            </button>
          ))}
      </div>
    </div>
  )
}
