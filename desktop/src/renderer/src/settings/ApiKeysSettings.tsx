/** Settings › API keys: for people with no Claude / ChatGPT subscription. Enter an Anthropic
 *  and/or OpenAI key once, with a "Use for agent runs" switch for each; saving stores the key
 *  on every running project (sealed by its portal) and applies the switch there. Below, each
 *  project's state per provider: on, off, no key, or failed (with why).
 *
 *  A typed key lives only in this form's input until Save; it is cleared as soon as main has
 *  it, and nothing main sends back ever carries it — only `sk-ant-…abcd` or "stored". */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  KEY_PROVIDERS,
  KEY_PROVIDER_LABEL,
  MAX_API_KEY_LEN,
  type KeyProvider,
  type ProjectProviderKey,
  type ProviderKeysApi,
  type ProviderKeysInput,
  type ProviderKeysState
} from '../../../shared/providerKeys'

export const API_KEYS_CAPTION =
  'No Claude or ChatGPT subscription? Agents can bill an API key instead. Keys are stored encrypted on each project and used only for its agent runs.'

const RUNS: Record<KeyProvider, string> = { anthropic: 'Claude', openai: 'Codex' }
const PLACEHOLDER: Record<KeyProvider, string> = { anthropic: 'sk-ant-…', openai: 'sk-…' }

const STATE_TEXT: Record<ProjectProviderKey['state'], string> = { on: 'On', off: 'Off', 'no-key': 'No key', failed: 'Failed' }
const STATE_TONE: Record<ProjectProviderKey['state'], string> = {
  on: 'text-text',
  off: 'text-text-2',
  'no-key': 'text-text-3',
  failed: 'text-danger'
}

type Draft = Record<KeyProvider, { key: string; use: boolean }>

/** The switch as it stands: last saved here, or on in any project (set from its own Settings). */
function useOf(s: ProviderKeysState | null, k: KeyProvider): boolean {
  if (!s) return false
  return s.providers[k].useForAgents || s.projects.some((p) => p.providers[k].state === 'on')
}

function draftFrom(s: ProviderKeysState | null): Draft {
  return { anthropic: { key: '', use: useOf(s, 'anthropic') }, openai: { key: '', use: useOf(s, 'openai') } }
}

/** What a provider's key looks like across the running projects (masked hint, else "stored"). */
function storedLabel(s: ProviderKeysState, k: KeyProvider): string | null {
  const hit = s.projects.map((p) => p.providers[k]).find((x) => x.state === 'on' || x.state === 'off')
  if (hit) return hit.masked ?? 'stored'
  return s.providers[k].remembered ? (s.providers[k].masked ?? 'stored') : null
}

function Switch({ on, label, disabled, onChange, testId }: { on: boolean; label: string; disabled?: boolean; onChange(v: boolean): void; testId: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'bg-accent' : 'bg-border-strong'}`}
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-[2px] h-[14px] w-[14px] rounded-full bg-bg shadow-sm transition-transform ${on ? 'translate-x-[16px]' : 'translate-x-[2px]'}`}
      />
    </button>
  )
}

function summary(s: ProviderKeysState): string {
  const n = s.projects.length
  if (n === 0) return s.canRemember ? 'Saved. Projects you start will get these keys.' : 'Saved. Start a project to store keys on it.'
  const failed = s.projects.filter((p) => KEY_PROVIDERS.some((k) => p.providers[k].state === 'failed')).length
  if (failed === 0) return `Saved and applied to ${n} project${n === 1 ? '' : 's'}.`
  return `Saved. ${failed} of ${n} project${n === 1 ? '' : 's'} couldn’t be updated — see below.`
}

export default function ApiKeysSettings({ api = window.orchaDesktop?.providerKeys }: { api?: ProviderKeysApi }) {
  const [state, setState] = useState<ProviderKeysState | null>(null)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null))
  const [touched, setTouchedState] = useState(false)
  const touchedRef = useRef(false)
  const setTouched = (v: boolean): void => {
    touchedRef.current = v
    setTouchedState(v)
  }
  const [busy, setBusy] = useState<'reading' | 'saving' | null>('reading')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const adopt = useCallback((s: ProviderKeysState, resetDraft: boolean) => {
    setState(s)
    if (resetDraft) setDraft(draftFrom(s))
  }, [])

  useEffect(() => {
    if (!api) return
    let alive = true
    api.get().then((s) => alive && adopt(s, true), () => undefined)
    api.refresh().then(
      (s) => {
        if (!alive) return
        setState(s)
        // Untouched switches follow what the projects say; a typed key is never reset.
        if (!touchedRef.current)
          setDraft((d) => ({ anthropic: { ...d.anthropic, use: useOf(s, 'anthropic') }, openai: { ...d.openai, use: useOf(s, 'openai') } }))
        setBusy(null)
      },
      () => {
        if (!alive) return
        setError('Couldn’t read your projects’ keys.')
        setBusy(null)
      }
    )
    return () => {
      alive = false
    }
  }, [api, adopt])

  const dirty = touched || KEY_PROVIDERS.some((k) => draft[k].key.trim() !== '')

  const save = (e: FormEvent): void => {
    e.preventDefault()
    if (!api || !dirty || busy === 'saving') return
    const input: ProviderKeysInput = {}
    for (const k of KEY_PROVIDERS) {
      const key = draft[k].key.trim()
      const changedSwitch = draft[k].use !== useOf(state, k)
      if (!key && !changedSwitch) continue
      input[k] = key ? { apiKey: key, useForAgents: draft[k].use } : { useForAgents: draft[k].use }
    }
    if (Object.keys(input).length === 0) {
      setTouched(false)
      return
    }
    setBusy('saving')
    setError(null)
    setNotice(null)
    // The typed key leaves the renderer here and is not kept: clear the inputs at once.
    setDraft((d) => ({ anthropic: { ...d.anthropic, key: '' }, openai: { ...d.openai, key: '' } }))
    api.save(input).then(
      (s) => {
        adopt(s, true)
        setTouched(false)
        setNotice(summary(s))
        setBusy(null)
      },
      () => {
        setError('Couldn’t save. Check the key and try again.')
        setBusy(null)
      }
    )
  }

  return (
    <section data-testid="settings-api-keys">
      <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-text">API keys</h2>
      <p className="mb-6 mt-1 text-[13px] text-text-3" data-testid="api-keys-caption">
        {API_KEYS_CAPTION}
      </p>
      <form onSubmit={save} className="flex flex-col divide-y divide-border rounded-[10px] border border-border">
        {KEY_PROVIDERS.map((k) => {
          const stored = state ? storedLabel(state, k) : null
          return (
            <div key={k} className="flex flex-col gap-2.5 px-4 py-3.5" data-testid={`api-key-${k}`}>
              <div className="flex items-center justify-between gap-6">
                <div className="min-w-0">
                  <label htmlFor={`api-key-input-${k}`} className="text-[13px] font-medium text-text">
                    {KEY_PROVIDER_LABEL[k]} API key
                  </label>
                  <div className="text-[12px] text-text-3">
                    Bills {RUNS[k]} agent runs.{' '}
                    {stored ? (
                      <span data-testid={`api-key-stored-${k}`}>
                        Current key: <span className="font-mono text-text-2">{stored}</span>
                      </span>
                    ) : (
                      'No key yet.'
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span id={`api-key-use-${k}`} className="text-[12.5px] text-text-2">
                    Use for agent runs
                  </span>
                  <Switch
                    on={draft[k].use}
                    label={`Use the ${KEY_PROVIDER_LABEL[k]} key for agent runs`}
                    testId={`api-key-use-${k}`}
                    disabled={!api || busy === 'saving'}
                    onChange={(v) => {
                      setDraft((d) => ({ ...d, [k]: { ...d[k], use: v } }))
                      setTouched(true)
                      setNotice(null)
                    }}
                  />
                </div>
              </div>
              <input
                id={`api-key-input-${k}`}
                data-testid={`api-key-input-${k}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_API_KEY_LEN}
                value={draft[k].key}
                placeholder={stored ? 'Paste a new key to replace it' : PLACEHOLDER[k]}
                disabled={!api || busy === 'saving'}
                onChange={(e) => {
                  const v = e.target.value
                  setDraft((d) => ({ ...d, [k]: { ...d[k], key: v } }))
                  setNotice(null)
                }}
                className="h-8 w-full max-w-[420px] rounded-md border border-border bg-bg px-2.5 font-mono text-[12.5px] text-text outline-none placeholder:font-sans placeholder:text-text-3 focus:border-accent disabled:opacity-60"
              />
            </div>
          )
        })}
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            type="submit"
            data-testid="api-keys-save"
            disabled={!api || !dirty || busy === 'saving'}
            className="h-8 shrink-0 rounded-md border border-border px-3 text-[13px] text-text hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'saving' ? 'Saving…' : 'Save'}
          </button>
          {notice ? (
            <p role="status" data-testid="api-keys-notice" className="text-[12px] text-text-2">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </form>

      <h3 className="mb-2 mt-8 text-[13px] font-medium text-text">Projects</h3>
      {!state || (busy === 'reading' && state.projects.length === 0) ? (
        <p className="text-[12px] text-text-3">{busy === 'reading' ? 'Checking your projects…' : ''}</p>
      ) : state.projects.length === 0 ? (
        <p className="text-[12px] text-text-3" data-testid="api-keys-no-projects">
          No running projects.{' '}
          {state.canRemember ? 'Keys you save here are added to each project when it starts.' : 'Start a project to store a key on it.'}
        </p>
      ) : (
        <table className="w-full border-separate border-spacing-0 rounded-[10px] border border-border text-[12.5px]" data-testid="api-keys-projects">
          <thead>
            <tr className="text-left text-[11.5px] text-text-3">
              <th className="px-4 py-2 font-medium">Project</th>
              {KEY_PROVIDERS.map((k) => (
                <th key={k} className="px-4 py-2 font-medium">
                  {RUNS[k]} ({KEY_PROVIDER_LABEL[k]})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.projects.map((p) => (
              <tr key={p.cid} data-testid={`api-keys-project-${p.cid}`}>
                <td className="border-t border-border px-4 py-2 text-text">{p.name}</td>
                {KEY_PROVIDERS.map((k) => {
                  const v = p.providers[k]
                  return (
                    <td key={k} className="border-t border-border px-4 py-2" data-provider={k} data-state={v.state}>
                      <span className={STATE_TONE[v.state]}>{STATE_TEXT[v.state]}</span>
                      {(v.state === 'on' || v.state === 'off') && (
                        <span className="ml-1.5 font-mono text-[11.5px] text-text-3">{v.masked ?? 'stored'}</span>
                      )}
                      {v.state === 'failed' && v.reason ? <span className="block text-[11.5px] text-text-3">{v.reason}</span> : null}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
