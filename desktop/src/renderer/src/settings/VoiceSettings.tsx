/** Settings › Voice (desktop): the microphone and how dictation behaves in this app.
 *
 *  Dictation works in every text field — inside your projects (the embedded portal) and in
 *  this app's own fields (onboarding, rename, settings). macOS must allow the microphone
 *  once; this section shows that state and fixes it. The engine, language list and speech
 *  provider keys live in each project's Settings › Voice (the key stays in that project). */
import { useEffect, useState } from 'react'
import type { MicAccess, MicApi } from '../../../shared/mic'
import { LANGUAGES, SHORTCUTS, readVoicePrefs, writeVoicePrefs, type VoicePrefs } from '../dictation/prefs'

const ACCESS_TEXT: Record<MicAccess, string> = {
  granted: 'Allowed',
  'not-determined': 'Not asked yet',
  denied: 'Blocked in System Settings',
  restricted: 'Restricted by your Mac’s settings',
  unknown: 'Unknown'
}

const row = 'flex min-h-[52px] items-center justify-between gap-6 px-4 py-3'
const btn =
  'h-7 shrink-0 rounded-md border border-border px-3 text-[13px] text-text hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50'
const select =
  'h-7 shrink-0 rounded-md border border-border bg-bg px-2 text-[13px] text-text outline-none focus:border-accent'

export default function VoiceSettings({
  api = window.orchaDesktop?.mic,
  project,
  onOpenProjectVoice
}: {
  api?: MicApi
  /** the running project whose Settings › Voice the button opens */
  project?: string | null
  onOpenProjectVoice?: () => void
}) {
  const [access, setAccess] = useState<MicAccess | null>(null)
  const [busy, setBusy] = useState(false)
  const [prefs, setPrefs] = useState<VoicePrefs>(() => readVoicePrefs())
  const set = (patch: Partial<VoicePrefs>): void => setPrefs(writeVoicePrefs(patch))

  useEffect(() => {
    if (!api) return
    let alive = true
    api.status().then(
      (s) => alive && setAccess(s),
      () => alive && setAccess('unknown')
    )
    return () => {
      alive = false
    }
  }, [api])

  const allow = (): void => {
    if (!api) return
    setBusy(true)
    api
      .request()
      .then(setAccess, () => setAccess('unknown'))
      .finally(() => setBusy(false))
  }
  const blocked = access === 'denied' || access === 'restricted'
  const mac = /mac/i.test(navigator.platform || navigator.userAgent)

  return (
    <section data-testid="settings-voice">
      <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-text">Voice</h2>
      <p className="mb-6 mt-1 text-[13px] text-text-3">
        Dictate into any text field — hold {mac ? '⌥ Space' : 'Alt+Space'} to talk, or tap it to start and stop. Esc cancels.
      </p>
      <div className="flex flex-col divide-y divide-border rounded-[10px] border border-border">
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text">Microphone access</div>
            <div className="text-[12px] text-text-3" data-testid="voice-mic-status">
              {access ? ACCESS_TEXT[access] : 'Checking…'}
              {blocked ? ' — turn on Embodent in Privacy & Security › Microphone, then come back.' : ''}
            </div>
          </div>
          {blocked ? (
            <button type="button" className={btn} data-testid="voice-mic-open" onClick={() => void api?.openSettings()}>
              Open System Settings
            </button>
          ) : (
            <button type="button" className={btn} data-testid="voice-mic-allow" disabled={!api || busy || access === 'granted'} onClick={allow}>
              {access === 'granted' ? 'Allowed' : 'Allow microphone'}
            </button>
          )}
        </div>
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text">Dictation in this app</div>
            <div className="text-[12px] text-text-3">Onboarding, rename and settings fields. Uses a running project’s speech provider.</div>
          </div>
          <div
            role="radiogroup"
            aria-label="Dictation in this app"
            data-testid="voice-enabled"
            className="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-bg p-[2px]"
          >
            {([true, false] as const).map((v) => {
              const on = (prefs.engine !== 'off') === v
              return (
                <button
                  key={String(v)}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => !on && set({ engine: v ? 'auto' : 'off' })}
                  className={`h-[22px] rounded-[5px] px-2.5 text-[12.5px] font-medium leading-none transition-colors ${
                    on ? 'bg-selected text-text shadow-[var(--shadow-seg)]' : 'text-text-3 hover:text-text-2'
                  }`}
                >
                  {v ? 'On' : 'Off'}
                </button>
              )
            })}
          </div>
        </div>
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text">Shortcut</div>
            <div className="text-[12px] text-text-3">Hold to talk, or tap to toggle.</div>
          </div>
          <select aria-label="Dictation shortcut" className={select} value={prefs.shortcut} onChange={(e) => set({ shortcut: e.target.value as VoicePrefs['shortcut'] })}>
            {SHORTCUTS.map((s) => (
              <option key={s.key} value={s.key}>
                {mac ? s.mac : s.other}
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text">Language</div>
            <div className="text-[12px] text-text-3">Automatic works for most people.</div>
          </div>
          <select aria-label="Dictation language" className={select} value={prefs.language} onChange={(e) => set({ language: e.target.value })}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className={row}>
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text">Engine and speech keys</div>
            <div className="text-[12px] text-text-3">
              {project ? `Cloud provider, on-device model and AI clean-up live in ${project}’s Settings › Voice.` : 'Start a project to set up its speech provider (Settings › Voice).'}
            </div>
          </div>
          <button type="button" className={btn} data-testid="voice-open-project" disabled={!onOpenProjectVoice} onClick={() => onOpenProjectVoice?.()}>
            Open project voice settings
          </button>
        </div>
      </div>
      <p className="mt-4 text-[12px] text-text-3">Audio is never stored. It is streamed to the project’s speech provider (or stays on this computer) and discarded.</p>
    </section>
  )
}
