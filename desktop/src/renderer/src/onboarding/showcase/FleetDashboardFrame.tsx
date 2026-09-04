/** Storyboard (a): a faux fleet dashboard — a few agent cards with status pills. Pure CSS/DOM,
 *  no screenshots. Styled entirely from the app's design tokens so it themes correctly. */
export default function FleetDashboardFrame() {
  const agents: { alias: string; role: string; status: 'working' | 'idle' | 'blocked' }[] = [
    { alias: 'Atlas', role: 'Lead', status: 'working' },
    { alias: 'Sable', role: 'iOS', status: 'working' },
    { alias: 'Quill', role: 'Docs', status: 'idle' },
    { alias: 'Vex', role: 'QA', status: 'blocked' }
  ]
  const dot: Record<string, string> = {
    working: 'bg-ok',
    idle: 'bg-text/30',
    blocked: 'bg-warning'
  }
  return (
    <div className="flex h-full w-full flex-col gap-3 rounded-xl border border-border bg-bg p-5">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-danger/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-ok/60" />
        <span className="ml-2 text-xs text-text/40">Orcha stacks</span>
      </div>
      <div className="grid flex-1 grid-cols-2 gap-3">
        {agents.map((a) => (
          <div key={a.alias} className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${dot[a.status]}`} aria-hidden />
              <span className="truncate text-sm font-medium text-text">{a.alias}</span>
            </div>
            <span className="text-xs text-text/50">{a.role}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
