/** Desktop Settings (⌘, / sidebar footer "Settings"): fills the inset content panel while
 *  open (main hides the portal view, like a terminal session). Sections — Profile, Agents,
 *  API keys, Appearance, Notifications, Voice, Usage and Storage — in a Linear-style left
 *  section list.
 *
 *  Notifications has no settings of its own: desktop alerts follow the same per-person
 *  rules as every other channel (portal Settings › Notifications, mig 063). The section
 *  says so and opens those preferences in the running project's portal. */
import { useEffect, useRef, useState } from 'react'
import { BarChart3, Bell, Bot, HardDrive, KeyRound, Mic, Settings as SettingsIcon, SunMoon, UserRound, X } from 'lucide-react'
import type { AgentId } from '../../../shared/agents'
import AgentsSettings from './AgentsSettings'
import ApiKeysSettings from './ApiKeysSettings'
import AppearanceSettings from './AppearanceSettings'
import ProfileSettings from './ProfileSettings'
import StorageSettings from './StorageSettings'
import VoiceSettings from './VoiceSettings'
import type { UsageValue } from '../usage/useUsage'
import {
  DEFAULT_PLAN_USAGE_DISPLAY,
  isApiBilled,
  localDay,
  peakWindow,
  todaySpendText,
  type PlanUsageProviders
} from '../../../shared/usage'
import { ProviderLogo, providerStatusText } from '../usage/parts'

/** Portal section the desktop's Notifications entry opens (SettingsPage `#tab=notifications`). */
export const NOTIFICATION_SETTINGS_PATH = '/settings#tab=notifications'

export type Section = 'profile' | 'agents' | 'apiKeys' | 'appearance' | 'notifications' | 'voice' | 'usage' | 'storage'

const SECTIONS: { key: Section; label: string; Icon: typeof Bot }[] = [
  { key: 'profile', label: 'Profile', Icon: UserRound },
  { key: 'agents', label: 'Agents', Icon: Bot },
  { key: 'apiKeys', label: 'API keys', Icon: KeyRound },
  { key: 'appearance', label: 'Appearance', Icon: SunMoon },
  { key: 'notifications', label: 'Notifications', Icon: Bell },
  { key: 'voice', label: 'Voice', Icon: Mic },
  { key: 'usage', label: 'Usage', Icon: BarChart3 },
  { key: 'storage', label: 'Storage', Icon: HardDrive }
]

export default function SettingsView({
  onClose,
  onTestLaunch,
  onOpenNotificationSettings,
  notificationsProject,
  initialSection = 'agents',
  usage,
  onOpenStats,
  onOpenVoiceSettings
}: {
  onClose(): void
  onTestLaunch?: (id: AgentId) => void
  /** Opens portal Settings › Notifications in the running project (absent: none running). */
  onOpenNotificationSettings?: () => void
  /** Name of the project that button opens. */
  notificationsProject?: string | null
  initialSection?: Section
  /** Usage & spend (absent on an older preload: the section is hidden). */
  usage?: UsageValue
  onOpenStats?: () => void
  /** Opens portal Settings › Voice in the running project (absent: none running). */
  onOpenVoiceSettings?: () => void
}) {
  const [section, setSection] = useState<Section>(initialSection)
  /** Settings › Appearance needs the theme bridge (absent on an older preload: hidden). */
  const hasTheme = !!window.orchaDesktop?.theme
  /** Settings › Profile needs the profile bridge (same rule). */
  const hasProfile = !!window.orchaDesktop?.profile
  /** Settings › Storage needs the storage bridge (same rule). */
  const hasStorage = !!window.orchaDesktop?.storageScan
  /** Settings › API keys needs the providerKeys bridge (same rule). */
  const hasApiKeys = !!window.orchaDesktop?.providerKeys
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-label="Settings"
      data-testid="settings-view"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault()
          onClose()
        }
      }}
      className="absolute inset-0 z-20 flex flex-col bg-card outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <SettingsIcon className="h-4 w-4 text-text-3" aria-hidden="true" />
        <h1 className="text-[13px] font-medium text-text">Settings</h1>
        <span className="text-[13px] text-text-3">/</span>
        <span className="text-[13px] text-text-2">{SECTIONS.find((x) => x.key === section)?.label}</span>
        <button
          type="button"
          aria-label="Close settings"
          title="Close (Esc)"
          data-testid="settings-close"
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-full border border-border text-text-3 hover:bg-hover hover:text-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="w-[188px] shrink-0 border-r border-border p-2">
          <div className="px-2 pb-1 pt-1.5 text-[11.5px] font-medium text-text-3">Desktop</div>
          {SECTIONS.filter(
            (x) => (x.key !== 'usage' || usage?.available) && (x.key !== 'appearance' || hasTheme) && (x.key !== 'profile' || hasProfile) && (x.key !== 'storage' || hasStorage) && (x.key !== 'apiKeys' || hasApiKeys)
          ).map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              aria-current={section === key ? 'page' : undefined}
              data-testid={`settings-nav-${key}`}
              onClick={() => setSection(key)}
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${
                section === key ? 'bg-selected text-text' : 'text-text-2 hover:bg-hover hover:text-text'
              }`}
            >
              <Icon className="h-4 w-4 text-text-3" aria-hidden="true" /> {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[880px] px-8 pb-16 pt-8">
            {section === 'profile' && hasProfile ? (
              <ProfileSettings />
            ) : section === 'agents' ? (
              <>
                <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-text">Agents</h2>
                <p className="mb-8 mt-1 text-[13px] text-text-3">
                  Coding-agent CLIs you launch in terminals from Embodent — ⌘K, a project’s ⋯ menu, New tab, and ⌥⌘T for the Default.
                </p>
                <AgentsSettings onTestLaunch={onTestLaunch} />
              </>
            ) : section === 'apiKeys' && hasApiKeys ? (
              <ApiKeysSettings />
            ) : section === 'appearance' && hasTheme ? (
              <AppearanceSettings />
            ) : section === 'voice' ? (
              <VoiceSettings project={notificationsProject} onOpenProjectVoice={onOpenVoiceSettings} />
            ) : section === 'storage' && hasStorage ? (
              <StorageSettings />
            ) : section === 'usage' && usage ? (
              <section data-testid="settings-usage">
                <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-text">Usage</h2>
                <p className="mb-6 mt-1 text-[13px] text-text-3">
                  Token use, estimated cost and plan limits for your coding agents, read from their own logs on this Mac.
                </p>
                <PlanUsageDisplaySetting usage={usage} />
                <BillingRows usage={usage} />
                <div className="flex flex-col divide-y divide-border rounded-[10px] border border-border">
                  <div className="flex min-h-[52px] items-center justify-between gap-6 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-text">Show usage in the menu bar</div>
                      <div className="text-[12px] text-text-3">The busiest plan window next to the Embodent icon, e.g. “C 77%”.</div>
                    </div>
                    <div
                      role="radiogroup"
                      aria-label="Show usage in the menu bar"
                      data-testid="usage-tray-toggle"
                      className="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-bg p-[2px]"
                    >
                      {([true, false] as const).map((v) => {
                        const on = (usage.snapshot?.prefs.trayTitle ?? true) === v
                        return (
                          <button
                            key={String(v)}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            disabled={!usage.snapshot}
                            onClick={() => !on && void usage.update({ op: 'trayTitle', on: v })}
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
                  <div className="flex min-h-[52px] items-center justify-between gap-6 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-text">Stats &amp; Usage</div>
                      <div className="text-[12px] text-text-3">Daily history, token mix, models, providers and per-project spend.</div>
                    </div>
                    <button
                      type="button"
                      data-testid="settings-open-stats"
                      disabled={!onOpenStats}
                      onClick={() => onOpenStats?.()}
                      className="h-7 shrink-0 rounded-md border border-border px-3 text-[13px] text-text hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Open Stats &amp; Usage
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <section data-testid="settings-notifications">
                <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-text">Notifications</h2>
                <p className="mb-6 mt-1 text-[13px] text-text-3">
                  Desktop alerts follow your Embodent notification settings — categories, “only mine”, pause, quiet hours and
                  per-project mute. Muting only silences alerts: anything that needs you still shows in Needs you and the tray.
                </p>
                <div className="flex min-h-[52px] items-center justify-between gap-6 rounded-[10px] border border-border px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-text">Notification preferences</div>
                    <div className="text-[12px] text-text-3">
                      {notificationsProject
                        ? `Opens Settings › Notifications in ${notificationsProject}.`
                        : 'Start a project to change them — they live in its Settings › Notifications.'}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="open-notification-settings"
                    disabled={!onOpenNotificationSettings}
                    onClick={() => onOpenNotificationSettings?.()}
                    className="h-7 shrink-0 rounded-md border border-border px-3 text-[13px] text-text hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Open notification settings
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Settings › Usage: how each agent CLI is billed — its plan (busiest window) or, when its
 *  runs bill an API key (Settings › API keys), "API key" with today's Est. spend. */
function BillingRows({ usage }: { usage: UsageValue }) {
  const rows = (usage.snapshot?.providers ?? []).filter((p) => (p.id === 'claude' || p.id === 'codex') && p.enabled)
  if (rows.length === 0) return null
  const today = localDay(Date.now())
  return (
    <div className="mb-4 flex flex-col divide-y divide-border rounded-[10px] border border-border" data-testid="settings-usage-billing">
      {rows.map((p) => {
        const api = isApiBilled(p)
        const peak = peakWindow(p)
        const plan = p.limits?.plan ?? null
        return (
          <div key={p.id} data-testid={`settings-billing-${p.id}`} data-billing={api ? 'api-key' : 'plan'} className="flex min-h-[44px] items-center gap-3 px-4 py-2.5">
            <ProviderLogo id={p.id} size={20} />
            <span className="min-w-0 flex-1 text-[13px] font-medium text-text">{p.label}</span>
            <span className="shrink-0 text-[12.5px] tabular-nums text-text-2">
              {api
                ? `API key · ${todaySpendText(p, today)}`
                : peak
                  ? `${plan ? `${plan} · ` : ''}${peak.label} ${Math.round(peak.usedPercent)}% used`
                  : providerStatusText(p) || plan || 'Subscription'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

const PLAN_PROVIDER_OPTIONS: { value: PlanUsageProviders; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' }
]

/** Settings › Usage, top: the portal-wide "Show plan usage" switch (off by default) and,
 *  while it is on, which providers the sidebar row shows. */
function PlanUsageDisplaySetting({ usage }: { usage: UsageValue }) {
  const d = usage.display ?? DEFAULT_PLAN_USAGE_DISPLAY
  const ready = usage.display !== null
  return (
    <div className="mb-4 flex flex-col divide-y divide-border rounded-[10px] border border-border" data-testid="plan-usage-display">
      <div className="flex min-h-[52px] items-center justify-between gap-6 px-4 py-3">
        <div className="min-w-0">
          <div id="plan-usage-show-label" className="text-[13px] font-medium text-text">
            Show plan usage
          </div>
          <div className="text-[12px] text-text-3">
            Shows your Claude and Codex plan limits in the sidebar and on each project’s Home, on every device connected to this
            Embodent.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={d.show}
          aria-labelledby="plan-usage-show-label"
          data-testid="plan-usage-show"
          disabled={!ready}
          onClick={() => void usage.setDisplay({ show: !d.show, providers: d.providers })}
          className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            d.show ? 'bg-accent' : 'bg-border-strong'
          }`}
        >
          <span
            aria-hidden="true"
            className={`absolute left-0 top-[2px] h-[14px] w-[14px] rounded-full bg-bg shadow-sm transition-transform ${
              d.show ? 'translate-x-[16px]' : 'translate-x-[2px]'
            }`}
          />
        </button>
      </div>
      <div className={`flex min-h-[52px] items-center justify-between gap-6 px-4 py-3 ${d.show ? '' : 'opacity-50'}`}>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-text">Providers</div>
          <div className="text-[12px] text-text-3">Which plan limits the sidebar shows.</div>
        </div>
        <div
          role="radiogroup"
          aria-label="Providers"
          aria-disabled={!d.show}
          data-testid="plan-usage-providers"
          className="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-bg p-[2px]"
        >
          {PLAN_PROVIDER_OPTIONS.map((o) => {
            const on = d.providers === o.value
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                data-testid={`plan-usage-providers-${o.value}`}
                disabled={!ready || !d.show}
                onClick={() => !on && void usage.setDisplay({ show: d.show, providers: o.value })}
                className={`h-[22px] rounded-[5px] px-2.5 text-[12.5px] font-medium leading-none transition-colors disabled:cursor-not-allowed ${
                  on ? 'bg-selected text-text shadow-[var(--shadow-seg)]' : 'text-text-3 hover:text-text-2'
                }`}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
