import { RotateCw } from 'lucide-react'
import { InlineText, Notice, ObButton } from './ui'
import type { SetupIssue } from './usePreflightChecks'

/** Add a project's background setup check, surfaced only when something required is
 *  missing or broken: what's wrong, the fix, "Check again" and a way into the full Setup
 *  step. Compact — one notice, one line per problem. */
export function SetupCheckNotice({
  issues,
  checking,
  onRecheck,
  onOpenSetup
}: {
  issues: SetupIssue[]
  checking: boolean
  onRecheck: () => void
  onOpenSetup: () => void
}) {
  if (issues.length === 0) return null
  const title = issues.length === 1 ? issues[0].title : `${issues.length} things on this Mac need attention`
  return (
    <div className="ob-reveal" data-testid="setup-notice">
      <Notice
        tone="warning"
        title={title}
        action={
          <div className="flex items-center gap-1">
            <ObButton variant="ghost" onClick={onOpenSetup}>
              Open setup
            </ObButton>
            <ObButton onClick={onRecheck} disabled={checking}>
              <RotateCw className={`h-3 w-3 ${checking ? 'ob-rotate' : ''}`} aria-hidden="true" />
              {checking ? 'Checking…' : 'Check again'}
            </ObButton>
          </div>
        }
      >
        {issues.length === 1 ? (
          <InlineText text={issues[0].fix} />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {issues.map((i) => (
              <li key={i.key}>
                <span className="text-text">{i.title}.</span> <InlineText text={i.fix} />
              </li>
            ))}
          </ul>
        )}
        <span className="mt-1 block text-[12px] text-text-3">
          You can keep choosing your project meanwhile; creating it needs this fixed.
        </span>
      </Notice>
    </div>
  )
}

/** One sentence for the Setup step when Add a project routes there. */
export function setupReason(issues: SetupIssue[]): string | null {
  if (issues.length === 0) return null
  return issues.map((i) => `${i.title}.`).join(' ') + ' Fix it below, then continue to add your project.'
}
