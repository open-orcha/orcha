/** Agent lifecycle hooks for terminal sessions: the bundled relay script, the per-app-run
 *  endpoint file, the Claude Code `--settings` file and the per-launch argv additions.
 *
 *  How each agent reports (nothing in the user's own config is ever modified):
 *  - Claude Code: `claude --settings <userData>/agent-hooks/claude-settings.json …`. The file
 *    holds ONLY `hooks`; Claude layers flag settings on top of the user's own settings files
 *    and runs the hooks of every source, so the user's own hooks keep running too.
 *  - Codex: `codex -c 'notify=["/bin/sh","<script>","codex-notify", <user's own notify…>]' …`,
 *    a per-invocation config override (Codex hooks need per-hook trust entries in
 *    CODEX_HOME/config.toml, which Orcha must not write). Codex appends its event JSON as the
 *    last argument; the script reports agent-turn-complete and then runs the user's own
 *    `notify` command (read — never written — from CODEX_HOME/config.toml) with the same JSON,
 *    so a notifier the user configured keeps working.
 *  Other agents (and plain shells) keep the output heuristics in termMeta.ts.
 *
 *  The relay is a POSIX sh script calling /usr/bin/curl (stock macOS; no node, no deps):
 *  - finds its endpoint through two env vars the pty carries — ORCHA_TERM_ID (the session) and
 *    ORCHA_HOOK_ENDPOINT (a 0600 file holding the receiver's port + per-run token);
 *  - sends the token through curl's stdin config (`-K -`), never argv (`ps` shows argv to
 *    every local user), ignores ~/.curlrc (`-q`) and proxies (`--noproxy '*'`) — a proxy
 *    env var must not route loopback traffic elsewhere;
 *  - never writes to stdout (a UserPromptSubmit hook's stdout becomes prompt context), always
 *    drains stdin, is bounded by --connect-timeout 1 / --max-time 2, and always exits 0 — a
 *    dead or blocked endpoint can never fail or stall the agent.
 *  Adapted from Orca's managed agent hooks (github.com/stablyai/orca, MIT © Lovecast Inc.:
 *  main/agent-hooks/posix-hook-command.ts, hook-post-command.ts,
 *  shared/agent-hook-listener/endpoint-publication.ts), reduced to one POST per event.
 *
 *  Pure apart from `installAgentHooks` / `readCodexNotify` (fs) — agentHooks.test.ts. */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentId } from '../shared/agents'
import type { HookMode } from './agentStatus'
import { shQuote } from './terminalLaunch'

export interface AgentHookFiles {
  dir: string
  script: string
  claudeSettings: string
  endpoint: string
}

export function hookFilePaths(userData: string): AgentHookFiles {
  const dir = path.join(userData, 'agent-hooks')
  return {
    dir,
    script: path.join(dir, 'orcha-hook.sh'),
    claudeSettings: path.join(dir, 'claude-settings.json'),
    endpoint: path.join(dir, 'endpoint.env')
  }
}

/** Claude Code hook events Orcha registers (agentStatus.ts maps them to a status). */
export const CLAUDE_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop'
] as const

/** Tool events take a matcher ("*" = every tool). */
const MATCHER_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'])

export function hookScript(): string {
  return `#!/bin/sh
# Orcha agent-hook relay — written by Orcha Desktop on every start; do not edit.
# Reports one lifecycle event of the Orcha terminal session it runs in. Never prints to
# stdout, never blocks for more than ~3 s, always exits 0.
# Adapted from Orca's managed agent hooks (https://github.com/stablyai/orca, MIT, (c) Lovecast Inc.).
event="\${1:-}"
[ "$#" -gt 0 ] && shift
detail=""
session=""
case "$event" in
  codex-notify)
    # Codex notify: argv = codex-notify [user's own notify argv...] <event json>
    last=""
    for arg in "$@"; do last="$arg"; done
    if [ "$#" -gt 1 ]; then
      "$@" >/dev/null 2>&1 </dev/null &
    fi
    case "$last" in
      *'"agent-turn-complete"'*)
        event=TurnComplete
        # The thread id (a UUID) lets Orcha resume this conversation after a relaunch.
        session=$(printf '%s' "$last" | head -c 65536 | tr -d '\\n' | grep -o '"thread-id"[[:space:]]*:[[:space:]]*"[0-9A-Fa-f-]\\{36\\}"' | head -n 1 | sed 's/.*"\\([0-9A-Fa-f-]*\\)"$/\\1/')
        ;;
      *) event="" ;;
    esac
    ;;
  UserPromptSubmit|PreToolUse|PostToolUse|PostToolUseFailure|PermissionRequest|Notification|Stop|StopFailure|SubagentStop|SessionStart)
    # Claude hook: the event JSON is on stdin. Drain it; only a Notification's type and — on a
    # prompt / turn end, when the conversation exists on disk — the session id are read.
    input=""
    case "$event" in
      Notification|UserPromptSubmit|Stop) input=$(head -c 65536 2>/dev/null | tr -d '\\n') ;;
    esac
    cat >/dev/null 2>&1
    if [ "$event" = Notification ]; then
      detail=$(printf '%s' "$input" | sed -n 's/.*"notification_type"[[:space:]]*:[[:space:]]*"\\([a-z_]*\\)".*/\\1/p' | head -n 1)
    elif [ -n "$input" ]; then
      session=$(printf '%s' "$input" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[0-9A-Fa-f-]\\{36\\}"' | head -n 1 | sed 's/.*"\\([0-9A-Fa-f-]*\\)"$/\\1/')
    fi
    ;;
  *)
    event=""
    ;;
esac
[ -n "$event" ] || exit 0
case "\${ORCHA_TERM_ID:-}" in
  ''|*[!0-9]*) exit 0 ;;
esac
f="\${ORCHA_HOOK_ENDPOINT:-}"
{ [ -n "$f" ] && [ -r "$f" ]; } || exit 0
port=$(sed -n 's/^ORCHA_HOOK_PORT=\\([0-9][0-9]*\\)$/\\1/p' "$f" 2>/dev/null | head -n 1)
token=$(sed -n 's/^ORCHA_HOOK_TOKEN=\\([A-Za-z0-9]*\\)$/\\1/p' "$f" 2>/dev/null | head -n 1)
{ [ -n "$port" ] && [ -n "$token" ]; } || exit 0
curl=/usr/bin/curl
[ -x "$curl" ] || curl=$(command -v curl 2>/dev/null) || exit 0
[ -n "$curl" ] || exit 0
printf 'header = "X-Orcha-Hook-Token: %s"\\n' "$token" | "$curl" -q -K - -sS -o /dev/null --noproxy '*' \\
  --connect-timeout 1 --max-time 2 -X POST -H 'Content-Type: application/json' \\
  --data-binary "{\\"event\\":\\"$event\\",\\"detail\\":\\"$detail\\",\\"session\\":\\"$session\\"}" \\
  "http://127.0.0.1:$port/hook/$ORCHA_TERM_ID" >/dev/null 2>&1
exit 0
`
}

/** The shell command a Claude hook runs. A missing script is a silent no-op (stdin drained),
 *  never a failing hook on every tool call (Orca's guard, posix-hook-command.ts). */
export function hookCommand(script: string, event: string): string {
  const q = shQuote(script)
  return `if [ -r ${q} ]; then /bin/sh ${q} ${event}; else cat >/dev/null 2>&1; fi`
}

/** Claude Code's own theme. Claude paints some rows (the echoed prompt, diffs) with its OWN
 *  background colours, so a mismatched theme shows dark bars in a light terminal (or light
 *  bars in a dark one). We launch it in `auto`: it asks the terminal for its background
 *  (OSC 11, answered by xterm from the live theme) and subscribes to scheme-change reports
 *  (?2031), which TerminalView sends on every appearance flip — so even a running session
 *  follows the switch. Set per launch via this --settings file only; ~/.claude is untouched. */
export type ClaudeTheme = 'light' | 'dark' | 'auto'

/** The Claude `--settings` document: the status hooks, plus Claude's theme when known. */
export function claudeHookSettings(script: string, theme?: ClaudeTheme): { hooks: Record<string, unknown[]>; theme?: ClaudeTheme } {
  const hooks: Record<string, unknown[]> = {}
  for (const event of CLAUDE_HOOK_EVENTS) {
    const handler = { type: 'command', command: hookCommand(script, event), timeout: 10 }
    hooks[event] = [MATCHER_EVENTS.has(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] }]
  }
  return theme ? { hooks, theme } : { hooks }
}

const TOKEN_RE = /^[A-Za-z0-9]{16,128}$/

export function endpointFileText(port: number, token: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad hook port')
  if (!TOKEN_RE.test(token)) throw new Error('bad hook token')
  return `ORCHA_HOOK_PORT=${port}\nORCHA_HOOK_TOKEN=${token}\n`
}

export interface HookFs {
  mkdir(p: string): void
  write(p: string, data: string, mode: number): void
}

const realFs: HookFs = {
  mkdir: (p) => {
    mkdirSync(p, { recursive: true, mode: 0o700 })
    chmodSync(p, 0o700) // mkdir's mode applies only on creation
  },
  write: (p, data, mode) => {
    // Atomic: a hook firing mid-write reads the old file or the new one, never half of one.
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, data, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, p)
  }
}

/** Write the script (0700), the Claude settings (0600) and the endpoint file (0600) for this
 *  app run into an owner-only directory. */
export function installAgentHooks(files: AgentHookFiles, port: number, token: string, fs: HookFs = realFs, theme?: ClaudeTheme): void {
  fs.mkdir(files.dir)
  fs.write(files.script, hookScript(), 0o700)
  writeClaudeSettings(files, theme, fs)
  fs.write(files.endpoint, endpointFileText(port, token), 0o600)
}

/** (Re)write only the Claude --settings file — on an appearance change, so new Claude tabs
 *  (and running ones that re-read their settings) follow the app's light/dark theme. */
export function writeClaudeSettings(files: AgentHookFiles, theme?: ClaudeTheme, fs: HookFs = realFs): void {
  fs.write(files.claudeSettings, `${JSON.stringify(claudeHookSettings(files.script, theme), null, 2)}\n`, 0o600)
}

/** The user's own top-level Codex `notify` argv from config.toml text: null = none set,
 *  'invalid' = set but not a plain array of strings we can faithfully re-run (hooks are then
 *  skipped rather than risk breaking the user's notifier). */
export function parseCodexNotify(toml: string): string[] | null | 'invalid' {
  // Top-level keys end at the first table header.
  const header = /^\s*\[/m.exec(toml)
  const top = header ? toml.slice(0, header.index) : toml
  const start = /^\s*notify\s*=\s*/m.exec(top)
  if (!start) return null
  const rest = top.slice(start.index + start[0].length)
  if (!rest.startsWith('[')) return 'invalid'
  const close = rest.indexOf(']')
  if (close < 0) return 'invalid'
  const body = rest.slice(1, close)
  const out: string[] = []
  const STR = /"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g
  let leftover = ''
  let last = 0
  for (const m of body.matchAll(STR)) {
    leftover += body.slice(last, m.index)
    last = m.index! + m[0].length
    if (m[2] !== undefined) out.push(m[2])
    else {
      try {
        out.push(JSON.parse(`"${m[1]}"`) as string)
      } catch {
        return 'invalid'
      }
    }
  }
  leftover += body.slice(last)
  if (!/^[\s,]*$/.test(leftover)) return 'invalid'
  if (out.some((s) => s.includes('\0'))) return 'invalid'
  return out.length > 0 ? out : null
}

/** Read (never write) the user's Codex notify: $CODEX_HOME/config.toml, else ~/.codex. */
export function readCodexNotify(env: Record<string, string | undefined>, home: string): string[] | null | 'invalid' {
  const dir = env.CODEX_HOME && env.CODEX_HOME.startsWith('/') ? env.CODEX_HOME : path.join(home, '.codex')
  let text: string
  try {
    text = readFileSync(path.join(dir, 'config.toml'), 'utf8')
  } catch {
    return null
  }
  return parseCodexNotify(text)
}

/** TOML array of basic strings (JSON string escapes are valid TOML basic-string escapes). */
function tomlStringArray(items: readonly string[]): string {
  return `[${items.map((s) => JSON.stringify(s)).join(',')}]`
}

export interface WireOptions {
  files: AgentHookFiles
  /** The user's own Codex notify (readCodexNotify), looked up only for Codex launches. */
  codexNotify(): string[] | null | 'invalid'
}

/** argv additions for a hooked agent launch, or null (no hooks: probe, unsupported agent, or
 *  the user already passes the same mechanism in their extra args — theirs wins). The hook
 *  args go FIRST, so permission-mode flags and the user's extra args follow unchanged. */
export function wireAgentHooks(
  kind: AgentId,
  args: readonly string[],
  probe: boolean,
  opts: WireOptions
): { args: string[]; mode: HookMode } | null {
  if (probe) return null
  if (kind === 'claude') {
    if (args.some((a) => a === '--settings' || a.startsWith('--settings='))) return null
    return { args: ['--settings', opts.files.claudeSettings, ...args], mode: 'lifecycle' }
  }
  if (kind === 'codex') {
    if (args.some((a) => /^(?:--config=|-c)?\s*notify\s*=/.test(a))) return null
    const user = opts.codexNotify()
    if (user === 'invalid') return null
    const notify = ['/bin/sh', opts.files.script, 'codex-notify', ...(user ?? [])]
    return { args: ['-c', `notify=${tomlStringArray(notify)}`, ...args], mode: 'turn-complete' }
  }
  return null
}
