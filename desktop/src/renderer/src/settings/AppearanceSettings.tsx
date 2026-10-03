/** Settings › Appearance: System / Light / Dark as one compact segmented choice, each option
 *  a small window preview over its label (Linear-style — no colour stripes, one accent ring on
 *  the selected option). Main persists the mode and drives nativeTheme.themeSource, which
 *  flips `prefers-color-scheme` in this window, the tray popover and every embedded portal
 *  (V2 portals follow the host's theme), so the change is live everywhere at once. */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { THEME_MODES, type ThemeApi, type ThemeMode, type ThemeState } from '../../../shared/theme'

const LABEL: Record<ThemeMode, string> = { system: 'System', light: 'Light', dark: 'Dark' }

/** Preview palettes are deliberately literal: each thumbnail depicts ITS theme whatever the
 *  current one is. Values = the light / dark token sets in styles.css. */
const PREVIEW = {
  light: { win: '#f4f4f5', panel: '#ffffff', line: '#e6e6e9', text: '#c9cace', accent: '#5561cc' },
  dark: { win: '#101113', panel: '#191a1d', line: '#2b2d33', text: '#3a3d45', accent: '#8d93f7' }
} as const

function Thumb({ tone }: { tone: 'light' | 'dark' }) {
  const p = PREVIEW[tone]
  return (
    <svg viewBox="0 0 96 60" width="96" height="60" aria-hidden="true" focusable="false" className="block">
      <rect width="96" height="60" fill={p.win} />
      <rect x="6" y="9" width="18" height="3" rx="1.5" fill={p.accent} />
      <rect x="6" y="17" width="14" height="3" rx="1.5" fill={p.text} />
      <rect x="6" y="24" width="16" height="3" rx="1.5" fill={p.text} />
      <rect x="30" y="5" width="62" height="51" rx="4" fill={p.panel} stroke={p.line} />
      <rect x="37" y="13" width="30" height="4" rx="2" fill={p.text} />
      <rect x="37" y="24" width="48" height="3" rx="1.5" fill={p.line} />
      <rect x="37" y="31" width="42" height="3" rx="1.5" fill={p.line} />
      <rect x="37" y="38" width="45" height="3" rx="1.5" fill={p.line} />
    </svg>
  )
}

function Preview({ mode }: { mode: ThemeMode }) {
  if (mode !== 'system') return <Thumb tone={mode} />
  // System: light on the left, dark on the right — the choice follows macOS.
  return (
    <span className="relative block h-[60px] w-[96px]">
      <span className="absolute inset-0">
        <Thumb tone="light" />
      </span>
      <span className="absolute inset-0" style={{ clipPath: 'polygon(55% 0, 100% 0, 100% 100%, 41% 100%)' }}>
        <Thumb tone="dark" />
      </span>
    </span>
  )
}

export default function AppearanceSettings({ api = window.orchaDesktop?.theme }: { api?: ThemeApi }) {
  const [state, setState] = useState<ThemeState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refs = useRef<Partial<Record<ThemeMode, HTMLButtonElement | null>>>({})

  useEffect(() => {
    if (!api) return
    let alive = true
    api.get().then(
      (s) => alive && setState(s),
      () => alive && setError('Couldn’t read the current appearance.')
    )
    const off = api.onChanged((s) => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [api])

  const choose = (mode: ThemeMode): void => {
    if (!api || state?.mode === mode) return
    setError(null)
    // Optimistic: the radio moves now; main's answer (and the live media query) follow.
    setState((s) => (s ? { ...s, mode } : s))
    api.set(mode).then(setState, () => setError('Couldn’t save the appearance. Try again.'))
  }

  const onKey = (e: KeyboardEvent, mode: ThemeMode): void => {
    const i = THEME_MODES.indexOf(mode)
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = THEME_MODES[(i + step + THEME_MODES.length) % THEME_MODES.length]
    choose(next)
    refs.current[next]?.focus()
  }

  const current = state?.mode ?? null
  return (
    <section data-testid="settings-appearance">
      <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-text">Appearance</h2>
      <p className="mb-6 mt-1 text-[13px] text-text-3">
        How Embodent looks on this Mac — the app, the menu-bar popover and every project’s portal inside it.
      </p>
      <div className="flex flex-col gap-4 rounded-[10px] border border-border px-4 py-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-text">Theme</div>
          <div className="text-[12px] text-text-3">
            {current === 'system'
              ? `Follows macOS — ${state?.resolved === 'light' ? 'light' : 'dark'} right now.`
              : 'System follows your macOS appearance, switching when it does.'}
          </div>
        </div>
        <div role="radiogroup" aria-label="Theme" data-testid="appearance-mode" className="flex flex-wrap gap-3">
          {THEME_MODES.map((mode) => {
            const on = current === mode
            return (
              <button
                key={mode}
                ref={(el) => {
                  refs.current[mode] = el
                }}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on || (current === null && mode === 'system') ? 0 : -1}
                disabled={!api || !state}
                data-testid={`appearance-${mode}`}
                onClick={() => choose(mode)}
                onKeyDown={(e) => onKey(e, mode)}
                className="group flex flex-col items-start gap-2 rounded-[8px] p-1 text-left outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span
                  className={`block overflow-hidden rounded-[6px] border transition-shadow ${
                    on
                      ? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]'
                      : 'border-border-strong group-hover:border-text-3'
                  }`}
                >
                  <Preview mode={mode} />
                </span>
                <span className={`px-0.5 text-[12.5px] ${on ? 'font-medium text-text' : 'text-text-2'}`}>{LABEL[mode]}</span>
              </button>
            )
          })}
        </div>
        {error ? (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}
