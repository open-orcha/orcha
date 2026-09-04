import { FolderOpen, FolderGit2 } from 'lucide-react'

export type ProjectSource = 'local' | 'github'

/** First fork in the wizard: where does the project come from. Local folder keeps the
 *  original onboarding path (FolderStep → DetailsStep); From GitHub clones first
 *  (GithubSourceStep), then rejoins the SAME provision step as local. */
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
            <span className="text-base font-medium text-text">From GitHub</span>
            <span className="text-sm text-text/60">Clone one of your repos, or paste a URL.</span>
          </div>
        </button>
      </div>
    </div>
  )
}
