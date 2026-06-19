import { Card } from '../ui/Card'

export default function DockerDownBanner() {
  return (
    <Card className="border-danger/40 text-sm text-danger">
      Docker isn&apos;t running. Start Docker Desktop (or OrbStack/Colima) — this list refreshes
      automatically.
    </Card>
  )
}
