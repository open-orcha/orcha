import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

export default function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="flex flex-col items-start gap-3 border-dashed">
      <p className="text-sm text-text/70">No orcha stacks yet.</p>
      <Button onClick={onCreate}>Create your first project</Button>
    </Card>
  )
}
