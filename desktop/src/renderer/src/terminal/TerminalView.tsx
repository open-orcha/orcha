import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { chunkWrite, type TermApi } from '../../../shared/terminal'
import type { TermClient } from './termClient'
import { terminalShouldSkip } from './commandModel'
import type { ResolvedTheme } from '../../../shared/theme'
import { currentResolvedTheme, useResolvedTheme } from '../theme/useResolvedTheme'

/** V2 dark tokens (styles.css @theme) mapped onto the terminal palette (Appearance → Dark). The background is the
 *  dock surface (--color-card) so the terminal reads as part of the raised panel. */
export const TERMINAL_THEME: ITheme = {
  background: '#191a1d',
  foreground: '#e3e4e8',
  cursor: '#8d93f7',
  cursorAccent: '#191a1d',
  selectionBackground: 'rgba(141, 147, 247, 0.28)',
  selectionInactiveBackground: 'rgba(141, 147, 247, 0.16)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.10)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.18)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.24)',
  black: '#2b2d33',
  red: '#ee7070',
  green: '#4cb782',
  yellow: '#e2a336',
  blue: '#4ea7fc',
  magenta: '#b59cf7',
  cyan: '#4cc3c7',
  white: '#c9cbd2',
  brightBlack: '#6b6f7a',
  brightRed: '#f59090',
  brightGreen: '#6fd09f',
  brightYellow: '#f0bd5e',
  brightBlue: '#78bcfd',
  brightMagenta: '#cbb8fa',
  brightCyan: '#74d6d9',
  brightWhite: '#eeeff2'
}

/** Light terminal (Settings › Appearance → Light): the terminal follows the app theme rather
 *  than staying a dark island in a light panel. White background = the light --color-card, so
 *  it still reads as part of the panel. ANSI hues are the light semantic tokens (AA as text on
 *  white); "white"/"brightWhite" are mid greys because TUIs use them for dim/secondary text and
 *  a literal white would vanish. xterm's minimumContrastRatio (terminalOptionsFor) is the
 *  safety net for programs that hard-code 256-colour / truecolor foregrounds tuned for dark. */
export const TERMINAL_THEME_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1c1d1f',
  cursor: '#5561cc',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(85, 97, 204, 0.20)',
  selectionInactiveBackground: 'rgba(85, 97, 204, 0.12)',
  scrollbarSliderBackground: 'rgba(16, 17, 19, 0.12)',
  scrollbarSliderHoverBackground: 'rgba(16, 17, 19, 0.2)',
  scrollbarSliderActiveBackground: 'rgba(16, 17, 19, 0.28)',
  black: '#1c1d1f',
  red: '#bf3535',
  green: '#177a4b',
  yellow: '#8a5a00',
  blue: '#1b66b6',
  magenta: '#8a3fb8',
  cyan: '#0f7481',
  white: '#6a6f78',
  brightBlack: '#5f636c',
  brightRed: '#cf4040',
  brightGreen: '#187f4f',
  brightYellow: '#955600',
  brightBlue: '#2471c4',
  brightMagenta: '#9a4dc9',
  brightCyan: '#12808e',
  brightWhite: '#8a8f98'
}

/** The xterm theme + contrast floor for the resolved app theme (pure, tested). */
export function terminalOptionsFor(resolved: ResolvedTheme): { theme: ITheme; minimumContrastRatio: number } {
  return resolved === 'light'
    ? { theme: TERMINAL_THEME_LIGHT, minimumContrastRatio: 4.5 }
    : { theme: TERMINAL_THEME, minimumContrastRatio: 1 }
}

/** Monospace only inside the terminal (D15). SF Mono / Menlo ship with macOS. */
export const TERMINAL_FONT = "'JetBrains Mono', 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace"

/** One xterm bound to one pty. Kept mounted (hidden) while its tab is in the background so
 *  scrollback and TUI state survive tab switches; `visible` triggers a re-fit on show. */

/** Programs that subscribed to colour-scheme change notifications (DECSET ?2031 — Claude Code
 *  does in its `auto` theme). Per pty, so a re-mounted view keeps the subscription. */
const schemeSubscribers = new Set<number>()

/** The "colour scheme changed" report a subscribed program expects: CSI ? 997 ; 1 n = dark,
 *  ; 2 n = light. It then re-asks the background (OSC 11), which xterm answers from its theme. */
export function schemeReport(resolved: 'light' | 'dark'): string {
  return `\x1b[?997;${resolved === 'dark' ? 1 : 2}n`
}

export default function TerminalView({
  ptyId,
  api,
  client,
  visible,
  focusToken,
  exited
}: {
  ptyId: number
  api: TermApi
  client: TermClient
  visible: boolean
  /** Changes whenever the tab should grab keyboard focus (activation, open). */
  focusToken: number
  exited: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const exitedRef = useRef(exited)
  exitedRef.current = exited

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    // Links open in the user's browser through the validated http(s)-only bridge — both plain
    // URLs in the output (WebLinksAddon) and OSC 8 hyperlinks (Claude Code prints those). Without
    // a linkHandler xterm falls back to window.confirm + window.open, which Electron denies: the
    // "Do you want to navigate to…?" dialog whose OK did nothing.
    const openLink = (uri: string): void => {
      void window.orchaDesktop?.openExternal?.(uri)?.catch?.(() => {})
    }
    const term = new Terminal({
      ...terminalOptionsFor(currentResolvedTheme()),
      linkHandler: { activate: (_e, uri) => openLink(uri), allowNonHttpProtocols: false },
      fontFamily: TERMINAL_FONT,
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: false,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      scrollback: 5000,
      drawBoldTextInBrightColors: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)))
    // Host shortcuts (⌘K, ⌘1-9) and menu-bar accelerators (⌘T, ⌘W…) must not be eaten by
    // the terminal — every other key goes to the shell.
    term.attachCustomKeyEventHandler((e) => !terminalShouldSkip(e))
    term.open(el)
    termRef.current = term
    fitRef.current = fit

    const detach = client.attach(ptyId, (data) => term.write(data))
    const onData = term.onData((data) => {
      if (exitedRef.current) return
      for (const chunk of chunkWrite(data)) api.write(ptyId, chunk)
    })
    const onResize = term.onResize(({ cols, rows }) => api.resize(ptyId, cols, rows))
    // Track colour-scheme subscriptions (?2031 h/l) and answer "which scheme?" (?996 n), so a
    // program in auto theme follows the app's light/dark switch live. Returning false for h/l
    // lets xterm's own mode handling run too.
    const decset = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(2031)) schemeSubscribers.add(ptyId)
      return false
    })
    const decrst = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(2031)) schemeSubscribers.delete(ptyId)
      return false
    })
    const dsr = term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
      if (params[0] !== 996) return false
      if (!exitedRef.current) api.write(ptyId, schemeReport(currentResolvedTheme()))
      return true
    })

    let raf = 0
    const refit = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (!el.isConnected || el.clientWidth === 0 || el.clientHeight === 0) return
        try {
          fit.fit()
        } catch {
          // measuring while hidden can throw; the next resize re-fits
        }
      })
    }
    const ro = new ResizeObserver(refit)
    ro.observe(el)
    refit()
    // The pty was created at a default size; tell it the real one even if fit() was a no-op.
    api.resize(ptyId, term.cols, term.rows)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      detach()
      onData.dispose()
      onResize.dispose()
      decset.dispose()
      decrst.dispose()
      dsr.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [ptyId, api, client])

  // Appearance flips (a Settings change, or macOS under System) repaint the live terminal.
  const resolved = useResolvedTheme()
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const o = terminalOptionsFor(resolved)
    term.options.theme = o.theme
    term.options.minimumContrastRatio = o.minimumContrastRatio
    // tell a subscribed program (Claude Code in auto theme) so it re-themes without a restart
    if (schemeSubscribers.has(ptyId) && !exitedRef.current) api.write(ptyId, schemeReport(resolved))
  }, [resolved])

  // A finished process leaves no live cursor behind (the exit bar says what happened).
  useEffect(() => {
    if (exited) termRef.current?.write('\x1b[?25l')
  }, [exited])

  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // not measurable yet
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [visible, focusToken])

  return (
    <div
      ref={hostRef}
      data-testid="terminal-view"
      data-pty={ptyId}
      className="orcha-xterm absolute inset-0 pl-3 pr-1 pt-2 pb-1"
      style={{ display: visible ? 'block' : 'none' }}
    />
  )
}
