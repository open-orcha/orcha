import type { Stack } from '../../../shared/types'
import StackCard from './StackCard'
import StackRow from './StackRow'
import type { ViewMode } from './ViewToggle'

interface Props {
  stacks: Stack[]
  attentionCounts: Map<string, number>
  view: ViewMode
  onChanged: () => void
}

export default function StackList({ stacks, attentionCounts, view, onChanged }: Props) {
  if (view === 'list') {
    return (
      <ul className="stack-rows">
        {stacks.map((stack) => (
          <StackRow
            key={stack.project}
            stack={stack}
            attentionCount={attentionCounts.get(stack.project) ?? 0}
            onChanged={onChanged}
          />
        ))}
      </ul>
    )
  }
  return (
    <div className="stack-grid">
      {stacks.map((stack) => (
        <StackCard
          key={stack.project}
          stack={stack}
          attentionCount={attentionCounts.get(stack.project) ?? 0}
          onChanged={onChanged}
        />
      ))}
    </div>
  )
}
