/** Pure launch planning for terminal tabs: which shell, which argv, which cwd, which env.
 *  No Electron / node-pty imports, so every rule here is unit-tested (terminalLaunch.test.ts).
 *
 *  The renderer only ever supplies a launch KIND and a compose project NAME. Everything that
 *  reaches `spawn` — the executable, its arguments and the working directory — is decided here
 *  from main-owned facts ($SHELL, the discovery snapshot, the home directory). */
import { AGENT_CLI, CLI_NOT_FOUND_EXIT, type TermKind } from '../shared/terminal'
import { notFoundText } from '../shared/agents'

/** Shells we know how to drive (login + interactive + `-c`). Anything else falls back. */
const KNOWN_SHELLS = ['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh'] as const
export const FALLBACK_SHELL = '/bin/zsh'

export function shellBasename(shell: string): string {
  const i = shell.lastIndexOf('/')
  return i >= 0 ? shell.slice(i + 1) : shell
}

/** The user's login shell from $SHELL — accepted only when it is an absolute, existing path
 *  to a shell we can drive; otherwise macOS's default. */
export function resolveShell(envShell: string | undefined, exists: (p: string) => boolean): string {
  if (
    typeof envShell === 'string' &&
    envShell.startsWith('/') &&
    !envShell.includes('\0') &&
    (KNOWN_SHELLS as readonly string[]).includes(shellBasename(envShell)) &&
    exists(envShell)
  ) {
    return envShell
  }
  return FALLBACK_SHELL
}

/** Single-quote a string for POSIX sh (and fish, which accepts the same '…' form for text
 *  without backslashes/quotes — our messages contain neither). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function notFoundMessage(kind: Exclude<TermKind, 'shell'>): string {
  return notFoundText(kind)
}

/** How main launches an agent: the absolute binary it resolved on the login-shell PATH
 *  (null = not detected yet → looked up by name inside the shell) and the argv after it,
 *  composed from the registry + validated prefs (never from renderer input). */
export interface AgentLaunch {
  path: string | null
  args: readonly string[]
}

/** A resolved binary path is trusted only when absolute, NUL-free and ending in the
 *  registry's own binary name. */
export function isUsableBinPath(p: string | null, bin: string): p is string {
  return typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && !/[\r\n]/.test(p) && p.split('/').pop() === bin
}

/** The script an agent tab runs inside the user's login+interactive shell (so PATH from
 *  .zprofile/.zshrc — nvm, ~/.local/bin, Homebrew — is in effect for the CLI itself). Every
 *  argument is single-quoted (and already restricted to a shell-inert character set by
 *  shared/agents.ts). Missing CLI → a clear message and exit 127, never a silent failure. */
export function agentScript(kind: Exclude<TermKind, 'shell'>, shellName: string, launch: AgentLaunch = { path: null, args: [] }): string {
  const { bin, install } = AGENT_CLI[kind]
  // \033[1m bold, \033[2m dim, \033[0m reset — printf interprets the escapes.
  const msg = `\\r\\n  \\033[1m${notFoundMessage(kind)}\\033[0m\\r\\n  \\033[2m${install}\\033[0m\\r\\n\\r\\n`
  const argv = launch.args.map(shQuote).join(' ')
  const tail = argv ? ` ${argv}` : ''
  const path = isUsableBinPath(launch.path, bin) ? launch.path : null
  if (shellName === 'fish') {
    return path
      ? `if test -x ${shQuote(path)}; exec ${shQuote(path)}${tail}; else; printf ${shQuote(msg)}; exit ${CLI_NOT_FOUND_EXIT}; end`
      : `if command -q ${bin}; exec ${bin}${tail}; else; printf ${shQuote(msg)}; exit ${CLI_NOT_FOUND_EXIT}; end`
  }
  return path
    ? `if [ -x ${shQuote(path)} ]; then exec ${shQuote(path)}${tail}; else printf ${shQuote(msg)}; exit ${CLI_NOT_FOUND_EXIT}; fi`
    : `if command -v ${bin} >/dev/null 2>&1; then exec ${bin}${tail}; else printf ${shQuote(msg)}; exit ${CLI_NOT_FOUND_EXIT}; fi`
}

export interface LaunchPlan {
  file: string
  args: string[]
}

/** argv for a tab: a plain login shell, or the login shell running an agent CLI. */
export function buildLaunch(kind: TermKind, shell: string, agent?: AgentLaunch): LaunchPlan {
  const name = shellBasename(shell)
  if (kind === 'shell') return { file: shell, args: ['-l'] }
  // sh/dash have no `-i` + `-c` login semantics worth relying on; zsh/bash/fish/ksh do.
  const flags = name === 'sh' || name === 'dash' ? ['-l', '-c'] : ['-l', '-i', '-c']
  return { file: shell, args: [...flags, agentScript(kind, name, agent)] }
}

export interface CwdResolution {
  cwd: string
  note: string | null
}

export interface KnownProject {
  project: string
  projectShort: string
  folder: string | null
}

/** Working directory for a tab. `project` must be a stack from main's own discovery snapshot
 *  (the caller rejects unknown names before this); its folder must exist as a directory,
 *  otherwise the tab starts in $HOME with a note saying why. */
export function resolveCwd(
  project: KnownProject | null,
  home: string,
  isDir: (p: string) => boolean
): CwdResolution {
  if (!project) return { cwd: home, note: 'No project selected — started in your home folder.' }
  const folder = project.folder
  if (!folder || !folder.startsWith('/') || folder.includes('\0') || !isDir(folder)) {
    return { cwd: home, note: `${project.projectShort}’s folder isn’t on this Mac — started in your home folder.` }
  }
  return { cwd: folder, note: null }
}

/** Marks every pty the desktop launches as the USER's own session. The project's Orcha hooks
 *  still run inside it, but the CLI's identity-binding ones (`orcha rehydrate`, `watch`,
 *  `poll-inbox`, `unwatch`, `task-claim-guard`) exit silently on it, so a Claude tab opened in
 *  a project folder never wakes up as that project's agent (orcha_cli/personal_session.py).
 *  Managed sessions (notifier workers, residents, portal-paired terminals) are spawned by the
 *  CLI, which strips the marker from their env. */
export const PERSONAL_SESSION_ENV = 'ORCHA_PERSONAL_SESSION'

/** Environment for a pty: the app's env minus Electron/Orcha internals and secrets Orcha
 *  itself injected (an Orcha-stored API key must not silently switch the user's own
 *  `claude` to API billing), plus sane terminal defaults and the personal-session marker. */
export function buildTermEnv(env: NodeJS.ProcessEnv, theme?: 'light' | 'dark'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    if (k.startsWith('ELECTRON_') || k.startsWith('CLAUDE_CODE_') || k.startsWith('VITE_')) continue
    if (k === 'ANTHROPIC_API_KEY' || k === 'ORCHA_LLM_API_KEY' || k === 'NODE_OPTIONS' || k === 'NODE_ENV') continue
    // Hook routing is per session (ptyHost adds it for hooked agents only); an app started
    // from inside an Orcha terminal must not hand its own session id to every tab.
    if (k === 'ORCHA_TERM_ID' || k === 'ORCHA_HOOK_ENDPOINT') continue
    out[k] = v
  }
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'
  out.TERM_PROGRAM = 'Orcha'
  // Finder-launched apps get no locale; without one zsh mangles UTF-8 (prompts, box art).
  if (!out.LANG && !out.LC_ALL) out.LANG = 'en_US.UTF-8'
  out[PERSONAL_SESSION_ENV] = '1'
  // "fg;bg" in ANSI colour numbers: tells CLIs that sniff it (Claude Code's `auto` theme, vim,
  // many TUIs) whether the terminal background is light or dark.
  if (theme) out.COLORFGBG = theme === 'light' ? '0;15' : '15;0'
  return out
}
