import { Check } from 'lucide-react'
import { ObButton, StepFooter, StepHeader, tildify } from '../ui'

const SPARKS = [0, 1, 2, 3, 4, 5, 6, 7]

/** Last screen — lands with one calm celebration (a check that springs in, two soft ripples
 *  and a single ring of eight sparks; no confetti, nothing loops), then says what was created (one definition list, real values only) and one primary
 *  that opens the project on its next useful screen — its Agents when a fleet was just
 *  created, otherwise the Overview, which explains the next step for an empty project. */
export default function FinishStep({
  project,
  folder = null,
  portalUrl,
  agents,
  codeSourceBound = false,
  opening = false,
  onOpen
}: {
  project: string
  folder?: string | null
  portalUrl: string
  /** Aliases of the agents created on the Agents step (empty when skipped/unavailable). */
  agents: string[]
  /** True once bindCodeSource connected the project to its local git repo. */
  codeSourceBound?: boolean
  opening?: boolean
  onOpen: (path: string) => void
}) {
  const name = project.replace(/^orcha-/, '')
  const path = agents.length > 0 ? '/agents' : '/'
  const rows: [string, React.ReactNode][] = [
    ['Project', name],
    ...(folder
      ? ([
          [
            'Folder',
            <span className="font-mono text-[12.5px]" title={folder}>
              {tildify(folder)}
            </span>
          ]
        ] as [string, React.ReactNode][])
      : []),
    ['Portal', <span className="font-mono text-[12.5px]">{portalUrl.replace(/^https?:\/\//, '')}</span>],
    [
      'Agents',
      agents.length > 0 ? agents.join(', ') : <span className="text-text-3">None yet — add them from the project</span>
    ],
    ...(codeSourceBound ? ([['Code source', 'Local repository']] as [string, React.ReactNode][]) : [])
  ]

  return (
    <>
      <div className="flex flex-col gap-5">
        <span className="ob-burst" aria-hidden="true">
          <span className="ob-burst-ring" data-n="1" />
          <span className="ob-burst-ring" data-n="2" />
          {SPARKS.map((i) => (
            <span key={i} className="ob-spark" style={{ '--a': `${i * 45 + 22.5}deg` } as React.CSSProperties}>
              <span />
            </span>
          ))}
          <span className="ob-burst-core ob-pop">
            <Check className="h-5 w-5" strokeWidth={2.75} />
          </span>
        </span>
        <StepHeader
          title={`${name} is ready`}
          subtitle={
            agents.length > 0
              ? 'Your agents are set up. Give them their first task from the project.'
              : 'The project is running. Next, add agents and give them a first task.'
          }
        />
      </div>
      <dl className="ob-list ob-summary m-0">
        {rows.map(([k, v], i) => (
          <div key={k} className="ob-row" style={{ minHeight: 38, '--i': i } as React.CSSProperties}>
            <dt className="w-28 shrink-0 text-text-3">{k}</dt>
            <dd className="m-0 min-w-0 flex-1 truncate text-text">{v}</dd>
          </div>
        ))}
      </dl>
      <StepFooter hint={agents.length > 0 ? 'Opens Agents' : 'Opens Overview'}>
        <ObButton variant="primary" data-onb-primary="true" disabled={opening} onClick={() => onOpen(path)}>
          {opening ? 'Opening…' : `Open ${name}`}
        </ObButton>
      </StepFooter>
    </>
  )
}
