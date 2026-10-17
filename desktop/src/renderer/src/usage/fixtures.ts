/** Test-only snapshot builders for the usage components. */
import { defaultUsagePrefs, ZERO_TOKENS, type LocalUsage, type ProviderUsage, type UsageSnapshot } from '../../../shared/usage'
import type { UsageValue } from './useUsage'

export const NOW = Date.parse('2026-09-30T15:00:00.000Z')

export function local(over: Partial<LocalUsage> = {}): LocalUsage {
  return {
    tokens: { ...ZERO_TOKENS, input: 1000, output: 500, cacheRead: 8000, cacheWrite: 500, reasoning: 100 },
    costUsd: 12.5,
    unpricedTokens: 0,
    sessions: 4,
    turns: 20,
    events: 60,
    models: [{ model: 'claude-opus-5-5', label: 'Opus 5.5', tokens: { ...ZERO_TOKENS, input: 1000, output: 500, cacheRead: 8000, cacheWrite: 500 }, costUsd: 12.5, events: 60 }],
    days: [
      { date: '2026-09-28', tokens: 8000, costUsd: 10 },
      { date: '2026-09-30', tokens: 2000, costUsd: 2.5 }
    ],
    prsCreated: 3,
    activeSeconds: 7200,
    firstSeen: Date.parse('2026-08-01T00:00:00Z'),
    lastSeen: NOW,
    ...over
  }
}

export function claude(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    id: 'claude',
    label: 'Claude',
    state: 'ok',
    installed: true,
    enabled: true,
    hasLogAdapter: true,
    hasLimits: true,
    limitsNeedOptIn: true,
    limitsEnabled: true,
    limitsExplainer: 'Reads Claude Code’s sign-in from your macOS Keychain…',
    limits: {
      status: 'ok',
      source: 'Anthropic usage API',
      fetchedAt: NOW,
      plan: 'Max',
      windows: [
        { key: '5h', label: '5h', usedPercent: 10, resetsAt: NOW + 105 * 60_000, windowMinutes: 300 },
        { key: 'wk', label: 'wk', usedPercent: 77, resetsAt: NOW + 3 * 86400_000, windowMinutes: 10080 },
        { key: 'wk:fable', label: 'Fable', usedPercent: 24, resetsAt: null, windowMinutes: 10080 }
      ]
    },
    local: local(),
    logPath: '~/.claude/projects',
    ...over
  }
}

export function codex(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    id: 'codex',
    label: 'Codex',
    state: 'ok',
    installed: true,
    enabled: true,
    hasLogAdapter: true,
    hasLimits: true,
    limitsNeedOptIn: false,
    limitsEnabled: true,
    limitsExplainer: null,
    limits: {
      status: 'ok',
      source: 'Codex session log',
      fetchedAt: NOW,
      plan: 'Plus',
      windows: [
        { key: 'primary', label: '5h', usedPercent: 0, resetsAt: NOW + 298 * 60_000, windowMinutes: 300 },
        { key: 'secondary', label: 'wk', usedPercent: 95, resetsAt: NOW + 86400_000, windowMinutes: 10080 }
      ]
    },
    local: local({ models: [{ model: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', tokens: ZERO_TOKENS, costUsd: 1, events: 3 }] }),
    logPath: '~/.codex/sessions',
    ...over
  }
}

export function gemini(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    id: 'gemini',
    label: 'Gemini CLI',
    state: 'not-installed',
    installed: false,
    enabled: true,
    hasLogAdapter: false,
    hasLimits: false,
    limitsNeedOptIn: false,
    limitsEnabled: true,
    limitsExplainer: null,
    limits: null,
    local: null,
    logPath: null,
    ...over
  }
}

export function snapshot(providers: ProviderUsage[], over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    updatedAt: NOW - 60_000,
    scanning: false,
    providers,
    app: { agentsSpawned: 7, agentSeconds: 5400, trackingSince: Date.parse('2026-09-01T00:00:00Z') },
    prefs: defaultUsagePrefs(),
    error: null,
    ...over
  }
}

export function usageValue(s: UsageSnapshot | null, over: Partial<UsageValue> = {}): UsageValue {
  return { snapshot: s, available: true, refreshing: false, error: null, refresh: async () => {}, update: async () => {}, display: null, setDisplay: async () => {}, ...over }
}
