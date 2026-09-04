import FleetDashboardFrame from './FleetDashboardFrame'
import CodeSpaceFrame from './CodeSpaceFrame'
import TerminalFrame from './TerminalFrame'
import PhonePairingFrame from './PhonePairingFrame'

const CAPTIONS = ['Your whole fleet, one view', 'Review code inline, right in Orcha', 'Watch agents work, live', 'Pair your phone in seconds']

const FRAMES = [FleetDashboardFrame, CodeSpaceFrame, TerminalFrame, PhonePairingFrame]

/** Passive looping feature-showcase: 4 hand-built miniature storyboards, cross-fading on a
 *  single shared 16s CSS @keyframes cycle (animation-delay spaced cycle/N — no JS timers).
 *  Shown beside long waits (Setup's install checklist, Provision) so the wait feels premium
 *  rather than dead air. */
export default function ShowcaseCarousel() {
  return (
    <div className="relative flex min-h-[420px] w-full flex-col gap-4 lg:min-h-[480px]" aria-hidden="true">
      <div className="relative flex-1">
        {FRAMES.map((Frame, i) => (
          <div key={i} data-frame={i} className="onb-showcase-frame absolute inset-0">
            <Frame />
          </div>
        ))}
      </div>
      <div className="onb-showcase-dots flex items-center justify-center gap-2">
        {CAPTIONS.map((_, i) => (
          <span key={i} data-frame={i} className="onb-showcase-frame onb-showcase-dot" />
        ))}
      </div>
      <div className="relative h-6">
        {CAPTIONS.map((caption, i) => (
          <p
            key={caption}
            data-frame={i}
            className="onb-showcase-frame absolute inset-0 text-center text-sm text-text/50"
          >
            {caption}
          </p>
        ))}
      </div>
    </div>
  )
}
