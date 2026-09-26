import { Sparkles } from 'lucide-react'
import { Card } from '../../ui/Card'

/** Rendered once analyzeProject resolves successfully — the summary paragraph above the
 *  (already-merged) suggestion cards in FleetStep. Kept intentionally tiny: the merged
 *  suggestion list itself is what carries the "Claude" badges, this is just the framing
 *  paragraph above them. */
export default function ProjectAnalysisCard({ summary }: { summary: string }) {
  return (
    <Card className="flex items-start gap-2 text-sm">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      <p className="onb-body">{summary}</p>
    </Card>
  )
}
