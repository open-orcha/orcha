import { Plus } from 'lucide-react'

/** The dashed "+ New project" card — same slot as a project card in the grid, opens the
 *  Add-project wizard. Mirrors the cloud hub's `.pcard.new` treatment. */
export default function NewProjectCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[168px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-text/40 transition-colors hover:border-accent/50 hover:text-text/70"
    >
      <Plus className="h-5 w-5" />
      <span className="text-sm">New project</span>
    </button>
  )
}
