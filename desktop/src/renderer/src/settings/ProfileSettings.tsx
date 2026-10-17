/** Settings › Profile: the name you appear as in your projects. Blank means this Mac's
 *  account name (what every project used before profiles). Saving stores it on this Mac —
 *  new projects register you with it — and main renames you in every running project,
 *  reporting any project it couldn't update. */
import { useEffect, useState, type FormEvent } from 'react'
import {
  MAX_PROFILE_NAME_LEN,
  type ProfileApi,
  type ProfileRenameResult,
  type ProfileState
} from '../../../shared/profile'

function summary(projects: ProfileRenameResult[]): string {
  const renamed = projects.filter((p) => p.status === 'renamed').length
  if (projects.length === 0) return 'Saved. New projects will use this name.'
  if (renamed === 0) return 'Saved.'
  return `Saved and updated in ${renamed} running project${renamed === 1 ? '' : 's'}.`
}

export default function ProfileSettings({ api = window.orchaDesktop?.profile }: { api?: ProfileApi }) {
  const [state, setState] = useState<ProfileState | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [problems, setProblems] = useState<ProfileRenameResult[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return
    let alive = true
    api.get().then(
      (s) => {
        if (!alive) return
        setState(s)
        setDraft(s.name ?? '')
      },
      () => alive && setError('Couldn’t read your profile.')
    )
    return () => {
      alive = false
    }
  }, [api])

  const trimmed = draft.trim().replace(/\s+/g, ' ')
  const dirty = !!state && trimmed !== (state.name ?? '')

  const save = (e: FormEvent): void => {
    e.preventDefault()
    if (!api || !dirty || saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    setProblems([])
    api.set(trimmed || null).then(
      ({ state: next, projects }) => {
        setState(next)
        setDraft(next.name ?? '')
        setNotice(summary(projects))
        setProblems(projects.filter((p) => p.status === 'failed' || p.status === 'skipped'))
        setSaving(false)
      },
      () => {
        setError('Couldn’t save your name. Try again.')
        setSaving(false)
      }
    )
  }

  return (
    <section data-testid="settings-profile">
      <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-text">Profile</h2>
      <p className="mb-6 mt-1 text-[13px] text-text-3">
        How you appear to your agents and teammates in every project on this Mac.
      </p>
      <form onSubmit={save} className="flex flex-col gap-3 rounded-[10px] border border-border px-4 py-4">
        <div className="min-w-0">
          <label htmlFor="profile-name" className="text-[13px] font-medium text-text">
            Name
          </label>
          <div className="text-[12px] text-text-3">
            {state
              ? `Leave blank to use this Mac’s name, “${state.deviceName}”.`
              : 'Leave blank to use this Mac’s name.'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            id="profile-name"
            data-testid="profile-name"
            value={draft}
            maxLength={MAX_PROFILE_NAME_LEN}
            placeholder={state?.deviceName ?? ''}
            disabled={!api || !state || saving}
            onChange={(e) => {
              setDraft(e.target.value)
              setNotice(null)
            }}
            className="h-8 w-full max-w-[320px] rounded-md border border-border bg-bg px-2.5 text-[13px] text-text outline-none placeholder:text-text-3 focus:border-accent disabled:opacity-60"
          />
          <button
            type="submit"
            data-testid="profile-save"
            disabled={!dirty || saving}
            className="h-8 shrink-0 rounded-md border border-border px-3 text-[13px] text-text hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {notice ? (
          <p role="status" data-testid="profile-notice" className="text-[12px] text-text-2">
            {notice}
          </p>
        ) : null}
        {problems.length > 0 ? (
          <ul data-testid="profile-problems" className="flex flex-col gap-0.5 text-[12px] text-text-3">
            {problems.map((p) => (
              <li key={p.project}>
                Not updated in {p.project}
                {p.reason ? ` — ${p.reason}` : ''}.
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  )
}
