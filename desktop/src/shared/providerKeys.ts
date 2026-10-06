/** Settings › API keys: bill agent runs to an Anthropic / OpenAI API key instead of a Claude or
 *  ChatGPT subscription.
 *
 *  PURE module (no Electron / Node imports) shared by main, the index preload (types +
 *  inlined channel names) and the renderer.
 *
 *  The key is entered ONCE on this Mac. Main stores it on EVERY connected project through the
 *  project's own portal (`PUT /api/containers/{cid}/settings/provider-keys/{provider}`, sealed
 *  server-side) and switches its agent-run use on or off
 *  (`PUT …/provider-keys/{provider}/agent-use`). The notifier then puts the key into each Claude
 *  run (ANTHROPIC_API_KEY) or Codex run (CODEX_API_KEY + OPENAI_API_KEY) on that project.
 *
 *  SECRET RULE: a key crosses IPC exactly once, renderer → main, inside `save()`. Nothing main
 *  returns ever carries it — only the portal's masked hint (`sk-ant-…abcd`) or "stored". */

/** The providers whose key can serve an agent runtime (portal AGENT_KEY_RUNTIME). */
export type KeyProvider = 'anthropic' | 'openai'

export const KEY_PROVIDERS: readonly KeyProvider[] = ['anthropic', 'openai']

/** The usage provider (agent CLI) each key bills: anthropic → Claude, openai → Codex. */
export const KEY_PROVIDER_AGENT: Record<KeyProvider, 'claude' | 'codex'> = { anthropic: 'claude', openai: 'codex' }

export const KEY_PROVIDER_LABEL: Record<KeyProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

/** The portal's own cap (LlmKeyUpdate.api_key max_length). */
export const MAX_API_KEY_LEN = 512

/** One project's state for one provider.
 *  - `on`: a key is stored and agent runs bill it.
 *  - `off`: a key is stored but agent runs use the subscription.
 *  - `no-key`: no key stored on this project.
 *  - `failed`: the project couldn't be read or refused the change (`reason` says why). */
export type ProjectKeyState = 'on' | 'off' | 'no-key' | 'failed'

export interface ProjectProviderKey {
  state: ProjectKeyState
  /** `sk-ant-…abcd` when the portal returned a hint, else null (the UI says "stored"). */
  masked: string | null
  /** Plain words, never a key. */
  reason?: string
}

export interface ProjectKeyStatus {
  /** Container id (a project; a stack can hold several). */
  cid: string
  /** Project display name. */
  name: string
  /** The stack (compose project, short form) it runs in. */
  stack: string
  providers: Record<KeyProvider, ProjectProviderKey>
}

/** What this Mac remembers for a provider (to add the key to projects started later). */
export interface RememberedKey {
  /** A key is remembered (encrypted with the macOS Keychain) for new projects. */
  remembered: boolean
  /** Its masked hint, `sk-ant-…abcd`, or null. */
  masked: string | null
  /** The "Use for agent runs" switch as last saved. */
  useForAgents: boolean
}

export interface ProviderKeysState {
  providers: Record<KeyProvider, RememberedKey>
  /** Every running project, with each provider's state. */
  projects: ProjectKeyStatus[]
  /** This Mac can encrypt keys to remember them for projects started later. */
  canRemember: boolean
  /** When the projects were last read (epoch ms), null = not yet. */
  checkedAt: number | null
}

/** One provider's part of a save. `apiKey` absent = keep the stored key, only (re)apply the switch. */
export interface ProviderKeyInput {
  apiKey?: string
  useForAgents: boolean
}

export type ProviderKeysInput = Partial<Record<KeyProvider, ProviderKeyInput>>

export interface ProviderKeysApi {
  /** The last known state (no network). */
  get(): Promise<ProviderKeysState>
  /** Re-read every running project. */
  refresh(): Promise<ProviderKeysState>
  /** Store the entered key(s) and the switch on every running project, then re-read. */
  save(input: ProviderKeysInput): Promise<ProviderKeysState>
}

export const PROVIDER_KEYS_CHANNELS = {
  get: 'orcha:providerKeys:get',
  refresh: 'orcha:providerKeys:refresh',
  save: 'orcha:providerKeys:save'
} as const

export function isKeyProvider(v: unknown): v is KeyProvider {
  return v === 'anthropic' || v === 'openai'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A pasted key: trimmed; no inner whitespace or control characters; within the portal's cap. */
export function normalizeApiKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  if (!key || key.length > MAX_API_KEY_LEN) return null
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return null
  return key
}

/** Strict save body (the IPC argument), else null. A blank `apiKey` means "keep the stored one". */
export function parseProviderKeysInput(raw: unknown): ProviderKeysInput | null {
  if (!isRecord(raw)) return null
  const out: ProviderKeysInput = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!isKeyProvider(k) || !isRecord(v)) return null
    if (Object.keys(v).some((x) => x !== 'apiKey' && x !== 'useForAgents')) return null
    if (typeof v.useForAgents !== 'boolean') return null
    const entry: ProviderKeyInput = { useForAgents: v.useForAgents }
    if (v.apiKey !== undefined && v.apiKey !== null && !(typeof v.apiKey === 'string' && v.apiKey.trim() === '')) {
      const key = normalizeApiKey(v.apiKey)
      if (!key) return null
      entry.apiKey = key
    }
    out[k] = entry
  }
  return Object.keys(out).length > 0 ? out : null
}

const KEY_PREFIX: Record<KeyProvider, string> = { anthropic: 'sk-ant-', openai: 'sk-' }

/** `sk-ant-…abcd` from the last four characters, or null when there are none. */
export function maskFromHint(provider: KeyProvider, last4: string | null | undefined): string | null {
  if (!last4) return null
  return `${KEY_PREFIX[provider]}…${last4}`
}

/** The portal's masked hint (`sk-ant-...abcd`) in display form (`sk-ant-…abcd`), else null. */
export function displayMasked(masked: unknown): string | null {
  if (typeof masked !== 'string' || !masked) return null
  return masked.replace('...', '…')
}

/** Which agent CLIs bill an API key on at least one project (`on`). */
export function apiBillingOf(projects: readonly ProjectKeyStatus[]): { claude: boolean; codex: boolean } {
  const out = { claude: false, codex: false }
  for (const p of projects)
    for (const k of KEY_PROVIDERS) if (p.providers[k].state === 'on') out[KEY_PROVIDER_AGENT[k]] = true
  return out
}
