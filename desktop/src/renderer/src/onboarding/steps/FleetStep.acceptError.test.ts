import { describe, it, expect } from 'vitest'
import { acceptFailureMessage, describeAcceptError, withoutExisting } from './FleetStep'

describe('describeAcceptError — never a reasonless failure', () => {
  it('422 over the batch cap names the cap and what to do', () => {
    const r = describeAcceptError({ code: 'PORTAL_REQUEST_FAILED', status: 422, detail: 'List should have at most 5 items after validation, not 8' })
    expect(r.message).toContain('at most 5 agents at once')
    expect(r.detail).toContain('not 8')
  })
  it('403 says it is a permission problem', () => {
    expect(describeAcceptError({ status: 403 }).message).toMatch(/permission/)
  })
  it('409 points at a taken name', () => {
    expect(describeAcceptError({ status: 409, detail: "alias 'forge' is already taken" }).message).toMatch(/already taken/)
  })
  it('anything else keeps the reassuring fallback and still carries detail', () => {
    const r = describeAcceptError({ status: 500, detail: 'boom' })
    expect(r.message).toMatch(/project is fine/)
    expect(r.detail).toBe('boom')
  })
  it('non-object errors fall back safely', () => {
    expect(describeAcceptError(undefined).message).toMatch(/project is fine/)
  })
})

describe('partialAcceptOutcome — what a part-applied batch left behind (D-19b)', () => {
  it('splits attempted aliases into created-by-us and taken-before, case-insensitively', async () => {
    const { partialAcceptOutcome } = await import('./FleetStep')
    const r = partialAcceptOutcome(['newbie1', 'newbie2', 'Stripe-Guru'], new Set(['stripe-guru']), new Set(['stripe-guru', 'newbie1']))
    expect(r).toEqual({ created: ['newbie1'], taken: ['Stripe-Guru'] })
  })
})

describe('acceptFailureMessage — the request-level reason survives (D-19e)', () => {
  const cap = describeAcceptError({ status: 422, detail: 'List should have at most 13 items' })
  it('422 cap keeps the cap reason even when attempted aliases pre-existed', () => {
    const r = acceptFailureMessage(cap, 422, { created: [], taken: ['atlas', 'nova', 'rig', 'probe'] })
    expect(r.message).toMatch(/at most 13 agents at once/)
    expect(r.message).not.toMatch(/already taken/)
    expect(r.detail).toBe('List should have at most 13 items')
  })
  it('403 keeps the permission reason; a created part is prefixed, never replaces it', () => {
    const base = describeAcceptError({ status: 403 })
    expect(acceptFailureMessage(base, 403, { created: [], taken: ['x'] }).message).toMatch(/permission/)
    expect(acceptFailureMessage(base, 403, { created: ['a'], taken: [] }).message).toBe(`“a” was created. ${base.message}`)
  })
  it('409 names the taken aliases', () => {
    const base = describeAcceptError({ status: 409 })
    expect(acceptFailureMessage(base, 409, { created: ['a'], taken: ['b', 'c'] }).message).toBe(
      '“a” was created. “b”, “c” are already taken in this project. Uncheck them and try again.'
    )
  })
  it('a 500 never claims a name is taken; created → try again for the rest', () => {
    const base = describeAcceptError({ status: 500 })
    expect(acceptFailureMessage(base, 500, { created: [], taken: ['b'] })).toEqual(base)
    expect(acceptFailureMessage(base, 500, { created: ['a'], taken: ['b'] }).message).toBe('“a” was created. Try again to create the rest.')
  })
})

describe('withoutExisting (D-21)', () => {
  it('drops aliases already on the roster, case-insensitively', () => {
    const xs = [{ alias: 'Atlas' }, { alias: 'ripple' }, { alias: 'NOVA' }]
    expect(withoutExisting(xs, new Set(['atlas', 'nova']))).toEqual([{ alias: 'ripple' }])
  })
})
