import { GitBranch, Laptop, Smartphone, Users } from 'lucide-react'
import { ObButton, OrchaMark, StepFooter, StepHeader } from '../ui'

const FEATURES = [
  {
    icon: Users,
    title: 'A team of agents',
    body: 'Several agents work on one project at once, each with its own role.'
  },
  {
    icon: GitBranch,
    title: 'Review in place',
    body: 'Read their changes and comment right on the diff.'
  },
  {
    icon: Laptop,
    title: 'Runs on this Mac',
    body: 'Your code and your agents stay on your machine.'
  },
  {
    icon: Smartphone,
    title: 'Check in from your phone',
    body: 'Pair your phone to answer requests on the go.'
  }
]

/** First-run welcome: a hero with the Embodent mark gliding over a slow, soft light field,
 *  a Display title, four one-line capabilities (revealed in sequence) and one primary.
 *  No typewriter, no emoji; everything holds still under reduced motion. */
export default function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <>
      <div className="ob-hero">
        <div className="ob-hero-field" aria-hidden="true">
          <span className="ob-hero-glow" data-n="1" />
          <span className="ob-hero-glow" data-n="2" />
          <span className="ob-hero-wake" />
        </div>
        <span className="ob-hero-mark">
          <OrchaMark size={46} />
        </span>
      </div>
      <StepHeader
        size="xl"
        title="Welcome to Embodent"
        subtitle="Your agent fleet, on your machine. Setting up your first project takes a couple of minutes."
      />
      <ul className="ob-features">
        {FEATURES.map((f, i) => (
          <li key={f.title} className="ob-feature" style={{ '--i': i } as React.CSSProperties}>
            <span className="ob-feature-icon">
              <f.icon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium text-text">{f.title}</span>
              <span className="text-[12.5px] leading-snug text-text-3">{f.body}</span>
            </div>
          </li>
        ))}
      </ul>
      <StepFooter
        hint={
          <>
            Press <span className="ob-kbd">↵</span>
          </>
        }
      >
        <ObButton variant="primary" data-onb-primary="true" onClick={onContinue}>
          Get started
        </ObButton>
      </StepFooter>
    </>
  )
}
