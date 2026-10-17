import { Sparkles } from 'lucide-react'

/** The local Claude analysis's one-paragraph summary, shown above the merged suggestions.
 *  Plain text with a sparkle — no card around it (the suggestion list is the only surface). */
export default function ProjectAnalysisCard({ summary }: { summary: string }) {
  return (
    <p className="m-0 flex items-start gap-2 text-[13px] leading-relaxed text-text-2">
      <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
      <span>{summary}</span>
    </p>
  )
}
