/** Agent CLI registry + Agents settings contract (desktop host only). Pure — no Electron /
 *  Node imports — so main, preload (types only), renderer and tests share one source.
 *
 *  CATALOGUE RULES (owner: "no fabrication"): every entry is a real, shipping CLI whose binary
 *  name, official install command, docs URL and — when present — skip-permission flag were
 *  checked against the vendor's own site / README / npm package on 2026-09-29. The source for
 *  each fact is recorded next to the entry. A CLI with no documented skip-permission flag for
 *  its INTERACTIVE mode has `yolo: null` and launches normally in Yolo mode (the settings row
 *  says so). Candidates that could not be verified are left out, not guessed.
 *
 *  SECURITY MODEL (see main/agentsIpc.ts, main/terminalLaunch.ts):
 *  - The renderer only ever names a registry id (`AgentId`). Main resolves the binary on the
 *    user's login-shell PATH itself and composes the argv from this registry + the user's
 *    validated extra args; the renderer never passes a path, a command or a flag string.
 *  - Extra args are an argv ARRAY, each element restricted to a shell-inert character set
 *    (no whitespace, quotes, `$`, backticks, `;|&<>()`, globs, `~`, backslashes, control
 *    characters) and single-quoted again at spawn time.
 *  - Docs links open only through main, looked up by id, and only when the URL's host is on
 *    the https allowlist derived from this registry. */

export interface AgentYolo {
  /** argv appended in Yolo mode, exactly as the vendor documents it. */
  args: readonly string[]
  /** What the flag skips, in the vendor's own words (tooltip). */
  skips: string
}

export interface AgentDef {
  id: string
  /** Product name as the vendor writes it. */
  label: string
  /** Shorter name for tab titles / menus (defaults to `label`). */
  short?: string
  /** Executable name looked up on the login-shell PATH. */
  bin: string
  /** Official install command (shown with a copy button; never executed by Orcha). */
  install: string
  /** Official docs (https only; opened through main's allowlist). */
  docsUrl: string
  /** Documented skip-permission flag for the interactive CLI, or null when none exists. */
  yolo: AgentYolo | null
  /** Shown in the row when `yolo` is null (why Yolo launches it normally). */
  yoloNote?: string
  /** argv appended in Manual mode, only for a CLI whose own default is to auto-approve (so
   *  "Manual" really means the agent asks first). Exactly as the vendor documents it. */
  manualArgs?: readonly string[]
}

/** The verified catalogue (display order in "Available to install"). */
export const AGENT_REGISTRY = [
  {
    // bin + install: npm @anthropic-ai/claude-code@2.1.284 package.json "bin" + README.
    // docs + flag: https://code.claude.com/docs/en/cli-reference ("--dangerously-skip-permissions
    // — Skip permission prompts. Equivalent to --permission-mode bypassPermissions").
    id: 'claude',
    label: 'Claude Code',
    short: 'Claude',
    bin: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://code.claude.com/docs/en/overview',
    yolo: { args: ['--dangerously-skip-permissions'], skips: 'Skips every permission prompt (bypassPermissions mode).' }
  },
  {
    // bin + install: npm @openai/codex@0.159.0 package.json "bin" + README ("npm install -g
    // @openai/codex", "brew install --cask codex"). Flag: Codex CLI reference
    // (developers.openai.com/codex/cli/reference → learn.chatgpt.com/docs/developer-commands):
    // "--dangerously-bypass-approvals-and-sandbox (alias --yolo): Run every command without
    // approvals or sandboxing."
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    yolo: { args: ['--dangerously-bypass-approvals-and-sandbox'], skips: 'Runs every command without approvals or sandboxing.' }
  },
  {
    // bin + install + docs: npm @google/gemini-cli@0.61.0 "bin" + README. Flag:
    // https://geminicli.com/docs/cli/cli-reference — "--approval-mode … Choices: default,
    // auto_edit, yolo, plan" (the older --yolo is marked Deprecated there).
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://geminicli.com/docs/',
    yolo: { args: ['--approval-mode=yolo'], skips: 'Auto-approves all tool actions (approval mode yolo).' }
  },
  {
    // bin + install + docs: npm @github/copilot@1.0.89 "bin" + README ("npm install -g
    // @github/copilot", docs link). Flag: https://docs.github.com/en/copilot/reference/
    // cli-command-reference — "--allow-all: Enables all permissions (tools, paths, and URLs)".
    // Docs URL is the canonical target of docs.github.com/copilot/concepts/agents/about-copilot-cli
    // (re-checked 2026-09-29).
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    install: 'npm install -g @github/copilot',
    docsUrl: 'https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli',
    yolo: { args: ['--allow-all'], skips: 'Allows all tools, paths and URLs without asking.' }
  },
  {
    // install: https://cursor.com/docs/cli/installation ("curl https://cursor.com/install -fsS
    // | bash"). bin: that installer links BOTH ~/.local/bin/agent (primary) and
    // ~/.local/bin/cursor-agent ("legacy"); we detect the unambiguous `cursor-agent`.
    // Flag: https://cursor.com/docs/cli/reference/parameters — "--force / -f: Force allow
    // commands unless explicitly denied" (--yolo is an alias).
    id: 'cursor',
    label: 'Cursor CLI',
    bin: 'cursor-agent',
    install: 'curl https://cursor.com/install -fsS | bash',
    docsUrl: 'https://cursor.com/docs/cli/overview',
    yolo: { args: ['--force'], skips: 'Force-allows commands unless explicitly denied.' }
  },
  {
    // bin: npm opencode-ai@1.18.33 "bin". install + docs: https://opencode.ai/docs
    // ("npm install -g opencode-ai" / install script). No documented skip-permission flag.
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    install: 'npm install -g opencode-ai',
    docsUrl: 'https://opencode.ai/docs',
    yolo: null,
    yoloNote: 'No documented skip-permission flag — launches normally (permissions live in opencode.json).'
  },
  {
    // bin: npm @qwen-code/qwen-code@0.24.7 "bin"; install + docs URL: github.com/QwenLM/qwen-code
    // README. Flag: Qwen Code settings docs (qwenlm.github.io/qwen-code-docs … configuration/
    // settings) "--yolo: Automatically approve all tool calls"; also the CLI's own option
    // table in the package ("yolo: {alias: 'y', … Automatically accept all actions").
    id: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    install: 'npm install -g @qwen-code/qwen-code@latest',
    docsUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
    yolo: { args: ['--yolo'], skips: 'Automatically approves all tool calls.' }
  },
  {
    // install + bin: https://ampcode.com/docs/cli ("curl -fsSL https://ampcode.com/install.sh
    // | bash", binary "amp"). Flag: ampcode.com/news/more-tools-for-the-agent and Sourcegraph's
    // official guide (github.com/sourcegraph/amp-examples-and-guides guides/cli/README.md):
    // "use --dangerously-allow-all". Docs URL: ampcode.com/docs/cli (the install page above;
    // ampcode.com/manual now redirects to ampcode.com/docs — re-checked 2026-09-29).
    id: 'amp',
    label: 'Amp',
    bin: 'amp',
    install: 'curl -fsSL https://ampcode.com/install.sh | bash',
    docsUrl: 'https://ampcode.com/docs/cli',
    yolo: { args: ['--dangerously-allow-all'], skips: 'Allows every tool call without asking.' }
  },
  {
    // install: https://aider.chat/docs/install.html ("curl -LsSf https://aider.chat/install.sh
    // | sh"). Flag: https://aider.chat/docs/config/options.html "--yes-always: Always say yes
    // to every confirmation".
    id: 'aider',
    label: 'Aider',
    bin: 'aider',
    install: 'curl -LsSf https://aider.chat/install.sh | sh',
    docsUrl: 'https://aider.chat/docs/',
    yolo: { args: ['--yes-always'], skips: 'Always says yes to every confirmation.' }
  },
  {
    // install + bin: https://goose-docs.ai/docs/getting-started/installation/ ("brew install
    // block-goose-cli", binary "goose"). No documented CLI skip-permission flag (goose's
    // approval behaviour is a config/env setting).
    id: 'goose',
    label: 'goose',
    bin: 'goose',
    install: 'brew install block-goose-cli',
    docsUrl: 'https://goose-docs.ai/docs/getting-started/installation/',
    yolo: null,
    yoloNote: 'No documented skip-permission flag — launches normally (approval mode is set in goose’s own config).'
  },
  {
    // bin + install: npm @charmland/crush@0.97.1 "bin" + README ("brew install
    // charmbracelet/tap/crush"). Flag: same README, "You can also skip all permission prompts
    // completely by running Crush with the --yolo flag."
    id: 'crush',
    label: 'Crush',
    bin: 'crush',
    install: 'brew install charmbracelet/tap/crush',
    docsUrl: 'https://github.com/charmbracelet/crush',
    yolo: { args: ['--yolo'], skips: 'Skips all permission prompts.' }
  },
  {
    // install + bin: https://docs.factory.ai/droid-cli/quickstart ("curl -fsSL
    // https://app.factory.ai/cli | sh", start with "droid"; re-checked 2026-09-29 — the old
    // /cli/getting-started/quickstart path now 30x-redirects here). The documented
    // --skip-permissions-unsafe / --auto flags apply to `droid exec` only
    // (docs.factory.ai/reference/cli-reference), not to the interactive CLI.
    id: 'droid',
    label: 'Factory Droid',
    bin: 'droid',
    install: 'curl -fsSL https://app.factory.ai/cli | sh',
    docsUrl: 'https://docs.factory.ai/droid-cli/quickstart',
    yolo: null,
    yoloNote: 'Skip-permission flags are documented for `droid exec` only — launches normally.'
  },
  {
    // install + bin + docs: https://docs.x.ai/build/overview ("curl -fsSL
    // https://x.ai/cli/install.sh | bash", binary "grok"). Flag: docs.x.ai/build/cli/reference
    // "--always-approve: Auto-approve all tool executions (alias --yolo)".
    id: 'grok',
    label: 'Grok Build',
    bin: 'grok',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    docsUrl: 'https://docs.x.ai/build/overview',
    yolo: { args: ['--always-approve'], skips: 'Auto-approves all tool executions (deny rules still apply).' }
  },
  {
    // install + bin + docs: https://moonshotai.github.io/kimi-code/en/ ("curl -fsSL
    // https://code.kimi.com/kimi-code/install.sh | bash", binary "kimi"; the older Python
    // kimi-cli repo is archived and points here). Flag: …/reference/kimi-command.html
    // "--yolo -y … routine edits and commands run automatically; risky actions … still ask".
    id: 'kimi',
    label: 'Kimi Code',
    bin: 'kimi',
    install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    docsUrl: 'https://moonshotai.github.io/kimi-code/en/',
    yolo: { args: ['--yolo'], skips: 'Skips approval for regular tool calls; risky actions still ask.' }
  },
  {
    // bin + install + docs: npm cline@3.0.65 "bin" + README ("npm install -g cline",
    // docs.cline.bot). Flag: same README options table "--auto-approve [true|false]: Set tool
    // auto-approval for all tools". (Its --yolo also exits after one turn — not used.)
    // Same README: "Tool calls are auto-approved by default. Use `--auto-approve false` to
    // require review before tool execution." — so Manual passes that flag (re-checked 2026-09-29).
    id: 'cline',
    label: 'Cline CLI',
    bin: 'cline',
    install: 'npm install -g cline',
    docsUrl: 'https://docs.cline.bot',
    yolo: { args: ['--auto-approve', 'true'], skips: 'Auto-approves all tools.' },
    manualArgs: ['--auto-approve', 'false']
  },
  {
    // bin + install + docs: npm @augmentcode/auggie@0.36.0 "bin" + README ("npm install -g
    // @augmentcode/auggie", docs.augmentcode.com/cli/overview). Its reference documents only
    // per-tool rules (--permission <tool>:allow), no global skip flag.
    id: 'auggie',
    label: 'Auggie',
    bin: 'auggie',
    install: 'npm install -g @augmentcode/auggie',
    docsUrl: 'https://docs.augmentcode.com/cli/overview',
    yolo: null,
    yoloNote: 'No documented global skip-permission flag — launches normally.'
  }
] as const satisfies readonly AgentDef[]

export type AgentId = (typeof AGENT_REGISTRY)[number]['id']
export const AGENT_IDS: readonly AgentId[] = AGENT_REGISTRY.map((a) => a.id)

const BY_ID = new Map<string, AgentDef>(AGENT_REGISTRY.map((a) => [a.id, a]))

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && BY_ID.has(v)
}

export function agentDef(id: AgentId): AgentDef {
  return BY_ID.get(id) as AgentDef
}

/** Tab / menu name (`Claude`, `Codex`, `Gemini CLI` …). */
export function agentShortLabel(id: AgentId): string {
  const d = agentDef(id)
  return d.short ?? d.label
}

/** "Claude Code CLI not found — install it, then Restart." (never "CLI CLI"). */
export function notFoundText(id: AgentId): string {
  const label = agentDef(id).label
  return `${label}${/\bCLI$/.test(label) ? '' : ' CLI'} not found — install it, then Restart.`
}

/** Agents that existed before the registry (the legacy launchers). */
export const LEGACY_AGENTS: readonly AgentId[] = ['claude', 'codex']

// ---------------------------------------------------------------------------------------
// Docs link allowlist (https + exact host from the registry).

export const DOCS_HOSTS: ReadonlySet<string> = new Set(AGENT_REGISTRY.map((a) => new URL(a.docsUrl).host))

/** The docs URL main may open for an agent id, or null (unknown id / not https / host not
 *  on the allowlist — the registry is the only source). */
export function docsUrlFor(id: unknown): string | null {
  if (!isAgentId(id)) return null
  const url = agentDef(id).docsUrl
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && DOCS_HOSTS.has(u.host) && !u.username && !u.password ? url : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------
// Extra args (per agent, argv array).

export const EXTRA_ARGS_MAX = 16
export const EXTRA_ARG_MAX_LEN = 200
/** Shell-inert characters only: letters, digits and `_ . / : = , @ % + -`. */
const ARG_RE = /^[A-Za-z0-9_./:=,@%+-]+$/

export type ArgsCheck = { ok: true; args: string[] } | { ok: false; error: string }

export function validateExtraArgs(raw: unknown): ArgsCheck {
  if (!Array.isArray(raw)) return { ok: false, error: 'Arguments must be a list.' }
  if (raw.length > EXTRA_ARGS_MAX) return { ok: false, error: `At most ${EXTRA_ARGS_MAX} arguments.` }
  const out: string[] = []
  for (const a of raw) {
    if (typeof a !== 'string' || a.length === 0) return { ok: false, error: 'Empty argument.' }
    if (a.length > EXTRA_ARG_MAX_LEN) return { ok: false, error: `Argument longer than ${EXTRA_ARG_MAX_LEN} characters.` }
    if (!ARG_RE.test(a)) return { ok: false, error: `“${a.slice(0, 40)}” contains a character that isn’t allowed (no spaces, quotes or shell symbols).` }
    out.push(a)
  }
  return { ok: true, args: out }
}

/** Split what the user typed into argv (whitespace-separated) and validate it. */
export function parseArgsInput(text: string): ArgsCheck {
  const parts = text.trim() === '' ? [] : text.trim().split(/\s+/)
  return validateExtraArgs(parts)
}

// ---------------------------------------------------------------------------------------
// Preferences (persisted by main in <userData>/agents.json).

export type PermissionMode = 'yolo' | 'manual'
export const PERMISSION_MODES: readonly PermissionMode[] = ['yolo', 'manual']

export interface AgentPref {
  enabled: boolean
  extraArgs: string[]
}

export interface AgentPrefs {
  version: 1
  /** Owner decision: Yolo is the default for fresh installs AND existing users. */
  permissionMode: PermissionMode
  /** ⌥⌘T launches this one; listed first everywhere. */
  defaultAgent: AgentId
  agents: Record<AgentId, AgentPref>
  /** Reopen the terminal tabs that were open at quit (main/sessionRestore.ts). Default on. */
  restoreSessions: boolean
  /** Restored agent tabs resume their conversation (`claude --resume <id>`, `codex resume
   *  <id>`); off = they start a fresh conversation in the same folder. Default on. */
  resumeAgents: boolean
}

export const AGENT_PREFS_VERSION = 1

/** Fresh install / pre-registry user: Yolo, Claude default (⌥⌘T keeps launching Claude),
 *  every agent enabled (Claude + Codex keep appearing exactly as before). */
export function defaultAgentPrefs(): AgentPrefs {
  const agents = {} as Record<AgentId, AgentPref>
  for (const id of AGENT_IDS) agents[id] = { enabled: true, extraArgs: [] }
  return { version: 1, permissionMode: 'yolo', defaultAgent: 'claude', agents, restoreSessions: true, resumeAgents: true }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse whatever is on disk into valid prefs — never throws. Unknown agent ids and invalid
 *  args are dropped (not coerced); missing agents get the defaults; a file from before the
 *  registry (none existed — absent file) or with no/older `version` migrates to defaults
 *  merged with any readable fields. */
export function parseAgentPrefs(raw: unknown): AgentPrefs {
  const out = defaultAgentPrefs()
  if (!isRecord(raw)) return out
  if (raw.permissionMode === 'yolo' || raw.permissionMode === 'manual') out.permissionMode = raw.permissionMode
  if (typeof raw.restoreSessions === 'boolean') out.restoreSessions = raw.restoreSessions
  if (typeof raw.resumeAgents === 'boolean') out.resumeAgents = raw.resumeAgents
  if (isRecord(raw.agents)) {
    for (const [id, v] of Object.entries(raw.agents)) {
      if (!isAgentId(id) || !isRecord(v)) continue
      const args = validateExtraArgs(v.extraArgs ?? [])
      out.agents[id] = {
        enabled: typeof v.enabled === 'boolean' ? v.enabled : true,
        extraArgs: args.ok ? args.args : []
      }
    }
  }
  if (isAgentId(raw.defaultAgent) && out.agents[raw.defaultAgent].enabled) out.defaultAgent = raw.defaultAgent
  else out.defaultAgent = firstEnabled(out, null) ?? 'claude'
  return out
}

/** First enabled agent (installed ones first when `installed` is known), registry order. */
export function firstEnabled(prefs: AgentPrefs, installed: ReadonlySet<AgentId> | null): AgentId | null {
  const enabled = AGENT_IDS.filter((id) => prefs.agents[id].enabled)
  if (installed) {
    const hit = enabled.find((id) => installed.has(id))
    if (hit) return hit
  }
  return enabled[0] ?? null
}

/** DT-32 (the parseAgentPrefs rule, applied once detection is known — parse itself can't see
 *  what is installed): a saved default that is enabled but NOT installed while another enabled
 *  agent IS installed moves to that installed agent (registry order). Returns the same object
 *  when nothing changes (so callers can skip the save). Unknown detection → unchanged. */
export function reconcileDefault(prefs: AgentPrefs, installed: ReadonlySet<AgentId> | null): AgentPrefs {
  if (!installed || installed.has(prefs.defaultAgent)) return prefs
  const hit = AGENT_IDS.find((id) => prefs.agents[id].enabled && installed.has(id))
  return hit ? { ...prefs, defaultAgent: hit } : prefs
}

export type AgentUpdate =
  | { op: 'permissionMode'; mode: PermissionMode }
  | { op: 'enabled'; id: AgentId; enabled: boolean }
  | { op: 'default'; id: AgentId }
  | { op: 'extraArgs'; id: AgentId; args: string[] }
  | { op: 'restoreSessions'; on: boolean }
  | { op: 'resumeAgents'; on: boolean }

/** Strict parse of a renderer update (unknown keys / ids / values rejected). */
export function parseAgentUpdate(raw: unknown): AgentUpdate | null {
  if (!isRecord(raw)) return null
  const keys = Object.keys(raw)
  const only = (...k: string[]): boolean => keys.every((x) => k.includes(x)) && k.every((x) => x in raw)
  switch (raw.op) {
    case 'permissionMode':
      return only('op', 'mode') && (raw.mode === 'yolo' || raw.mode === 'manual') ? { op: 'permissionMode', mode: raw.mode } : null
    case 'enabled':
      return only('op', 'id', 'enabled') && isAgentId(raw.id) && typeof raw.enabled === 'boolean'
        ? { op: 'enabled', id: raw.id, enabled: raw.enabled }
        : null
    case 'default':
      return only('op', 'id') && isAgentId(raw.id) ? { op: 'default', id: raw.id } : null
    case 'extraArgs': {
      if (!only('op', 'id', 'args') || !isAgentId(raw.id)) return null
      const args = validateExtraArgs(raw.args)
      return args.ok ? { op: 'extraArgs', id: raw.id, args: args.args } : null
    }
    case 'restoreSessions':
    case 'resumeAgents':
      return only('op', 'on') && typeof raw.on === 'boolean' ? { op: raw.op, on: raw.on } : null
    default:
      return null
  }
}

/** Apply an update (pure). Setting a disabled agent as default enables it; disabling the
 *  default hands "default" to the next enabled INSTALLED agent when detection is known (else
 *  the next enabled one) and is refused when there is none; enabling an installed agent while
 *  the default is not installed makes it the default. */
export function applyAgentUpdate(prefs: AgentPrefs, u: AgentUpdate, installed: ReadonlySet<AgentId> | null): AgentPrefs {
  const next: AgentPrefs = { ...prefs, agents: { ...prefs.agents } }
  if (u.op === 'permissionMode') next.permissionMode = u.mode
  else if (u.op === 'restoreSessions') next.restoreSessions = u.on
  else if (u.op === 'resumeAgents') next.resumeAgents = u.on
  else if (u.op === 'extraArgs') next.agents[u.id] = { ...next.agents[u.id], extraArgs: [...u.args] }
  else if (u.op === 'default') {
    next.agents[u.id] = { ...next.agents[u.id], enabled: true }
    next.defaultAgent = u.id
  } else {
    next.agents[u.id] = { ...next.agents[u.id], enabled: u.enabled }
    if (!u.enabled && next.defaultAgent === u.id) {
      // With detection known, the successor must be INSTALLED: every catalogue agent is
      // enabled by default, so "any enabled" would hand ⌥⌘T to e.g. an uninstalled Gemini.
      const other = installed
        ? (AGENT_IDS.find((id) => id !== u.id && next.agents[id].enabled && installed.has(id)) ?? null)
        : firstEnabled(next, null)
      // No launchable successor: refuse — the default stays enabled (⌥⌘T keeps working).
      if (other) next.defaultAgent = other
      else next.agents[u.id] = { ...next.agents[u.id], enabled: true }
    } else if (u.enabled && installed?.has(u.id) && !installed.has(next.defaultAgent)) {
      // Re-enabling an installed agent while the default can't launch (a state older builds
      // could save): the installed one becomes the default.
      next.defaultAgent = u.id
    }
  }
  return next
}

// ---------------------------------------------------------------------------------------
// Launch composition (used by main to build argv and by the UI to show the command line).

/** argv after the binary for an interactive launch: Yolo flag (if documented and Yolo is
 *  on) + the user's extra args. `probe` = "Test launch": just `--version`. */
export function composeAgentArgs(id: AgentId, mode: PermissionMode, extraArgs: readonly string[], probe = false): string[] {
  if (probe) return ['--version']
  const def = agentDef(id)
  const modeArgs = mode === 'yolo' ? (def.yolo ? def.yolo.args : []) : (def.manualArgs ?? [])
  return [...modeArgs, ...extraArgs]
}

/** Display form of what will run: `claude --dangerously-skip-permissions --model opus`. */
export function commandLine(id: AgentId, mode: PermissionMode, extraArgs: readonly string[]): string {
  return [agentDef(id).bin, ...composeAgentArgs(id, mode, extraArgs)].join(' ')
}

// ---------------------------------------------------------------------------------------
// IPC contract.

export const AGENT_CHANNELS = {
  get: 'orcha:agents:get',
  refresh: 'orcha:agents:refresh',
  update: 'orcha:agents:update',
  openDocs: 'orcha:agents:openDocs',
  copyInstall: 'orcha:agents:copyInstall',
  changed: 'orcha:agents:changed'
} as const

export type DetectionStatus = 'pending' | 'ready' | 'error'

export interface AgentState {
  id: AgentId
  enabled: boolean
  extraArgs: string[]
  /** null = not detected yet (first detection still running / failed). */
  installed: boolean | null
  /** Absolute path the binary resolved to on the login-shell PATH (informational). */
  path: string | null
}

export interface AgentsSnapshot {
  permissionMode: PermissionMode
  /** Terminal session restore (Settings › Agents › Terminal sessions). Optional for older
   *  mains; absent = on. */
  restoreSessions?: boolean
  resumeAgents?: boolean
  defaultAgent: AgentId
  detection: DetectionStatus
  detectedAt: number | null
  agents: AgentState[]
}

/** The bridge the manager preload exposes as `window.orchaDesktop.agents`. */
export interface AgentsApi {
  get(): Promise<AgentsSnapshot>
  /** Re-run detection on the login-shell PATH. */
  refresh(): Promise<AgentsSnapshot>
  update(u: AgentUpdate): Promise<AgentsSnapshot>
  /** Open the agent's official docs (main looks the URL up by id; allowlisted https). */
  openDocs(id: AgentId): Promise<void>
  /** Copy the agent's official install command (looked up by id) to the clipboard. */
  copyInstall(id: AgentId): Promise<void>
  onChanged(cb: (s: AgentsSnapshot) => void): () => void
}

/** A launcher entry the menus show: enabled + installed agents, default first. Before the
 *  first detection completes (or when it failed) the legacy Claude/Codex launchers stay, so
 *  nothing an existing user relied on disappears. */
export function launcherIds(s: AgentsSnapshot | null): AgentId[] {
  if (!s || s.detection !== 'ready') {
    const legacy = LEGACY_AGENTS.filter((id) => !s || s.agents.find((a) => a.id === id)?.enabled !== false)
    const def = s?.defaultAgent
    return def && legacy.includes(def) ? [def, ...legacy.filter((i) => i !== def)] : legacy
  }
  const ids = s.agents.filter((a) => a.enabled && a.installed).map((a) => a.id)
  return ids.includes(s.defaultAgent) ? [s.defaultAgent, ...ids.filter((i) => i !== s.defaultAgent)] : ids
}
