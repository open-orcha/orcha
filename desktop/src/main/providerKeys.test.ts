import { describe, it, expect, vi } from 'vitest'
import { createProviderKeys, parseRememberedFile, writeFailure, type ProviderKeysDeps, type RememberedFile } from './providerKeys'
import { apiBillingOf, displayMasked, maskFromHint, parseProviderKeysInput } from '../shared/providerKeys'
import type { Stack } from '../shared/types'

const ANT = 'sk-ant-api03-SECRETSECRETSECRET-wxyz'
const OAI = 'sk-proj-OPENAISECRETSECRET-9876'

const stack = (port: number, short: string, running = true): Stack => ({
  project: `orcha-${short}`,
  projectShort: short,
  apiPort: running ? port : null,
  dbPort: null,
  portalStatus: running ? 'Up 1 hour' : 'Exited (0)',
  running,
  folder: null,
  runtime: 'docker',
  health: 'ok'
})

interface Row {
  stored: boolean
  use: boolean
  hint: string | null
}

/** A fake portal: containers per port, each with humans and provider-key rows. Records every
 *  request (method, url, body) — the only place a key may appear is a PUT body. */
function fakePortals(spec: Record<number, { cid: string; name: string; humans?: { id: string; alias: string }[]; rows?: Partial<Record<'anthropic' | 'openai', Row>>; keyStatus?: number; useStatus?: number; oldPortal?: boolean }[]>) {
  const calls: { method: string; url: string; body: unknown }[] = []
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const m = url.match(/^http:\/\/localhost:(\d+)(\/api\/.*)$/)
    if (!m) return json(404, {})
    const list = spec[Number(m[1])] ?? []
    const path = m[2]
    if (path === '/api/containers') return json(200, { containers: list.map((c) => ({ id: c.cid, name: c.name, status: 'active' })) })
    const c = list.find((x) => path.startsWith(`/api/containers/${x.cid}`))
    if (!c) return json(404, {})
    const rest = path.slice(`/api/containers/${c.cid}`.length)
    if (rest === '' && method === 'GET') return json(200, { agents: (c.humans ?? [{ id: `h-${c.cid}`, alias: 'alice' }]).map((h) => ({ ...h, kind: 'human' })) })
    if (rest === '/settings/provider-keys' && method === 'GET') {
      if (c.oldPortal) return json(404, { detail: 'Not Found' })
      const rows = c.rows ?? {}
      return json(200, {
        keys: [
          { provider: 'anthropic', name: 'Anthropic', configured: !!rows.anthropic?.stored, source: rows.anthropic?.stored ? 'db' : null, masked: rows.anthropic?.hint ? `sk-ant-...${rows.anthropic.hint}` : null, stored: !!rows.anthropic?.stored, use_for_agents: !!rows.anthropic?.use, agent_runtime: 'claude', agent_only: false },
          { provider: 'xai', name: 'xAI', configured: false, source: null, masked: null, stored: false, use_for_agents: false, agent_runtime: null, agent_only: false },
          { provider: 'openai', name: 'OpenAI', configured: !!rows.openai?.stored, source: rows.openai?.stored ? 'db' : null, masked: rows.openai?.hint ? `sk-...${rows.openai.hint}` : null, stored: !!rows.openai?.stored, use_for_agents: !!rows.openai?.use, agent_runtime: 'codex', agent_only: true }
        ]
      })
    }
    const key = rest.match(/^\/settings\/provider-keys\/(anthropic|openai)$/)
    if (key && method === 'PUT') {
      const status = c.keyStatus ?? 200
      // A real 422 echoes the input — the module must never surface it.
      if (status !== 200) return json(status, { detail: [{ msg: 'bad', input: (body as { api_key: string }).api_key }] })
      const k = key[1] as 'anthropic' | 'openai'
      c.rows = { ...(c.rows ?? {}), [k]: { stored: true, use: c.rows?.[k]?.use ?? false, hint: (body as { api_key: string }).api_key.slice(-4) } }
      return json(200, { configured: true, source: 'db', provider: k, masked: `sk-...${(body as { api_key: string }).api_key.slice(-4)}` })
    }
    const use = rest.match(/^\/settings\/provider-keys\/(anthropic|openai)\/agent-use$/)
    if (use && method === 'PUT') {
      if (c.useStatus) return json(c.useStatus, { detail: 'nope' })
      const k = use[1] as 'anthropic' | 'openai'
      const row = c.rows?.[k]
      if (!row?.stored) return json(409, { detail: 'store an API key for this provider first' })
      row.use = (body as { use_for_agents: boolean }).use_for_agents
      return json(200, { provider: k, use_for_agents: row.use, agent_runtime: k === 'anthropic' ? 'claude' : 'codex' })
    }
    return json(404, {})
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, spec }
}

function setup(stacks: Stack[], portals: ReturnType<typeof fakePortals>, over: Partial<ProviderKeysDeps> = {}) {
  let saved: RememberedFile | null = null
  const logs: string[] = []
  const billing: { claude: boolean; codex: boolean }[] = []
  const deps: ProviderKeysDeps = {
    listStacks: async () => stacks,
    fetch: portals.fetch,
    profileName: () => 'alice',
    load: () => saved,
    save: (d) => (saved = JSON.parse(JSON.stringify(d))),
    canSeal: () => true,
    seal: (p) => Buffer.from(`sealed:${p}`).toString('base64'),
    unseal: (s) => Buffer.from(s, 'base64').toString().replace(/^sealed:/, ''),
    onBilling: (b) => billing.push(b),
    now: () => 1000,
    log: (m) => logs.push(m),
    ...over
  }
  return { keys: createProviderKeys(deps), logs, billing, saved: () => saved }
}

describe('Settings › API keys (main)', () => {
  it('stores the key on EVERY running project, then PUTs agent-use, as your human', async () => {
    const portals = fakePortals({
      8001: [
        { cid: 'c1', name: 'todo-app' },
        { cid: 'c2', name: 'second', humans: [{ id: 'bob-id', alias: 'bob' }, { id: 'me-id', alias: 'alice' }] }
      ],
      8002: [{ cid: 'c3', name: 'shop' }]
    })
    const { keys, billing } = setup([stack(8001, 'todo-app'), stack(8002, 'shop'), stack(8003, 'stopped', false)], portals)
    const s = await keys.save({ anthropic: { apiKey: ANT, useForAgents: true } })

    const puts = portals.calls.filter((c) => c.method === 'PUT')
    expect(puts.map((c) => c.url)).toEqual(
      expect.arrayContaining([
        'http://localhost:8001/api/containers/c1/settings/provider-keys/anthropic',
        'http://localhost:8001/api/containers/c1/settings/provider-keys/anthropic/agent-use',
        'http://localhost:8001/api/containers/c2/settings/provider-keys/anthropic',
        'http://localhost:8001/api/containers/c2/settings/provider-keys/anthropic/agent-use',
        'http://localhost:8002/api/containers/c3/settings/provider-keys/anthropic',
        'http://localhost:8002/api/containers/c3/settings/provider-keys/anthropic/agent-use'
      ])
    )
    expect(puts).toHaveLength(6)
    // key first, then the switch — per project
    const c1 = puts.filter((c) => c.url.includes('/c1/')).map((c) => c.url.split('/').pop())
    expect(c1).toEqual(['anthropic', 'agent-use'])
    expect(puts.find((c) => c.url.endsWith('/c1/settings/provider-keys/anthropic'))!.body).toEqual({ actor_agent_id: 'h-c1', api_key: ANT })
    expect(puts.find((c) => c.url.endsWith('/c2/settings/provider-keys/anthropic/agent-use'))!.body).toEqual({ actor_agent_id: 'me-id', use_for_agents: true })
    // nothing for the stopped stack, and nothing for OpenAI (not in the save)
    expect(portals.calls.some((c) => c.url.includes(':8003'))).toBe(false)
    expect(puts.some((c) => c.url.includes('/openai'))).toBe(false)

    expect(s.projects.map((p) => [p.name, p.providers.anthropic.state, p.providers.anthropic.masked])).toEqual([
      ['todo-app', 'on', 'sk-ant-…wxyz'],
      ['second', 'on', 'sk-ant-…wxyz'],
      ['shop', 'on', 'sk-ant-…wxyz']
    ])
    expect(s.projects[0].providers.openai.state).toBe('no-key')
    expect(billing.at(-1)).toEqual({ claude: true, codex: false })
  })

  it('switch only (no key typed): PUTs agent-use; a project with no key reports "no key", not a failure', async () => {
    const portals = fakePortals({
      8001: [
        { cid: 'c1', name: 'a', rows: { openai: { stored: true, use: true, hint: '9876' } } },
        { cid: 'c2', name: 'b' }
      ]
    })
    const { keys, billing } = setup([stack(8001, 'a')], portals)
    const s = await keys.save({ openai: { useForAgents: false } })
    const puts = portals.calls.filter((c) => c.method === 'PUT')
    expect(puts.map((c) => [c.url.split('/api/containers/')[1], c.body])).toEqual([
      ['c1/settings/provider-keys/openai/agent-use', { actor_agent_id: 'h-c1', use_for_agents: false }],
      ['c2/settings/provider-keys/openai/agent-use', { actor_agent_id: 'h-c2', use_for_agents: false }]
    ])
    expect(s.projects.map((p) => p.providers.openai.state)).toEqual(['off', 'no-key'])
    expect(s.projects[0].providers.openai.masked).toBe('sk-…9876')
    expect(billing.at(-1)).toEqual({ claude: false, codex: false })
  })

  it('reports per-project failures in plain words and never the key — not in state, errors or logs', async () => {
    const portals = fakePortals({
      8001: [{ cid: 'c1', name: 'refuses', keyStatus: 422 }],
      8002: [{ cid: 'c2', name: 'no-master-key', keyStatus: 503 }],
      8003: [{ cid: 'c3', name: 'old', oldPortal: true, keyStatus: 404 }],
      8004: [{ cid: 'c4', name: 'stranger', humans: [{ id: 'x', alias: 'x' }, { id: 'y', alias: 'y' }] }]
    })
    const { keys, logs, saved } = setup([stack(8001, 'refuses'), stack(8002, 'nmk'), stack(8003, 'old'), stack(8004, 'stranger')], portals)
    const s = await keys.save({ anthropic: { apiKey: ANT, useForAgents: true }, openai: { apiKey: OAI, useForAgents: true } })
    const byName = Object.fromEntries(s.projects.map((p) => [p.name, p.providers.anthropic]))
    expect(byName.refuses).toEqual({ state: 'failed', masked: null, reason: 'the project didn’t accept the key' })
    expect(byName['no-master-key'].reason).toBe('this project can’t store keys (encrypted storage is off)')
    expect(byName.old.state).toBe('failed')
    expect(byName.old.reason).toMatch(/too old/)
    expect(byName.stranger.reason).toBe('couldn’t tell which person is you in this project')
    // no agent-use after a failed key write
    expect(portals.calls.some((c) => c.url.endsWith('/c1/settings/provider-keys/anthropic/agent-use'))).toBe(false)

    const everything = JSON.stringify(s) + JSON.stringify(keys.get()) + logs.join('\n') + JSON.stringify(saved())
    for (const secret of [ANT, OAI, 'SECRETSECRET']) expect(everything).not.toContain(secret)
    expect(logs.length).toBeGreaterThan(0)
    // the key only ever travelled in a PUT body to a localhost portal
    for (const c of portals.calls) {
      if (c.method === 'GET') expect(c.url + JSON.stringify(c.body ?? '')).not.toContain('SECRET')
      expect(c.url).toMatch(/^http:\/\/localhost:\d+\/api\//)
    }
  })

  it('remembers the key only sealed, and gives it to a project started later — once', async () => {
    const portals = fakePortals({ 8001: [{ cid: 'c1', name: 'first' }] })
    const stacks = [stack(8001, 'first')]
    const { keys, saved } = setup(stacks, portals)
    await keys.save({ anthropic: { apiKey: ANT, useForAgents: true } })
    const file = saved()!
    expect(JSON.stringify(file)).not.toContain(ANT)
    expect(file.providers.anthropic).toMatchObject({ useForAgents: true, last4: 'wxyz' })
    expect(file.applied.anthropic).toEqual(['c1'])
    expect(keys.get().providers.anthropic).toEqual({ remembered: true, masked: 'sk-ant-…wxyz', useForAgents: true })

    // a new project appears
    portals.spec[8002] = [{ cid: 'c2', name: 'later' }]
    stacks.push(stack(8002, 'later'))
    portals.calls.length = 0
    const s = await keys.refresh()
    const puts = portals.calls.filter((c) => c.method === 'PUT').map((c) => c.url.split('/api/containers/')[1])
    expect(puts).toEqual(['c2/settings/provider-keys/anthropic', 'c2/settings/provider-keys/anthropic/agent-use'])
    expect(s.projects.find((p) => p.cid === 'c2')!.providers.anthropic.state).toBe('on')

    // the user removes it in that project's own Settings: it is not pushed back
    portals.spec[8002][0].rows = {}
    portals.calls.length = 0
    const again = await keys.refresh()
    expect(portals.calls.filter((c) => c.method === 'PUT')).toEqual([])
    expect(again.projects.find((p) => p.cid === 'c2')!.providers.anthropic.state).toBe('no-key')
  })

  it('without Keychain encryption nothing is remembered, but projects still get the key', async () => {
    const portals = fakePortals({ 8001: [{ cid: 'c1', name: 'a' }] })
    const { keys, saved } = setup([stack(8001, 'a')], portals, { canSeal: () => false, seal: () => null })
    const s = await keys.save({ anthropic: { apiKey: ANT, useForAgents: false } })
    expect(s.canRemember).toBe(false)
    expect(s.providers.anthropic.remembered).toBe(false)
    expect(saved()!.providers.anthropic).toEqual({ useForAgents: false, sealed: null, last4: null })
    expect(s.projects[0].providers.anthropic).toEqual({ state: 'off', masked: 'sk-ant-…wxyz' })
  })

  it('refresh reads on/off/no-key; billing is kept while nothing answers', async () => {
    const portals = fakePortals({ 8001: [{ cid: 'c1', name: 'a', rows: { anthropic: { stored: true, use: true, hint: null } } }] })
    const stacks = [stack(8001, 'a')]
    const { keys, billing } = setup(stacks, portals)
    const s = await keys.refresh()
    expect(s.projects[0].providers).toEqual({ anthropic: { state: 'on', masked: null }, openai: { state: 'no-key', masked: null } })
    expect(billing).toEqual([{ claude: true, codex: false }])
    stacks.length = 0
    await keys.refresh()
    expect(billing).toHaveLength(1)
  })
})

describe('provider-key helpers', () => {
  it('parses the save body strictly; a blank key means "keep the stored one"', () => {
    expect(parseProviderKeysInput({ anthropic: { apiKey: `  ${ANT}\n`, useForAgents: true } })).toEqual({ anthropic: { apiKey: ANT, useForAgents: true } })
    expect(parseProviderKeysInput({ openai: { apiKey: '', useForAgents: false } })).toEqual({ openai: { useForAgents: false } })
    expect(parseProviderKeysInput({ xai: { useForAgents: true } })).toBeNull()
    expect(parseProviderKeysInput({ anthropic: { useForAgents: 'yes' } })).toBeNull()
    expect(parseProviderKeysInput({ anthropic: { apiKey: 'sk ant', useForAgents: true } })).toBeNull()
    expect(parseProviderKeysInput({ anthropic: { apiKey: 'x'.repeat(513), useForAgents: true } })).toBeNull()
    expect(parseProviderKeysInput({ anthropic: { useForAgents: true, extra: 1 } })).toBeNull()
    expect(parseProviderKeysInput({})).toBeNull()
  })

  it('masks keys as the portal hint with an ellipsis, else nothing', () => {
    expect(displayMasked('sk-ant-...abcd')).toBe('sk-ant-…abcd')
    expect(displayMasked(null)).toBeNull()
    expect(maskFromHint('openai', '1234')).toBe('sk-…1234')
    expect(maskFromHint('anthropic', null)).toBeNull()
  })

  it('fixed failure phrases by status', () => {
    expect(writeFailure('network')).toBe('the project didn’t answer')
    expect(writeFailure(403)).toBe('you can’t manage keys on this project')
    expect(writeFailure(500)).toBe('the project answered 500')
  })

  it('billing: a CLI bills a key when any project has it on', () => {
    const p = (a: 'on' | 'off', o: 'on' | 'no-key') => ({ cid: 'c', name: 'n', stack: 's', providers: { anthropic: { state: a, masked: null }, openai: { state: o, masked: null } } })
    expect(apiBillingOf([p('off', 'no-key'), p('on', 'no-key')])).toEqual({ claude: true, codex: false })
    expect(apiBillingOf([p('off', 'on')])).toEqual({ claude: false, codex: true })
  })

  it('a malformed remembered file is ignored field by field', () => {
    expect(parseRememberedFile({ providers: { anthropic: { useForAgents: 'x' }, openai: { useForAgents: true, sealed: 'abc', last4: '12 34' } }, applied: { openai: ['c1', 2] } })).toEqual({
      version: 1,
      providers: { openai: { useForAgents: true, sealed: 'abc', last4: null } },
      applied: { openai: ['c1'] }
    })
  })
})
