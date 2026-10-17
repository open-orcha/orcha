/** Settings › API keys (main process): store an Anthropic / OpenAI key on EVERY running project
 *  and switch its agent-run use, through each project's own portal:
 *
 *    GET  /api/containers                                            the projects in a stack
 *    GET  /api/containers/{cid}                                      its humans (the actor)
 *    GET  /api/containers/{cid}/settings/provider-keys               stored / use_for_agents / masked
 *    PUT  /api/containers/{cid}/settings/provider-keys/{provider}    {actor_agent_id, api_key}
 *    PUT  …/provider-keys/{provider}/agent-use                       {actor_agent_id, use_for_agents}
 *
 *  Same base URLs and headers as the plan-usage publisher (portalBases); the actor is YOUR human
 *  in that project (profileStore.pickSelf), like the Profile rename.
 *
 *  The key may also be remembered on this Mac — sealed with the OS Keychain (Electron
 *  safeStorage, injected as seal/unseal; never plaintext on disk) — so a project started later
 *  gets it too: a refresh stores it on any project that has no key and was never given one by
 *  this Mac (a key you remove in a project's own Settings is not pushed back).
 *
 *  SECRETS: the key leaves this module only in a PUT body to a localhost portal. It is never
 *  logged, never in a returned state or error (failure reasons are fixed phrases chosen by HTTP
 *  status — a portal's 422 echoes its input, so its detail is never read for key writes). */
import {
  apiBillingOf,
  displayMasked,
  KEY_PROVIDERS,
  maskFromHint,
  normalizeApiKey,
  type KeyProvider,
  type ProjectKeyStatus,
  type ProjectProviderKey,
  type ProviderKeysInput,
  type ProviderKeysState,
  type RememberedKey
} from '../shared/providerKeys'
import type { Stack } from '../shared/types'
import { pickSelf } from './profileStore'

const TIMEOUT_MS = 8000

export interface ProviderKeysDeps {
  listStacks(): Promise<Stack[]>
  fetch: typeof fetch
  /** The name you appear as (Settings › Profile) — tells which human is you. */
  profileName(): string
  /** The remembered file's content (any shape; validated here), null when absent. */
  load(): unknown
  save(data: RememberedFile): void
  /** This Mac can encrypt for disk (Keychain-backed safeStorage). */
  canSeal(): boolean
  /** Encrypt for disk (base64), null when this Mac can't (then nothing is remembered). */
  seal(plain: string): string | null
  unseal(sealed: string): string | null
  /** Which agent CLIs bill an API key now (any project `on`). */
  onBilling(b: { claude: boolean; codex: boolean }): void
  now(): number
  log?(msg: string): void
}

/** <userData>/provider-keys.json. `sealed` is safeStorage ciphertext, never the key. */
export interface RememberedFile {
  version: 1
  providers: Partial<Record<KeyProvider, { useForAgents: boolean; sealed: string | null; last4: string | null }>>
  /** Projects (cid) this Mac already gave each provider's key to. */
  applied: Partial<Record<KeyProvider, string[]>>
}

interface Project {
  base: string
  cid: string
  name: string
  stack: string
}

type Status = number | 'network'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseRememberedFile(raw: unknown): RememberedFile {
  const out: RememberedFile = { version: 1, providers: {}, applied: {} }
  if (!isRecord(raw)) return out
  if (isRecord(raw.providers))
    for (const k of KEY_PROVIDERS) {
      const v = raw.providers[k]
      if (!isRecord(v) || typeof v.useForAgents !== 'boolean') continue
      out.providers[k] = {
        useForAgents: v.useForAgents,
        sealed: typeof v.sealed === 'string' && v.sealed ? v.sealed : null,
        last4: typeof v.last4 === 'string' && /^[\w-]{1,8}$/.test(v.last4) ? v.last4 : null
      }
    }
  if (isRecord(raw.applied))
    for (const k of KEY_PROVIDERS) {
      const v = raw.applied[k]
      if (Array.isArray(v)) out.applied[k] = v.filter((x): x is string => typeof x === 'string').slice(0, 500)
    }
  return out
}

/** A key write's failure in plain words — by status only (never the portal's body). */
export function writeFailure(status: Status): string {
  if (status === 'network') return 'the project didn’t answer'
  if (status === 401 || status === 403) return 'you can’t manage keys on this project'
  if (status === 404) return 'this project’s Embodent is too old for API keys — update it'
  if (status === 503) return 'this project can’t store keys (encrypted storage is off)'
  if (status === 400 || status === 422) return 'the project didn’t accept the key'
  return `the project answered ${status}`
}

const failed = (reason: string): ProjectProviderKey => ({ state: 'failed', masked: null, reason })
const allFailed = (reason: string): Record<KeyProvider, ProjectProviderKey> => ({ anthropic: failed(reason), openai: failed(reason) })

export interface ProviderKeys {
  get(): ProviderKeysState
  refresh(): Promise<ProviderKeysState>
  save(input: ProviderKeysInput): Promise<ProviderKeysState>
}

export function createProviderKeys(deps: ProviderKeysDeps): ProviderKeys {
  const log = deps.log ?? ((m: string) => console.warn(m))
  let file = parseRememberedFile(deps.load())
  let projects: ProjectKeyStatus[] = []
  let checkedAt: number | null = null
  let canRemember = deps.canSeal()
  let chain: Promise<unknown> = Promise.resolve()
  /** Serialise refresh/save: a save never interleaves with a refresh's writes. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  const request = async (url: string, method: 'GET' | 'PUT', body?: unknown): Promise<{ status: Status; json: unknown }> => {
    try {
      const res = await deps.fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!res.ok) return { status: res.status, json: null }
      const json = method === 'GET' ? await res.json().catch(() => null) : null
      return { status: res.status, json }
    } catch {
      return { status: 'network', json: null }
    }
  }

  const listProjects = async (): Promise<Project[]> => {
    let stacks: Stack[] = []
    try {
      stacks = await deps.listStacks()
    } catch {
      return []
    }
    const seen = new Set<string>()
    const out: Project[] = []
    for (const s of stacks) {
      if (!s.running || s.apiPort === null) continue
      const base = `http://localhost:${s.apiPort}`
      if (seen.has(base)) continue
      seen.add(base)
      const { json } = await request(`${base}/api/containers`, 'GET')
      const list = isRecord(json) && Array.isArray(json.containers) ? json.containers : []
      for (const c of list) {
        if (!isRecord(c) || typeof c.id !== 'string' || !c.id) continue
        if (c.status === 'completed' || c.status === 'cancelled') continue
        out.push({ base, cid: c.id, name: typeof c.name === 'string' && c.name ? c.name : s.projectShort, stack: s.projectShort })
      }
    }
    return out
  }

  const keysPath = (p: Project): string => `${p.base}/api/containers/${encodeURIComponent(p.cid)}/settings/provider-keys`

  /** One project's key state per provider (read-only). */
  const readProject = async (p: Project): Promise<Record<KeyProvider, ProjectProviderKey>> => {
    const { status, json } = await request(keysPath(p), 'GET')
    if (status === 404) return allFailed('this project’s Embodent is too old for API keys — update it')
    if (status !== 200 || !isRecord(json) || !Array.isArray(json.keys)) return allFailed('couldn’t read this project’s keys')
    const out = {} as Record<KeyProvider, ProjectProviderKey>
    for (const k of KEY_PROVIDERS) {
      const row = json.keys.find((r): r is Record<string, unknown> => isRecord(r) && r.provider === k)
      if (!row || typeof row.stored !== 'boolean') {
        out[k] = failed('this project’s Embodent is too old for API-key agent runs — update it')
        continue
      }
      // `masked` may describe an env override; only a stored (db) key is ours to show.
      const masked = row.stored && row.source === 'db' ? displayMasked(row.masked) : null
      out[k] = { state: !row.stored ? 'no-key' : row.use_for_agents === true ? 'on' : 'off', masked }
    }
    return out
  }

  /** YOUR human in a project, or a reason why it can't be told. */
  const actorOf = async (p: Project): Promise<{ id: string } | { reason: string }> => {
    const { status, json } = await request(`${p.base}/api/containers/${encodeURIComponent(p.cid)}`, 'GET')
    if (status !== 200 || !isRecord(json)) return { reason: 'couldn’t read this project' }
    const agents = Array.isArray(json.agents) ? json.agents.filter((a): a is { id: string; kind: string; alias?: string; status?: string } => isRecord(a) && typeof a.id === 'string' && typeof a.kind === 'string') : []
    const self = pickSelf(agents, deps.profileName())
    return self ? { id: self.id } : { reason: 'couldn’t tell which person is you in this project' }
  }

  const putKey = async (p: Project, provider: KeyProvider, actor: string, apiKey: string): Promise<Status> =>
    (await request(`${keysPath(p)}/${provider}`, 'PUT', { actor_agent_id: actor, api_key: apiKey })).status

  const putUse = async (p: Project, provider: KeyProvider, actor: string, on: boolean): Promise<Status> =>
    (await request(`${keysPath(p)}/${provider}/agent-use`, 'PUT', { actor_agent_id: actor, use_for_agents: on })).status

  const markApplied = (provider: KeyProvider, cid: string): void => {
    const list = file.applied[provider] ?? []
    if (!list.includes(cid)) file.applied[provider] = [...list, cid].slice(-500)
  }

  const persist = (): void => {
    try {
      deps.save(file)
    } catch {
      log('[provider-keys] couldn’t save settings')
    }
  }

  const remembered = (): Record<KeyProvider, RememberedKey> => {
    const out = {} as Record<KeyProvider, RememberedKey>
    for (const k of KEY_PROVIDERS) {
      const r = file.providers[k]
      out[k] = { remembered: !!r?.sealed, masked: r ? maskFromHint(k, r.last4) : null, useForAgents: r?.useForAgents ?? false }
    }
    return out
  }

  const state = (): ProviderKeysState => ({
    providers: remembered(),
    projects: projects.map((p) => ({ ...p, providers: { ...p.providers } })),
    canRemember,
    checkedAt
  })

  const publish = (list: ProjectKeyStatus[]): void => {
    projects = list
    checkedAt = deps.now()
    // With nothing reachable the last known billing stands (no flicker while stacks restart).
    if (list.some((p) => KEY_PROVIDERS.some((k) => p.providers[k].state !== 'failed'))) deps.onBilling(apiBillingOf(list))
  }

  /** Give a remembered key to every project that has none and never got one from this Mac. */
  const fillNewProjects = async (list: Project[], read: Record<KeyProvider, ProjectProviderKey>[]): Promise<void> => {
    let changed = false
    await Promise.all(
      list.map(async (p, i) => {
        const missing = KEY_PROVIDERS.filter((k) => {
          const r = file.providers[k]
          return r?.sealed && read[i][k].state === 'no-key' && !(file.applied[k] ?? []).includes(p.cid)
        })
        if (missing.length === 0) return
        const actor = await actorOf(p)
        if (!('id' in actor)) return
        for (const k of missing) {
          const r = file.providers[k]!
          const key = r.sealed ? deps.unseal(r.sealed) : null
          if (!key) continue
          const s = await putKey(p, k, actor.id, key)
          if (s !== 200) {
            log(`[provider-keys] adding the ${k} key to ${p.stack} -> ${s}`)
            continue
          }
          markApplied(k, p.cid)
          changed = true
          if (r.useForAgents) await putUse(p, k, actor.id, true)
          read[i][k] = await readProject(p).then((x) => x[k])
        }
      })
    )
    if (changed) persist()
  }

  const refreshNow = async (): Promise<ProviderKeysState> => {
    canRemember = deps.canSeal()
    const list = await listProjects()
    const read = await Promise.all(list.map(readProject))
    await fillNewProjects(list, read)
    publish(list.map((p, i) => ({ cid: p.cid, name: p.name, stack: p.stack, providers: read[i] })))
    return state()
  }

  const saveNow = async (input: ProviderKeysInput): Promise<ProviderKeysState> => {
    canRemember = deps.canSeal()
    // Remember first (switch + sealed key), so a project started later gets the same setup.
    for (const k of KEY_PROVIDERS) {
      const v = input[k]
      if (!v) continue
      const prev = file.providers[k]
      const key = v.apiKey !== undefined ? normalizeApiKey(v.apiKey) : null
      if (key) {
        const sealed = deps.seal(key)
        file.providers[k] = { useForAgents: v.useForAgents, sealed, last4: sealed ? key.slice(-4) : null }
        file.applied[k] = [] // a new key goes to every project again
      } else {
        file.providers[k] = { useForAgents: v.useForAgents, sealed: prev?.sealed ?? null, last4: prev?.last4 ?? null }
      }
    }
    persist()

    const list = await listProjects()
    const results = await Promise.all(
      list.map(async (p): Promise<ProjectKeyStatus> => {
        const writeErrors: Partial<Record<KeyProvider, string>> = {}
        const actor = await actorOf(p)
        if (!('id' in actor)) {
          return { cid: p.cid, name: p.name, stack: p.stack, providers: allFailed(actor.reason) }
        }
        for (const k of KEY_PROVIDERS) {
          const v = input[k]
          if (!v) continue
          if (v.apiKey !== undefined) {
            const s = await putKey(p, k, actor.id, v.apiKey)
            if (s !== 200) {
              log(`[provider-keys] storing the ${k} key on ${p.stack} -> ${s}`)
              writeErrors[k] = writeFailure(s)
              continue
            }
            markApplied(k, p.cid)
          }
          const s = await putUse(p, k, actor.id, v.useForAgents)
          // 409: nothing stored here — reported as "no key" by the re-read, not as a failure.
          if (s !== 200 && s !== 409) {
            log(`[provider-keys] agent-use ${k} on ${p.stack} -> ${s}`)
            writeErrors[k] = writeFailure(s)
          }
        }
        const read = await readProject(p)
        for (const k of KEY_PROVIDERS) {
          const reason = writeErrors[k]
          if (reason) read[k] = { state: 'failed', masked: read[k].masked, reason }
        }
        return { cid: p.cid, name: p.name, stack: p.stack, providers: read }
      })
    )
    persist()
    publish(results)
    return state()
  }

  return {
    get: state,
    refresh: () => serial(refreshNow),
    save: (input) => serial(() => saveNow(input))
  }
}
