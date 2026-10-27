// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { act, render } from '@testing-library/react'

/** GH #347: the main window of a dev build grew ~1.5 GB a day. React 19.2's dev build gives
 *  every root ProfileMode and logs each committed update, and each component re-rendered with
 *  changed props, as a `performance.measure` entry with the props diff as its detail. Chromium
 *  keeps those entries until someone clears them, and nothing did: the window re-renders on
 *  every terminal meta event (up to 2 a second per session), so the entries piled up in native
 *  memory, outside the JS heap. React 19.3 clears each entry right after logging it. This pins
 *  that behaviour, so a React downgrade or regression fails here instead of in a 4-day run.
 *  The path only runs because test-setup.ts gives the console Chromium's timeStamp first. */
describe('React dev build performance tracks (GH #347)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    performance.clearMeasures()
  })

  it('logs its tracks but leaves no measure entries behind', () => {
    const measure = vi.spyOn(performance, 'measure')
    let bump: (n: number) => void = () => {}
    function Row({ title, n }: { title: string; n: number }) {
      return <li>{`${title} · ${n}`}</li>
    }
    function Strip({ tabs, n }: { tabs: readonly string[]; n: number }) {
      return (
        <ul>
          {tabs.map((t) => (
            <Row key={t} title={t} n={n} />
          ))}
        </ul>
      )
    }
    function App() {
      const [n, setN] = useState(0)
      bump = setN
      return <Strip tabs={['zsh', 'claude', 'codex']} n={n} />
    }
    render(<App />)
    for (let i = 1; i <= 200; i++) act(() => bump(i))

    // React did log (the path under test ran)…
    expect(measure).toHaveBeenCalled()
    // …and cleared every entry it logged.
    expect(performance.getEntriesByType('measure')).toHaveLength(0)
  })
})
