import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  CLAUDE_HOOK_EVENTS,
  claudeHookSettings,
  endpointFileText,
  hookCommand,
  hookFilePaths,
  installAgentHooks,
  parseCodexNotify,
  readCodexNotify,
  wireAgentHooks,
  writeClaudeSettings,
  type AgentHookFiles
} from './agentHooks'
import { startHookReceiver, type HookReceiver } from './hookReceiver'
import type { HookEvent } from './agentStatus'
import { composeAgentArgs } from '../shared/agents'
import { buildLaunch, shQuote } from './terminalLaunch'

const TOKEN = 'f'.repeat(64)
let tmp = ''
let files: AgentHookFiles

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'orcha-hooks-'))
  files = hookFilePaths(path.join(tmp, 'user data')) // a space, like "Application Support"
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('hook files', () => {
  it('writes the script 0700, settings + endpoint 0600, in an owner-only dir', () => {
    installAgentHooks(files, 4321, TOKEN)
    expect(statSync(files.dir).mode & 0o777).toBe(0o700)
    expect(statSync(files.script).mode & 0o777).toBe(0o700)
    expect(statSync(files.claudeSettings).mode & 0o777).toBe(0o600)
    expect(statSync(files.endpoint).mode & 0o777).toBe(0o600)
    expect(readFileSync(files.endpoint, 'utf8')).toBe(`ORCHA_HOOK_PORT=4321\nORCHA_HOOK_TOKEN=${TOKEN}\n`)
  })

  it('endpoint values must be shell-inert', () => {
    expect(() => endpointFileText(0, TOKEN)).toThrow()
    expect(() => endpointFileText(80, 'abc;rm -rf ~')).toThrow()
  })

  it('Claude settings hold ONLY hooks, one guarded command per event, tools matched with "*"', () => {
    const s = claudeHookSettings('/x y/orcha-hook.sh')
    expect(Object.keys(s)).toEqual(['hooks'])
    expect(Object.keys(s.hooks)).toEqual([...CLAUDE_HOOK_EVENTS])
    for (const e of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop']) expect(s.hooks[e]).toBeDefined()
    expect(s.hooks.PreToolUse).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: hookCommand('/x y/orcha-hook.sh', 'PreToolUse'), timeout: 10 }] }
    ])
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: hookCommand('/x y/orcha-hook.sh', 'Stop'), timeout: 10 }] }])
    expect(hookCommand("/x y/it's.sh", 'Stop')).toBe(`if [ -r '/x y/it'\\''s.sh' ]; then /bin/sh '/x y/it'\\''s.sh' Stop; else cat >/dev/null 2>&1; fi`)
  })
})

describe('launch argv with hooks (Settings › Agents flags preserved)', () => {
  const opts = (notify: string[] | null | 'invalid' = null) => ({ files, codexNotify: () => notify })

  it('Claude: --settings <file> first, then Yolo / Manual flags and extra args unchanged', () => {
    const yolo = composeAgentArgs('claude', 'yolo', ['--model', 'opus'])
    const w = wireAgentHooks('claude', yolo, false, opts())
    expect(w).toEqual({ args: ['--settings', files.claudeSettings, ...yolo], mode: 'lifecycle' })
    expect(yolo).toContain('--dangerously-skip-permissions')
    const manual = composeAgentArgs('claude', 'manual', [])
    expect(wireAgentHooks('claude', manual, false, opts())?.args).toEqual(['--settings', files.claudeSettings, ...manual])
    // the whole launch script keeps every argument single-quoted
    const plan = buildLaunch('claude', '/bin/zsh', { path: '/usr/local/bin/claude', args: w!.args })
    expect(plan.args.at(-1)).toContain(`exec '/usr/local/bin/claude' '--settings' '${files.claudeSettings}' '--dangerously-skip-permissions' '--model' 'opus'`)
  })

  it('no hooks for a probe, an unsupported agent, or when the user passes --settings themselves', () => {
    expect(wireAgentHooks('claude', ['--version'], true, opts())).toBeNull()
    expect(wireAgentHooks('gemini', [], false, opts())).toBeNull()
    expect(wireAgentHooks('claude', ['--settings', '/mine.json'], false, opts())).toBeNull()
    expect(wireAgentHooks('claude', ['--settings={"a":1}'], false, opts())).toBeNull()
  })

  it('Codex: -c notify=[sh, script, codex-notify, …the user’s own notify] first, then the rest', () => {
    const yolo = composeAgentArgs('codex', 'yolo', ['--model', 'o3'])
    const w = wireAgentHooks('codex', yolo, false, opts(['/Apps/My Notifier', 'turn-ended']))
    expect(w?.mode).toBe('turn-complete')
    expect(w?.args.slice(2)).toEqual(yolo)
    expect(w?.args[0]).toBe('-c')
    expect(w?.args[1]).toBe(`notify=${JSON.stringify(['/bin/sh', files.script, 'codex-notify', '/Apps/My Notifier', 'turn-ended'])}`)
    expect(wireAgentHooks('codex', [], false, opts())?.args[1]).toBe(`notify=${JSON.stringify(['/bin/sh', files.script, 'codex-notify'])}`)
    // user already overrides notify, or has one we can't faithfully re-run → leave it alone
    expect(wireAgentHooks('codex', ['-c', 'notify=["x"]'], false, opts())).toBeNull()
    expect(wireAgentHooks('codex', ['--config=notify=["x"]'], false, opts())).toBeNull()
    expect(wireAgentHooks('codex', [], false, opts('invalid'))).toBeNull()
  })

  it('reads (never writes) the user’s Codex notify from config.toml', () => {
    expect(parseCodexNotify('model = "o3"\n')).toBeNull()
    expect(parseCodexNotify('notify = ["/a b/c", \'lit\', "t\\"q"]\n[projects."/x"]\nnotify = 1')).toEqual(['/a b/c', 'lit', 't"q'])
    expect(parseCodexNotify('notify = [\n  "a",\n  "b",\n]\n')).toEqual(['a', 'b'])
    expect(parseCodexNotify('[tui]\nnotify = ["a"]\n')).toBeNull() // not top-level
    expect(parseCodexNotify('notify = "a"\n')).toBe('invalid')
    expect(parseCodexNotify('notify = ["a", 3]\n')).toBe('invalid')
    const home = path.join(tmp, 'home')
    expect(readCodexNotify({}, home)).toBeNull()
    const codexHome = path.join(tmp, 'codex-home')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(path.join(codexHome, 'config.toml'), 'notify = ["n"]\n')
    const before = readFileSync(path.join(codexHome, 'config.toml'), 'utf8')
    expect(readCodexNotify({ CODEX_HOME: codexHome }, home)).toEqual(['n'])
    expect(readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toBe(before)
  })
})

// ---- the relay script itself: real /bin/sh + curl against a real receiver ----

interface Run {
  code: number | null
  stdout: string
  ms: number
}

function runScript(args: string[], env: Record<string, string>, stdin = ''): Promise<Run> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    // exactly how Claude runs it: `sh -c <hookCommand>` (codex-notify argv appended likewise)
    const child = spawn('/bin/sh', ['-c', hookCommand(files.script, args.map(shQuote).join(' '))], {
      env: { PATH: '/usr/bin:/bin', ...env }
    })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - t0 }))
    child.stdin.end(stdin)
  })
}

describe('hook relay script', () => {
  let receiver: HookReceiver | null = null
  let got: Array<[number, HookEvent]> = []
  const envFor = (id = 5): Record<string, string> => ({ ORCHA_TERM_ID: String(id), ORCHA_HOOK_ENDPOINT: files.endpoint })

  async function live(): Promise<void> {
    got = []
    receiver = await startHookReceiver({ token: TOKEN, accepts: (id) => id === 5, deliver: (id, e) => got.push([id, e]) })
    installAgentHooks(files, receiver.port, TOKEN)
  }
  afterEach(async () => {
    await receiver?.close()
    receiver = null
  })

  it('posts the event for its session, prints nothing, exits 0 (big stdin drained)', async () => {
    await live()
    const bigJson = JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(300_000) })
    const r = await runScript(['PostToolUse'], envFor(), bigJson)
    expect(r).toMatchObject({ code: 0, stdout: '' })
    const r2 = await runScript(['Stop'], envFor(), '{}')
    expect(r2).toMatchObject({ code: 0, stdout: '' })
    expect(got).toEqual([
      [5, { event: 'PostToolUse', detail: null }],
      [5, { event: 'Stop', detail: null }]
    ])
  })

  it('forwards the conversation id: Claude session_id on a prompt / Stop, Codex thread-id on a finished turn', async () => {
    await live()
    const sid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const tid = '0199a213-81c0-7800-8aa1-bbab2a035a53'
    // A prompt that itself quotes a session_id is JSON-escaped, so the real (first) key wins.
    await runScript(['UserPromptSubmit'], envFor(), JSON.stringify({ session_id: sid, prompt: 'say "session_id":"11111111-1111-1111-1111-111111111111"' }))
    await runScript(['Stop'], envFor(), `{"session_id": "${sid}", "transcript_path": "/x"}`)
    await runScript(['PreToolUse'], envFor(), JSON.stringify({ session_id: sid })) // tool events: not read
    await runScript(['Stop'], envFor(), '{"session_id":"$(touch /tmp/pwn)"}') // not a UUID → no id
    await runScript(['codex-notify', JSON.stringify({ type: 'agent-turn-complete', 'thread-id': tid, 'turn-id': '1' })], envFor())
    expect(got).toEqual([
      [5, { event: 'UserPromptSubmit', detail: null, session: sid }],
      [5, { event: 'Stop', detail: null, session: sid }],
      [5, { event: 'PreToolUse', detail: null }],
      [5, { event: 'Stop', detail: null }],
      [5, { event: 'TurnComplete', detail: null, session: tid }]
    ])
  })

  it('Notification: forwards only its notification_type', async () => {
    await live()
    await runScript(['Notification'], envFor(), '{"message":"Claude needs your permission","notification_type":"permission_prompt","x":"\\"}"}')
    await runScript(['Notification'], envFor(), '{"message":"hi"}')
    expect(got).toEqual([
      [5, { event: 'Notification', detail: 'permission_prompt' }],
      [5, { event: 'Notification', detail: null }]
    ])
  })

  it('unknown session / no session env / unknown event: exit 0, nothing accepted', async () => {
    await live()
    expect((await runScript(['Stop'], envFor(6), '{}')).code).toBe(0)
    expect((await runScript(['Stop'], {}, '{}')).code).toBe(0)
    expect((await runScript(['Stop'], { ORCHA_TERM_ID: '5;x', ORCHA_HOOK_ENDPOINT: files.endpoint }, '{}')).code).toBe(0)
    expect((await runScript(['Evil'], envFor(), '{}')).code).toBe(0)
    expect(got).toEqual([])
  })

  it('endpoint down: exits 0 quickly', async () => {
    await live()
    await receiver!.close()
    receiver = null
    const r = await runScript(['Stop'], envFor(), '{}')
    expect(r).toMatchObject({ code: 0, stdout: '' })
    expect(r.ms).toBeLessThan(1500)
  })

  it('endpoint accepts but never answers: curl times out, still exit 0 within ~2 s', async () => {
    const sockets: net.Socket[] = []
    const hang = net.createServer((s) => sockets.push(s))
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()))
    installAgentHooks(files, (hang.address() as net.AddressInfo).port, TOKEN)
    const r = await runScript(['Stop'], envFor(), '{}')
    sockets.forEach((s) => s.destroy())
    hang.close()
    expect(r).toMatchObject({ code: 0, stdout: '' })
    expect(r.ms).toBeGreaterThanOrEqual(1500)
    expect(r.ms).toBeLessThan(4000)
  }, 10_000)

  it('a proxy in the env is bypassed for loopback', async () => {
    await live()
    await runScript(['Stop'], { ...envFor(), http_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' }, '{}')
    expect(got).toEqual([[5, { event: 'Stop', detail: null }]])
  })

  it('missing script: the hook command is a silent no-op (exit 0, stdin drained)', async () => {
    const child = spawn('/bin/sh', ['-c', hookCommand(path.join(tmp, 'gone.sh'), 'Stop')])
    const closed = new Promise((r) => child.on('close', r))
    child.stdin.end('{}')
    expect(await closed).toBe(0)
  })

  it('Codex notify: agent-turn-complete → TurnComplete, and the user’s own notify still runs with the JSON', async () => {
    await live()
    const out = path.join(tmp, 'user-notify.out')
    const json = '{"type":"agent-turn-complete","thread-id":"t","last-assistant-message":"hi"}'
    const r = await runScript(['codex-notify', '/bin/sh', '-c', 'printf "%s" "$1" > "$OUT"', 'sh', json], { ...envFor(), OUT: out })
    expect(r).toMatchObject({ code: 0, stdout: '' })
    for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((res) => setTimeout(res, 20))
    expect(readFileSync(out, 'utf8')).toBe(json)
    await runScript(['codex-notify', '{"type":"approval-requested"}'], envFor())
    expect(got).toEqual([[5, { event: 'TurnComplete', detail: null }]])
  })
})


describe('Claude theme via the per-launch --settings file', () => {
  it('adds theme only when known; hooks unchanged', () => {
    expect(claudeHookSettings('/x/hook.sh')).not.toHaveProperty('theme')
    const light = claudeHookSettings('/x/hook.sh', 'light')
    expect(light.theme).toBe('light')
    expect(Object.keys(light.hooks)).toEqual(Object.keys(claudeHookSettings('/x/hook.sh').hooks))
    expect(claudeHookSettings('/x/hook.sh', 'dark').theme).toBe('dark')
  })

  it('install writes the theme (the app launches Claude in auto), and a rewrite touches only the settings file', () => {
    const writes: Array<[string, string]> = []
    const fs = { mkdir: () => {}, write: (p: string, d: string) => void writes.push([p, d]) }
    const files = hookFilePaths('/tmp/ud')
    installAgentHooks(files, 5555, 'a'.repeat(32), fs, 'auto')
    const first = writes.find(([p]) => p === files.claudeSettings)!
    expect(JSON.parse(first[1]).theme).toBe('auto')
    writes.length = 0
    writeClaudeSettings(files, 'dark', fs)
    expect(writes.map(([p]) => p)).toEqual([files.claudeSettings])
    expect(JSON.parse(writes[0][1]).theme).toBe('dark')
  })
})
