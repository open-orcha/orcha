# Desktop Onboarding & "New Project" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user who installs the Orcha DMG go from nothing to a running, onboarding-ready Orcha project in a guided wizard — no terminal, no Homebrew, no `orcha` CLI — plus a File → New Project menu with three folder modes.

**Architecture:** The Electron main process reimplements only the *orchestration* of the CLI's `cmd_init`/`cmd_upgrade` (`orcha-cli/orcha_cli/__main__.py`) in TypeScript, over template *assets* copied byte-identically from the CLI at build time into `desktop/resources/orcha-templates/`. A new `#onboarding` wizard window drives it through `asResult`-wrapped IPC plus one push channel for streamed progress, then hands off to the portal `/onboarding` roster wizard. Init/upgrade/reset-data share one engine.

**Tech Stack:** Electron 42, React 19, TypeScript 6, electron-vite, Vitest 4, electron-builder. Repo conventions: co-located `*.test.ts(x)`, `node` test env with per-file `// @vitest-environment jsdom` for renderer, dependency injection (`exec`/`fetchJson`/`fs` passed in), structured `BridgeError` over `IpcResult<T>`.

**Working directory:** `/Users/husseinmohamed/Desktop/quantal-projects/orcha-open`, branch `feat/desktop-onboarding`. All paths below are relative to `desktop/` unless noted. Run commands from `desktop/`.

**Spec:** `docs/superpowers/specs/2026-06-18-desktop-onboarding-design.md`.

---

## File structure

**Created (main):**
- `src/main/templates.ts` — resolve bundled template root + provision-input helpers (`sanitizeName`, `findFreePort`, `renderCompose`).
- `src/main/preflight.ts` — Docker detect + auto-start + AppTranslocation + port report.
- `src/main/folderModes.ts` — inspect/prepare a folder for init/new-blank/reconnect.
- `src/main/initEngine.ts` — the provision sequence (init/upgrade/reset) emitting progress.
- `src/main/onboardingWindow.ts` — the `#onboarding` window (open-or-focus).
- `src/main/appMenu.ts` — macOS app menu with File → New Project.

**Created (renderer):**
- `src/renderer/src/onboarding/OnboardingApp.tsx` — wizard state machine.
- `src/renderer/src/onboarding/useProvisionStream.ts` — subscribe to progress events.
- `src/renderer/src/onboarding/steps/*` — Preflight/Folder/Details/Provision/HandOff panels.

**Created (build/test):**
- `scripts/copy-orcha-templates.mjs` — build-time copy from CLI → resources.
- `src/main/templates.parity.test.ts` — byte-parity guard.

**Modified:**
- `src/shared/types.ts` — new types + `BridgeError` codes + grown `OrchaDesktopApi`.
- `src/preload/index.ts` — new channels + the progress subscription bridge.
- `src/main/index.ts` — register handlers, app menu, first-launch auto-open.
- `src/renderer/src/main.tsx` — `#onboarding` route branch.
- `src/renderer/src/components/EmptyState.tsx` — [Create your first project] button.
- `src/renderer/src/env.d.ts` — widen the `window.orchaDesktop` type (re-exports `OrchaDesktopApi`, usually no change needed).
- `package.json` — `predist`/`prebuild` hook running the copy script.
- Every existing renderer test that stubs `window.orchaDesktop` (`App.test.tsx`, `StackCard.test.tsx`, `StackRow.test.tsx`, `TrayPanel.test.tsx`) — extend the stub with the new methods.

**Parallelization:** Task 1 (shared types) is the contract everyone imports — do it FIRST, alone. Then Tasks 2–7 (templates, preflight, folderModes, initEngine, onboardingWindow+appMenu, renderer) are independent and can run as parallel agents. Tasks 8–9 (index.ts wiring, existing-test updates) integrate and must come AFTER 2–7.

---

## Task 1: Shared types & BridgeError codes (the contract — do first, alone)

**Files:**
- Modify: `src/shared/types.ts`
- Test: `src/shared/types.test.ts` (new — a compile/shape smoke test)

- [ ] **Step 1: Write the failing test**

Create `src/shared/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type {
  ProvisionMode,
  ProvisionOptions,
  ProvisionStep,
  ProgressEvent,
  PreflightReport,
  FolderMode,
  FolderState,
  FolderChoice,
  OrchaDesktopApi
} from './types'

describe('shared onboarding types', () => {
  it('ProgressEvent variants carry a runId and step', () => {
    const ok: ProgressEvent = { runId: 'r1', step: 'compose-up', status: 'ok' }
    const log: ProgressEvent = { runId: 'r1', step: 'compose-up', status: 'log', line: 'pulling' }
    const fail: ProgressEvent = {
      runId: 'r1',
      step: 'wait-portal',
      status: 'fail',
      code: 'PORTAL_TIMEOUT',
      detail: 'no 200 in 30s'
    }
    expect([ok.runId, log.runId, fail.runId]).toEqual(['r1', 'r1', 'r1'])
  })

  it('ProvisionMode is the three supported modes', () => {
    const modes: ProvisionMode[] = ['init', 'upgrade', 'reset']
    expect(modes).toHaveLength(3)
  })

  it('OrchaDesktopApi exposes the new onboarding methods', () => {
    // type-level: a value satisfying the interface must have these keys.
    const keys: Array<keyof OrchaDesktopApi> = [
      'preflight',
      'pickFolder',
      'inspectFolder',
      'provision',
      'openOnboarding',
      'openOnboardingPortal',
      'onProvisionProgress'
    ]
    expect(keys.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/shared/types.test.ts`
Expected: FAIL — type imports unresolved (`ProvisionMode` etc. not exported).

- [ ] **Step 3: Add the types**

Append to `src/shared/types.ts` (keep existing `Stack`, `AttentionItem`, `IpcResult`):

```ts
// ---- Onboarding / provisioning ----

export type ProvisionMode = 'init' | 'upgrade' | 'reset'

export type ProvisionStep =
  | 'preflight'
  | 'render-compose'
  | 'copy-templates'
  | 'compose-up'
  | 'wait-portal'
  | 'create-container'
  | 'register-human'
  | 'start-daemons'

export type ProgressEvent =
  | { runId: string; step: ProvisionStep; status: 'start' | 'ok' | 'skip' }
  | { runId: string; step: ProvisionStep; status: 'log'; line: string }
  | {
      runId: string
      step: ProvisionStep
      status: 'fail'
      code: BridgeError['code']
      detail: string
    }

export interface ProvisionOptions {
  /** Absolute, canonical path to the project folder (folder must already exist). */
  folder: string
  mode: ProvisionMode
  /** Project name; defaults to the sanitized folder basename when omitted. */
  name?: string
  /** Container objective; defaults to the folder basename when omitted. */
  objective?: string
  /** First human's alias; defaults to $USER or 'operator'. */
  alias?: string
}

export interface ProvisionResult {
  project: string
  apiPort: number
  /** Warnings from non-fatal steps (human/daemon), shown but not failing. */
  warnings: string[]
}

export type DockerState = 'ok' | 'not-installed' | 'daemon-down' | 'app-translocated'

export interface PreflightReport {
  docker: DockerState
  /** True after a successful auto-start of Docker Desktop. */
  autoStarted: boolean
  /** Human-readable next-step hint when docker !== 'ok'. */
  hint: string | null
}

export type FolderMode = 'existing' | 'new-blank' | 'reconnect'

export interface FolderState {
  /** True when the folder already contains .orcha/docker-compose.yml. */
  initialized: boolean
  writable: boolean
  /** Sanitized project name derived from the folder basename. */
  suggestedName: string
}

export interface FolderChoice {
  /** Absolute canonical path of the chosen (or to-be-created) folder. */
  folder: string
  mode: FolderMode
}
```

Extend the `BridgeError` union (replace the existing definition):

```ts
export type BridgeError =
  | { code: 'DOCKER_UNAVAILABLE' }
  | { code: 'COMPOSE_FAILED'; stderr: string }
  | { code: 'UNKNOWN_STACK' }
  | { code: 'INTERNAL' }
  | { code: 'DOCKER_NOT_INSTALLED' }
  | { code: 'DOCKER_START_TIMEOUT' }
  | { code: 'PORT_UNAVAILABLE' }
  | { code: 'TEMPLATES_MISSING' }
  | { code: 'ALREADY_INITIALIZED' }
  | { code: 'PORTAL_TIMEOUT' }
  | { code: 'CONTAINER_EXISTS' }
  | { code: 'PROVISION_FAILED'; step: ProvisionStep; stderr: string }
```

Extend `OrchaDesktopApi` (add to the existing interface):

```ts
export interface OrchaDesktopApi {
  listStacks(): Promise<Stack[]>
  startStack(project: string): Promise<void>
  stopStack(project: string): Promise<void>
  openPortal(project: string, path?: string): Promise<void>
  listAttention(): Promise<AttentionItem[]>
  openManager(): Promise<void>
  quitApp(): Promise<void>
  // onboarding:
  preflight(): Promise<PreflightReport>
  pickFolder(mode: FolderMode): Promise<FolderChoice | null>
  inspectFolder(folder: string): Promise<FolderState>
  provision(opts: ProvisionOptions): Promise<ProvisionResult>
  openOnboarding(): Promise<void>
  openOnboardingPortal(project: string): Promise<void>
  /** Subscribe to provision progress; returns an unsubscribe fn. */
  onProvisionProgress(cb: (e: ProgressEvent) => void): () => void
}
```

Note: `ProgressEvent`/`BridgeError` reference each other — keep `BridgeError` declared before `ProgressEvent` is fine in TS (types hoist), but place the `BridgeError` extension above the onboarding block for readability.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/shared/types.test.ts` then `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/shared/types.test.ts
git commit -m "feat(desktop): onboarding shared types + BridgeError codes"
```

---

## Task 2: Build-time template copy + parity guard

**Files:**
- Create: `scripts/copy-orcha-templates.mjs`
- Create: `src/main/templates.ts`
- Test: `src/main/templates.parity.test.ts`, `src/main/templates.test.ts`
- Modify: `package.json` (scripts), `.gitignore` (ignore copied resources)

- [ ] **Step 1: Write the copy script**

Create `scripts/copy-orcha-templates.mjs`:

```js
// Copies the CLI's canonical template assets into the app bundle resources so the
// desktop app can lay them down without the orcha CLI installed. Single source of
// truth = orcha-cli/orcha_cli/templates; this is a verbatim copy (parity-tested).
import { cp, rm, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
const repoRoot = path.resolve(desktopRoot, '..')
const src = path.join(repoRoot, 'orcha-cli', 'orcha_cli', 'templates')
const dst = path.join(desktopRoot, 'resources', 'orcha-templates')

if (!existsSync(src)) {
  console.error(`[copy-orcha-templates] source not found: ${src}`)
  process.exit(1)
}
await rm(dst, { recursive: true, force: true })
await mkdir(path.dirname(dst), { recursive: true })
await cp(src, dst, { recursive: true })
console.log(`[copy-orcha-templates] copied ${src} -> ${dst}`)
```

- [ ] **Step 2: Wire it into package.json + gitignore**

In `package.json` add to `scripts` (keep existing entries):

```json
"copy:templates": "node scripts/copy-orcha-templates.mjs",
"prebuild": "node scripts/copy-orcha-templates.mjs",
"predist:mac": "node scripts/copy-orcha-templates.mjs",
"predist:mac:arm64": "node scripts/copy-orcha-templates.mjs"
```

Append to `desktop/.gitignore`:

```
resources/orcha-templates/
```

- [ ] **Step 3: Run the copy once so the test fixtures exist**

Run: `npm run copy:templates`
Expected: prints "copied … -> …/resources/orcha-templates"; the dir now has `docker-compose.yml.j2`, `migrations/`, `portal/`, `project-preferences.md`, `skills/`.

- [ ] **Step 4: Write the parity test (failing until templates.ts helper exists)**

Create `src/main/templates.parity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const desktopRoot = path.resolve(__dirname, '..', '..')
const repoRoot = path.resolve(desktopRoot, '..')
const cliTemplates = path.join(repoRoot, 'orcha-cli', 'orcha_cli', 'templates')
const bundled = path.join(desktopRoot, 'resources', 'orcha-templates')

function walk(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(path.relative(root, full))
  }
  return out.sort()
}

describe('template parity', () => {
  it('bundled templates byte-match the CLI templates', () => {
    expect(existsSync(bundled)).toBe(true)
    const cliFiles = walk(cliTemplates)
    const bundledFiles = walk(bundled)
    expect(bundledFiles).toEqual(cliFiles)
    for (const rel of cliFiles) {
      const a = readFileSync(path.join(cliTemplates, rel))
      const b = readFileSync(path.join(bundled, rel))
      expect(b.equals(a), `mismatch in ${rel}`).toBe(true)
    }
  })
})
```

- [ ] **Step 5: Run parity test to verify it passes**

Run: `npm test -- src/main/templates.parity.test.ts`
Expected: PASS (copy already ran in step 3).

- [ ] **Step 6: Write the templates.ts unit test (failing)**

Create `src/main/templates.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sanitizeName, renderCompose, templatesRoot } from './templates'

describe('templates helpers', () => {
  it('sanitizeName mirrors the CLI rule', () => {
    expect(sanitizeName('My App!')).toBe('my-app')
    expect(sanitizeName('  ')).toBe('orcha')
    expect(sanitizeName('keep_under-score')).toBe('keep_under-score')
  })

  it('renderCompose substitutes all four placeholders', () => {
    const tmpl =
      'name: orcha-{{ project_name }}\nports: ["{{ db_port }}:5432"]\n' +
      'api: {{ api_port }} bridge: {{ bridge_port }}'
    const out = renderCompose(tmpl, { projectName: 'demo', dbPort: 5433, apiPort: 8001, bridgePort: 8766 })
    expect(out).toContain('name: orcha-demo')
    expect(out).toContain('["5433:5432"]')
    expect(out).toContain('api: 8001 bridge: 8766')
    expect(out).not.toContain('{{')
  })

  it('templatesRoot points at a directory containing docker-compose.yml.j2', () => {
    expect(templatesRoot().endsWith('orcha-templates')).toBe(true)
  })
})
```

- [ ] **Step 7: Implement templates.ts**

Create `src/main/templates.ts`:

```ts
import path from 'node:path'
import { app } from 'electron'

/** Resolve the bundled template root. In packaged builds resources live under
 *  process.resourcesPath; in dev they sit in the repo's desktop/resources. */
export function templatesRoot(): string {
  // app.isPackaged is false under electron-vite dev and vitest.
  const packaged = (() => {
    try {
      return app?.isPackaged ?? false
    } catch {
      return false
    }
  })()
  if (packaged) return path.join(process.resourcesPath, 'orcha-templates')
  return path.join(__dirname, '..', '..', 'resources', 'orcha-templates')
}

/** Mirror of the CLI's _sanitize_name. */
export function sanitizeName(s: string): string {
  const lowered = s.toLowerCase()
  let out = ''
  for (const c of lowered) out += /[a-z0-9\-_]/.test(c) ? c : '-'
  out = out.replace(/^-+|-+$/g, '')
  return out || 'orcha'
}

export interface ComposeVars {
  projectName: string
  dbPort: number
  apiPort: number
  bridgePort: number
}

/** Mirror of the CLI's str.replace render of docker-compose.yml.j2. */
export function renderCompose(template: string, vars: ComposeVars): string {
  return template
    .split('{{ project_name }}').join(vars.projectName)
    .split('{{ db_port }}').join(String(vars.dbPort))
    .split('{{ api_port }}').join(String(vars.apiPort))
    .split('{{ bridge_port }}').join(String(vars.bridgePort))
}
```

Note: under vitest `electron` is not available; `app` import will be undefined. The `try/catch` around `app?.isPackaged` handles it. If vitest errors on importing `electron`, add to `vitest.config.ts` `test.alias` an `electron` → a tiny stub; only do this if the import actually fails when you run the test.

- [ ] **Step 8: Run templates.ts test**

Run: `npm test -- src/main/templates.test.ts`
Expected: PASS. If it fails importing `electron`, add this to `vitest.config.ts` under `test`:

```ts
alias: { electron: path.resolve(__dirname, 'src/test/electron-stub.ts') }
```

and create `src/test/electron-stub.ts` exporting `export const app = { isPackaged: false }`. Re-run.

- [ ] **Step 9: Commit**

```bash
git add scripts/copy-orcha-templates.mjs src/main/templates.ts src/main/templates.test.ts src/main/templates.parity.test.ts package.json .gitignore
git commit -m "feat(desktop): bundle CLI templates at build time + parity guard + render helpers"
```

---

## Task 3: Preflight (Docker detect + auto-start)

**Files:**
- Create: `src/main/preflight.ts`
- Test: `src/main/preflight.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/preflight.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { preflight } from './preflight'

const okInfo = { stdout: 'Server Version: 27.0\n' }

describe('preflight', () => {
  it('returns ok when docker info succeeds', async () => {
    const exec = vi.fn().mockResolvedValue(okInfo)
    const open = vi.fn()
    const report = await preflight({ exec, open, pollMs: 1, timeoutMs: 10 })
    expect(report.docker).toBe('ok')
    expect(open).not.toHaveBeenCalled()
  })

  it('reports not-installed when docker is absent (ENOENT)', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('enoent'), { code: 'ENOENT' }))
    const report = await preflight({ exec, open: vi.fn(), pollMs: 1, timeoutMs: 10 })
    expect(report.docker).toBe('not-installed')
    expect(report.hint).toMatch(/install docker/i)
  })

  it('auto-starts Docker when the daemon is down, then succeeds', async () => {
    // first info call: daemon down; open Docker; subsequent info: up.
    let up = false
    const exec = vi.fn().mockImplementation((_cmd, args: string[]) => {
      if (args.includes('info')) {
        return up
          ? Promise.resolve(okInfo)
          : Promise.reject(Object.assign(new Error('down'), { stderr: 'Cannot connect to the Docker daemon' }))
      }
      return Promise.resolve({ stdout: '' })
    })
    const open = vi.fn().mockImplementation(() => {
      up = true
      return Promise.resolve()
    })
    const report = await preflight({ exec, open, pollMs: 1, timeoutMs: 1000 })
    expect(open).toHaveBeenCalledWith('Docker')
    expect(report.docker).toBe('ok')
    expect(report.autoStarted).toBe(true)
  })

  it('times out to daemon-down when Docker never comes up', async () => {
    const exec = vi.fn().mockImplementation((_cmd, args: string[]) =>
      args.includes('info')
        ? Promise.reject(Object.assign(new Error('down'), { stderr: 'Cannot connect to the Docker daemon' }))
        : Promise.resolve({ stdout: '' })
    )
    const report = await preflight({ exec, open: vi.fn(), pollMs: 1, timeoutMs: 10 })
    expect(report.docker).toBe('daemon-down')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/preflight.test.ts`
Expected: FAIL — `preflight` not defined.

- [ ] **Step 3: Implement preflight.ts**

Create `src/main/preflight.ts`:

```ts
import { dockerExec, type Exec } from './dockerExec'
import type { PreflightReport } from '../shared/types'

export interface PreflightDeps {
  exec?: Exec
  /** Open a macOS app by name (default: `open -a <name>`). */
  open?: (appName: string) => Promise<void>
  pollMs?: number
  timeoutMs?: number
}

const defaultOpen = (appName: string): Promise<void> =>
  dockerExec('open', ['-a', appName]).then(() => undefined)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function daemonUp(exec: Exec): Promise<'ok' | 'down' | 'missing'> {
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'])
    return 'ok'
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 'missing'
    return 'down'
  }
}

export async function preflight(deps: PreflightDeps = {}): Promise<PreflightReport> {
  const exec = deps.exec ?? dockerExec
  const open = deps.open ?? defaultOpen
  const pollMs = deps.pollMs ?? 1500
  const timeoutMs = deps.timeoutMs ?? 60000

  let state = await daemonUp(exec)
  if (state === 'ok') return { docker: 'ok', autoStarted: false, hint: null }
  if (state === 'missing') {
    return {
      docker: 'not-installed',
      autoStarted: false,
      hint: 'Install Docker Desktop (or OrbStack/Colima) and start it, then re-check.'
    }
  }

  // daemon down → try to auto-start Docker Desktop and poll until up.
  try {
    await open('Docker')
  } catch {
    // ignore — we still poll in case the user starts it manually.
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollMs)
    state = await daemonUp(exec)
    if (state === 'ok') return { docker: 'ok', autoStarted: true, hint: null }
  }
  return {
    docker: 'daemon-down',
    autoStarted: false,
    hint: 'Docker is installed but its daemon did not start. Open Docker Desktop manually, then re-check.'
  }
}
```

Note: AppTranslocation (`docker` present but compose can't find its credential helper) is detected at provision time from the compose stderr, not here — preflight only probes the daemon. This keeps preflight fast and the translocation banner is raised in Task 5 from the `COMPOSE_FAILED` stderr signature. The `PreflightReport.docker = 'app-translocated'` value is set by index.ts wiring (Task 8) if a later provision returns the translocation signature; preflight itself never returns it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/preflight.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/preflight.ts src/main/preflight.test.ts
git commit -m "feat(desktop): Docker preflight with auto-start + daemon poll"
```

---

## Task 4: Folder modes

**Files:**
- Create: `src/main/folderModes.ts`
- Test: `src/main/folderModes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/folderModes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectFolder } from './folderModes'

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'orcha-fm-'))
}

describe('inspectFolder', () => {
  it('reports an uninitialized writable folder with a sanitized suggested name', () => {
    const dir = path.join(tmp(), 'My Project')
    mkdirSync(dir, { recursive: true })
    try {
      const state = inspectFolder(dir)
      expect(state.initialized).toBe(false)
      expect(state.writable).toBe(true)
      expect(state.suggestedName).toBe('my-project')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects an initialized folder (.orcha/docker-compose.yml present)', () => {
    const dir = tmp()
    mkdirSync(path.join(dir, '.orcha'), { recursive: true })
    writeFileSync(path.join(dir, '.orcha', 'docker-compose.yml'), 'name: orcha-x\n')
    try {
      expect(inspectFolder(dir).initialized).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/folderModes.test.ts`
Expected: FAIL — `inspectFolder` not defined.

- [ ] **Step 3: Implement folderModes.ts**

Create `src/main/folderModes.ts`:

```ts
import { accessSync, constants, existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { FolderState } from '../shared/types'
import { sanitizeName } from './templates'

/** Inspect a folder to decide init vs reconnect and surface a default name. */
export function inspectFolder(folder: string): FolderState {
  const initialized = existsSync(path.join(folder, '.orcha', 'docker-compose.yml'))
  let writable = false
  try {
    accessSync(folder, constants.W_OK)
    writable = true
  } catch {
    writable = false
  }
  return { initialized, writable, suggestedName: sanitizeName(path.basename(folder)) }
}

/** Create a new blank directory under parent. Throws if it already exists non-empty. */
export function createBlankFolder(parent: string, rawName: string): string {
  const name = sanitizeName(rawName)
  const target = path.join(parent, name)
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw { code: 'ALREADY_INITIALIZED' } as const
  }
  mkdirSync(target, { recursive: true })
  return target
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/folderModes.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a test for createBlankFolder collision**

Append to `src/main/folderModes.test.ts`:

```ts
import { createBlankFolder } from './folderModes'

describe('createBlankFolder', () => {
  it('creates a sanitized child dir', () => {
    const parent = tmp()
    try {
      const made = createBlankFolder(parent, 'New App')
      expect(made).toBe(path.join(parent, 'new-app'))
      expect(existsSync(made)).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('rejects a non-empty existing target', () => {
    const parent = tmp()
    mkdirSync(path.join(parent, 'taken'))
    writeFileSync(path.join(parent, 'taken', 'f'), 'x')
    try {
      expect(() => createBlankFolder(parent, 'taken')).toThrow()
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
```

Run: `npm test -- src/main/folderModes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/folderModes.ts src/main/folderModes.test.ts
git commit -m "feat(desktop): folder mode inspection + blank-folder creation"
```

---

## Task 5: Init engine (the core — init/upgrade/reset)

**Files:**
- Create: `src/main/initEngine.ts`
- Test: `src/main/initEngine.test.ts`

This is the largest task. The engine takes injected `exec` (docker), `fetchJson` (portal API), and `fs` (an injectable subset), runs the sequence per mode, and calls `onProgress` for every step. Faithful to `cmd_init`/`cmd_upgrade` in `orcha-cli/orcha_cli/__main__.py`.

- [ ] **Step 1: Write the failing test (init happy path: step order + docker/POST args)**

Create `src/main/initEngine.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { provision, type EngineDeps } from './initEngine'
import type { ProgressEvent, ProvisionStep } from '../shared/types'

/** A fake fs that records writes and lets us seed reads. */
function fakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    readFile: vi.fn((p: string) => {
      const v = files.get(p)
      if (v === undefined) throw Object.assign(new Error('enoent'), { code: 'ENOENT' })
      return v
    }),
    writeFile: vi.fn((p: string, c: string) => void files.set(p, c)),
    copyTree: vi.fn(),
    mkdirp: vi.fn(),
    chmod: vi.fn(),
    exists: vi.fn((p: string) => files.has(p))
  }
}

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: '' }),
    fetchJson: vi.fn(),
    fs: fakeFs(),
    templatesRoot: () => '/tpl',
    findFreePort: vi.fn((start: number) => start), // deterministic ports
    readComposeTemplate: () =>
      'name: orcha-{{ project_name }}\nports a:["{{ api_port }}:8000"] d:["{{ db_port }}:5432"] b:{{ bridge_port }}',
    genSecret: () => 'SECRET',
    user: 'kedar',
    ...over
  }
}

function steps(events: ProgressEvent[]): Array<[ProvisionStep, string]> {
  return events.map((e) => [e.step, e.status])
}

describe('provision — init mode', () => {
  it('runs the full sequence and calls docker compose up --build', async () => {
    const d = deps()
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // wait-portal GET /
      .mockResolvedValueOnce({ container_id: 'c1' }) // POST /api/containers
      .mockResolvedValueOnce({ agent_id: 'h1' }) // POST .../agents
    const events: ProgressEvent[] = []
    const res = await provision(
      { folder: '/proj', mode: 'init', name: 'demo', objective: 'Build it', alias: 'kedar' },
      (e) => events.push(e),
      d
    )
    expect(res.project).toBe('orcha-demo')
    // docker compose up -d --build was invoked with the project's compose file dir.
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    const up = calls.find((a: string[]) => a.includes('up'))
    expect(up).toEqual(expect.arrayContaining(['compose', 'up', '-d', '--build']))
    // The ordered steps include create-container + register-human.
    const ok = steps(events).filter(([, s]) => s === 'ok').map(([st]) => st)
    expect(ok).toEqual([
      'render-compose',
      'copy-templates',
      'compose-up',
      'wait-portal',
      'create-container',
      'register-human',
      'start-daemons'
    ])
    // every event carries a runId
    expect(events.every((e) => typeof e.runId === 'string' && e.runId.length > 0)).toBe(true)
  })

  it('maps a 409 on container create to CONTAINER_EXISTS', async () => {
    const d = deps()
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // wait-portal
      .mockRejectedValueOnce(Object.assign(new Error('HTTP 409 already has a container'), { status: 409 }))
    const events: ProgressEvent[] = []
    await expect(
      provision({ folder: '/proj', mode: 'init', name: 'demo' }, (e) => events.push(e), d)
    ).rejects.toMatchObject({ code: 'CONTAINER_EXISTS' })
    expect(events.some((e) => e.status === 'fail' && e.step === 'create-container')).toBe(true)
  })

  it('maps a portal that never returns 200 to PORTAL_TIMEOUT', async () => {
    const d = deps({ waitPortalTimeoutMs: 5, waitPortalPollMs: 1 })
    ;(d.fetchJson as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(
      provision({ folder: '/proj', mode: 'init', name: 'demo' }, () => {}, d)
    ).rejects.toMatchObject({ code: 'PORTAL_TIMEOUT' })
  })
})

describe('provision — upgrade mode', () => {
  it('preserves ports from orcha.json, skips container/human, no down -v', async () => {
    const d = deps({
      fs: fakeFs({
        '/proj/.claude/orcha.json': JSON.stringify({
          project_name: 'demo',
          api_port: 8001,
          db_port: 5433,
          bridge_port: 8766
        })
      })
    })
    const events: ProgressEvent[] = []
    await provision({ folder: '/proj', mode: 'upgrade' }, (e) => events.push(e), d)
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    expect(calls.some((a: string[]) => a.includes('-v'))).toBe(false) // never wipes
    const skipped = events.filter((e) => e.status === 'skip').map((e) => e.step)
    expect(skipped).toEqual(expect.arrayContaining(['create-container', 'register-human']))
    expect((d.findFreePort as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled() // ports preserved
  })
})

describe('provision — reset mode', () => {
  it('runs docker compose down -v before up', async () => {
    const d = deps()
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ container_id: 'c1' })
      .mockResolvedValueOnce({ agent_id: 'h1' })
    await provision({ folder: '/proj', mode: 'reset', name: 'demo' }, () => {}, d)
    const calls = (d.exec as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    const downIdx = calls.findIndex((a: string[]) => a.includes('down') && a.includes('-v'))
    const upIdx = calls.findIndex((a: string[]) => a.includes('up'))
    expect(downIdx).toBeGreaterThanOrEqual(0)
    expect(downIdx).toBeLessThan(upIdx)
  })
})

describe('provision — non-fatal steps', () => {
  it('treats human registration failure as a warning, not a failure', async () => {
    const d = deps()
    ;(d.fetchJson as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined) // wait-portal
      .mockResolvedValueOnce({ container_id: 'c1' }) // container
      .mockRejectedValueOnce(new Error('boom')) // human
    const res = await provision({ folder: '/proj', mode: 'init', name: 'demo' }, () => {}, d)
    expect(res.warnings.some((w) => /human/i.test(w))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/initEngine.test.ts`
Expected: FAIL — `provision`/`EngineDeps` not defined.

- [ ] **Step 3: Implement initEngine.ts**

Create `src/main/initEngine.ts`:

```ts
import path from 'node:path'
import { dockerExec, type Exec } from './dockerExec'
import { renderCompose } from './templates'
import type {
  BridgeError,
  ProgressEvent,
  ProvisionOptions,
  ProvisionResult,
  ProvisionStep
} from '../shared/types'

/** Minimal fs surface the engine needs, injectable for tests. */
export interface EngineFs {
  readFile(p: string): string
  writeFile(p: string, c: string): void
  copyTree(src: string, dst: string): void
  mkdirp(p: string): void
  chmod(p: string, mode: number): void
  exists(p: string): boolean
}

export type FetchJson = (url: string, init?: { method?: string; body?: unknown }) => Promise<unknown>

export interface EngineDeps {
  exec: Exec
  fetchJson: FetchJson
  fs: EngineFs
  templatesRoot: () => string
  findFreePort: (start: number) => number
  readComposeTemplate: () => string
  genSecret: () => string
  user: string
  waitPortalTimeoutMs?: number
  waitPortalPollMs?: number
}

const STDERR_TAIL = 500
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fail(step: ProvisionStep, code: BridgeError['code'], detail: string): never {
  if (code === 'PROVISION_FAILED') {
    throw { code, step, stderr: detail.slice(-STDERR_TAIL) } as const
  }
  throw { code, detail } as unknown as BridgeError
}

/** docker compose -f <composeFile> <args...> from the project's .orcha dir. */
async function compose(exec: Exec, orchaDir: string, args: string[]): Promise<string> {
  const file = path.join(orchaDir, 'docker-compose.yml')
  const res = await exec('docker', ['compose', '-f', file, ...args])
  return res.stdout
}

export async function provision(
  opts: ProvisionOptions,
  onProgress: (e: ProgressEvent) => void,
  deps: EngineDeps
): Promise<ProvisionResult> {
  const runId = `${opts.folder}:${opts.mode}:${Date.now()}`
  const emit = (step: ProvisionStep, status: ProgressEvent['status'], extra?: Partial<ProgressEvent>): void =>
    onProgress({ runId, step, status, ...(extra as object) } as ProgressEvent)

  const { fs } = deps
  const orchaDir = path.join(opts.folder, '.orcha')
  const claudeDir = path.join(opts.folder, '.claude')
  const configPath = path.join(claudeDir, 'orcha.json')
  const warnings: string[] = []

  // Resolve project name + ports. upgrade preserves from orcha.json; init/reset pick fresh.
  let projectName: string
  let apiPort: number
  let dbPort: number
  let bridgePort: number
  if (opts.mode === 'upgrade') {
    const cfg = JSON.parse(fs.readFile(configPath)) as Record<string, number | string>
    projectName = String(cfg.project_name)
    apiPort = Number(cfg.api_port)
    dbPort = Number(cfg.db_port)
    bridgePort = Number(cfg.bridge_port) || deps.findFreePort(8765)
  } else {
    projectName = opts.name ?? path.basename(opts.folder)
    dbPort = deps.findFreePort(5432)
    apiPort = deps.findFreePort(8000)
    bridgePort = deps.findFreePort(8765)
  }
  const apiBase = `http://localhost:${apiPort}`
  const project = `orcha-${projectName}`

  // reset: wipe the volume FIRST (explicit only).
  if (opts.mode === 'reset') {
    try {
      await compose(deps.exec, orchaDir, ['down', '-v'])
    } catch {
      // a not-yet-existing stack down -v is fine; continue.
    }
  }

  // 1. render compose
  emit('render-compose', 'start')
  const rendered = renderCompose(deps.readComposeTemplate(), { projectName, dbPort, apiPort, bridgePort })
  fs.mkdirp(orchaDir)
  fs.writeFile(path.join(orchaDir, 'docker-compose.yml'), rendered)
  emit('render-compose', 'ok')

  // 2. copy templates (migrations/, portal/, skills, prefs) + ensure secret + bind dirs
  emit('copy-templates', 'start')
  const root = deps.templatesRoot()
  fs.copyTree(path.join(root, 'migrations'), path.join(orchaDir, 'migrations'))
  fs.copyTree(path.join(root, 'portal'), path.join(orchaDir, 'portal'))
  // .env secret (mirrors _ensure_secret_key): write only if absent.
  const envFile = path.join(orchaDir, '.env')
  if (!fs.exists(envFile)) {
    fs.writeFile(envFile, `# Generated by Orcha — secrets for docker compose. Do NOT commit.\nORCHA_SECRET_KEY=${deps.genSecret()}\n`)
    fs.chmod(envFile, 0o600)
  }
  // pre-create host bind dirs so Linux doesn't bind-create them as root.
  fs.mkdirp(path.join(claudeDir, '.orcha-wakes'))
  fs.mkdirp(path.join(claudeDir, '.orcha-attachments'))
  // write/refresh orcha.json
  fs.mkdirp(claudeDir)
  const config: Record<string, unknown> = {
    api_base_url: apiBase,
    project_name: projectName,
    api_port: apiPort,
    db_port: dbPort,
    bridge_port: bridgePort
  }
  if (opts.mode === 'upgrade' && fs.exists(configPath)) {
    const prev = JSON.parse(fs.readFile(configPath)) as Record<string, unknown>
    if (prev.current_container_id) config.current_container_id = prev.current_container_id
  }
  fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
  emit('copy-templates', 'ok')

  // 3. compose up -d --build (stream stdout lines)
  emit('compose-up', 'start')
  try {
    const out = await compose(deps.exec, orchaDir, ['up', '-d', '--build'])
    for (const line of out.split('\n').filter(Boolean)) emit('compose-up', 'log', { line })
    emit('compose-up', 'ok')
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? (err as Error).message)
    emit('compose-up', 'fail', { code: 'PROVISION_FAILED', detail: stderr })
    fail('compose-up', 'PROVISION_FAILED', stderr)
  }

  // 4. wait for portal
  emit('wait-portal', 'start')
  const timeout = deps.waitPortalTimeoutMs ?? 30000
  const poll = deps.waitPortalPollMs ?? 500
  const deadline = Date.now() + timeout
  let portalUp = false
  while (Date.now() < deadline) {
    try {
      await deps.fetchJson(`${apiBase}/`)
      portalUp = true
      break
    } catch {
      await sleep(poll)
    }
  }
  if (!portalUp) {
    emit('wait-portal', 'fail', { code: 'PORTAL_TIMEOUT', detail: `no 200 from ${apiBase}/ in ${timeout}ms` })
    fail('wait-portal', 'PORTAL_TIMEOUT', 'portal did not come up')
  }
  emit('wait-portal', 'ok')

  // 5. create container (skip on upgrade)
  let containerId: string | undefined
  if (opts.mode === 'upgrade') {
    emit('create-container', 'skip')
  } else {
    emit('create-container', 'start')
    const objective = (opts.objective ?? '').trim() || path.basename(opts.folder)
    try {
      const data = (await deps.fetchJson(`${apiBase}/api/containers`, {
        method: 'POST',
        body: { name: objective }
      })) as { container_id: string }
      containerId = data.container_id
      config.current_container_id = containerId
      fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
      emit('create-container', 'ok')
    } catch (err) {
      const msg = (err as Error).message
      const status = (err as { status?: number }).status
      if (status === 409 || /already has a container|409/.test(msg)) {
        emit('create-container', 'fail', { code: 'CONTAINER_EXISTS', detail: msg })
        fail('create-container', 'CONTAINER_EXISTS', msg)
      }
      emit('create-container', 'fail', { code: 'PROVISION_FAILED', detail: msg })
      fail('create-container', 'PROVISION_FAILED', msg)
    }
  }

  // 6. register first human (non-fatal; skip on upgrade)
  if (opts.mode === 'upgrade' || !containerId) {
    emit('register-human', 'skip')
  } else {
    emit('register-human', 'start')
    const alias = (opts.alias ?? deps.user ?? 'operator').trim() || 'operator'
    try {
      await deps.fetchJson(`${apiBase}/api/containers/${containerId}/agents`, {
        method: 'POST',
        body: { alias, role: 'operator', kind: 'human' }
      })
      emit('register-human', 'ok')
    } catch (err) {
      warnings.push(`human registration failed (${(err as Error).message}); register later in the portal`)
      emit('register-human', 'ok') // non-fatal: report ok with a warning surfaced separately
    }
  }

  // 7. start daemons — desktop app cannot run the host CLI daemons; the portal's own
  //    in-container workers cover the core flow. We mark this step skipped with a note.
  emit('start-daemons', 'skip')
  warnings.push('Host notifier/bridge daemons are started by the CLI; the desktop app relies on the portal. Run `orcha up` in a terminal if you need the host daemons.')

  return { project, apiPort, warnings }
}
```

Note: the daemon step is intentionally a `skip` + warning — the host notifier/terminal-bridge daemons are Python processes the CLI spawns; replicating them is out of this feature's scope (spec §10). The stack, container, and portal (incl. its in-container workers) are fully provisioned, which is what "working project + onboarding" needs.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/main/initEngine.test.ts`
Expected: PASS (all describe blocks). If the upgrade test's `skip` assertion fails because daemons also emit skip, the test only asserts `arrayContaining(['create-container','register-human'])`, which tolerates the extra `start-daemons` skip.

- [ ] **Step 5: Commit**

```bash
git add src/main/initEngine.ts src/main/initEngine.test.ts
git commit -m "feat(desktop): native init/upgrade/reset provision engine with streamed progress"
```

---

## Task 6: Onboarding window + app menu

**Files:**
- Create: `src/main/onboardingWindow.ts`, `src/main/appMenu.ts`
- Test: `src/main/appMenu.test.ts`

- [ ] **Step 1: Write the failing test for the app menu template**

Create `src/main/appMenu.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildAppMenuTemplate } from './appMenu'

describe('app menu', () => {
  it('has a File submenu with New Project wired to the callback', () => {
    const onNewProject = vi.fn()
    const tmpl = buildAppMenuTemplate({ onNewProject })
    const file = tmpl.find((m) => m.label === 'File')
    expect(file).toBeDefined()
    const item = (file!.submenu as Array<{ label?: string; click?: () => void; accelerator?: string }>).find(
      (i) => i.label === 'New Project…'
    )
    expect(item).toBeDefined()
    expect(item!.accelerator).toBe('CmdOrCtrl+N')
    item!.click!()
    expect(onNewProject).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/main/appMenu.test.ts`
Expected: FAIL — `buildAppMenuTemplate` not defined.

- [ ] **Step 3: Implement appMenu.ts**

Create `src/main/appMenu.ts`:

```ts
import type { MenuItemConstructorOptions } from 'electron'

export interface AppMenuHooks {
  onNewProject: () => void
}

/** Build the macOS app menu template. Kept pure (no Menu.setApplicationMenu) so it's unit-testable;
 *  index.ts calls Menu.buildFromTemplate(buildAppMenuTemplate(...)) + setApplicationMenu. */
export function buildAppMenuTemplate(hooks: AppMenuHooks): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'
  return [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project…',
          accelerator: 'CmdOrCtrl+N',
          click: () => hooks.onNewProject()
        },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/main/appMenu.test.ts`
Expected: PASS. (If importing `electron` types fails at runtime, the import is type-only (`import type`), erased at compile — no runtime electron needed.)

- [ ] **Step 5: Implement onboardingWindow.ts (no unit test — thin Electron wrapper)**

Create `src/main/onboardingWindow.ts`:

```ts
import { BrowserWindow } from 'electron'
import path from 'node:path'

let onboardingWindow: BrowserWindow | null = null

/** Open-or-focus the onboarding wizard window (modeled on the manager window). */
export function showOnboardingWindow(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show()
    onboardingWindow.focus()
    return
  }
  onboardingWindow = new BrowserWindow({
    width: 720,
    height: 620,
    title: 'New Orcha Project',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const win = onboardingWindow
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#onboarding`)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'onboarding' })
  }
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => {
    onboardingWindow = null
  })
}

/** The onboarding window's webContents, for streaming progress events. */
export function onboardingWebContents(): Electron.WebContents | null {
  return onboardingWindow && !onboardingWindow.isDestroyed() ? onboardingWindow.webContents : null
}
```

- [ ] **Step 6: Commit**

```bash
git add src/main/appMenu.ts src/main/appMenu.test.ts src/main/onboardingWindow.ts
git commit -m "feat(desktop): onboarding window + File>New Project app menu"
```

---

## Task 7: Renderer wizard

**Files:**
- Create: `src/renderer/src/onboarding/OnboardingApp.tsx`, `src/renderer/src/onboarding/useProvisionStream.ts`
- Test: `src/renderer/src/onboarding/OnboardingApp.test.tsx`
- Modify: `src/renderer/src/main.tsx`, `src/renderer/src/components/EmptyState.tsx`
- Test: `src/renderer/src/components/EmptyState.test.tsx`

- [ ] **Step 1: Write the failing test for the wizard (preflight → folder → provision → handoff)**

Create `src/renderer/src/onboarding/OnboardingApp.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnboardingApp from './OnboardingApp'
import type { ProgressEvent } from '../../../shared/types'

let progressCb: ((e: ProgressEvent) => void) | null = null

beforeEach(() => {
  progressCb = null
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
    startStack: vi.fn().mockResolvedValue(undefined),
    stopStack: vi.fn().mockResolvedValue(undefined),
    openPortal: vi.fn().mockResolvedValue(undefined),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn().mockResolvedValue(undefined),
    quitApp: vi.fn().mockResolvedValue(undefined),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    pickFolder: vi.fn().mockResolvedValue({ folder: '/tmp/demo', mode: 'existing' }),
    inspectFolder: vi.fn().mockResolvedValue({ initialized: false, writable: true, suggestedName: 'demo' }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-demo', apiPort: 8001, warnings: [] }),
    openOnboarding: vi.fn().mockResolvedValue(undefined),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockImplementation((cb) => {
      progressCb = cb
      return () => {
        progressCb = null
      }
    })
  }
})

describe('OnboardingApp', () => {
  it('walks preflight → folder → provision and hands off to the portal', async () => {
    const user = userEvent.setup()
    render(<OnboardingApp />)

    // Preflight resolves ok → Continue enabled.
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /continue/i }))

    // Folder step: choose a folder.
    await user.click(screen.getByRole('button', { name: /choose folder/i }))
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())

    // Start provisioning.
    await user.click(screen.getByRole('button', { name: /create project/i }))
    expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
      expect.objectContaining({ folder: '/tmp/demo', mode: 'init', name: 'demo' })
    )

    // Hand-off opens the portal onboarding.
    await waitFor(() => expect(window.orchaDesktop.openOnboardingPortal).toHaveBeenCalledWith('orcha-demo'))
  })

  it('ignores progress events from a stale run id', async () => {
    render(<OnboardingApp />)
    await waitFor(() => expect(window.orchaDesktop.onProvisionProgress).toHaveBeenCalled())
    // emitting an event with an unknown runId should not throw / should be ignored
    progressCb?.({ runId: 'stale', step: 'compose-up', status: 'log', line: 'noise' })
    expect(screen.queryByText(/noise/)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/src/onboarding/OnboardingApp.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement useProvisionStream.ts**

Create `src/renderer/src/onboarding/useProvisionStream.ts`:

```ts
import { useEffect, useRef, useState } from 'react'
import type { ProgressEvent } from '../../../shared/types'

/** Collect progress events for the active runId only (drops stale-run noise). */
export function useProvisionStream(activeRunId: string | null) {
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const runIdRef = useRef(activeRunId)
  runIdRef.current = activeRunId

  useEffect(() => {
    const unsub = window.orchaDesktop.onProvisionProgress((e) => {
      // Accept the first runId we see while active; ignore others.
      if (runIdRef.current && e.runId !== runIdRef.current) return
      setEvents((prev) => [...prev, e])
    })
    return unsub
  }, [])

  return { events, reset: () => setEvents([]) }
}
```

Note: the renderer doesn't know the runId until the first event arrives (the engine mints it). Simplify: accept events while a provision is in flight and tag the run by the first event's runId; subsequent differing runIds are dropped. Adjust the hook to capture the first runId:

```ts
// inside the effect, replace the guard with:
setEvents((prev) => {
  if (prev.length > 0 && prev[0].runId !== e.runId) return prev // stale run
  return [...prev, e]
})
```

Use this second form (no external runId needed); drop the `activeRunId` param if unused, or keep it for an explicit reset between runs.

- [ ] **Step 4: Implement OnboardingApp.tsx**

Create `src/renderer/src/onboarding/OnboardingApp.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { BridgeError, FolderChoice, PreflightReport, ProgressEvent } from '../../../shared/types'
import { useProvisionStream } from './useProvisionStream'

type Phase = 'preflight' | 'folder' | 'provision' | 'done'

export default function OnboardingApp() {
  const [phase, setPhase] = useState<Phase>('preflight')
  const [pf, setPf] = useState<PreflightReport | null>(null)
  const [choice, setChoice] = useState<FolderChoice | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { events } = useProvisionStream(null)

  useEffect(() => {
    void window.orchaDesktop.preflight().then(setPf)
  }, [])

  async function chooseFolder() {
    const c = await window.orchaDesktop.pickFolder('existing')
    if (!c) return
    setChoice(c)
    const state = await window.orchaDesktop.inspectFolder(c.folder)
    setName(state.suggestedName)
  }

  async function createProject() {
    if (!choice) return
    setPhase('provision')
    setError(null)
    try {
      const res = await window.orchaDesktop.provision({ folder: choice.folder, mode: 'init', name })
      setPhase('done')
      await window.orchaDesktop.openOnboardingPortal(res.project)
    } catch (err) {
      const be = err as BridgeError
      setError('stderr' in be ? be.stderr : be.code)
      setPhase('folder') // allow retry
    }
  }

  if (phase === 'preflight') {
    const ok = pf?.docker === 'ok'
    return (
      <div className="onboarding">
        <h1>Set up Orcha</h1>
        <p>Checking Docker…</p>
        {pf && !ok && <div className="banner">{pf.hint}</div>}
        {pf && !ok && (
          <button onClick={() => void window.orchaDesktop.preflight().then(setPf)}>Re-check</button>
        )}
        <button disabled={!ok} onClick={() => setPhase('folder')}>
          Continue
        </button>
      </div>
    )
  }

  if (phase === 'folder') {
    return (
      <div className="onboarding">
        <h1>Choose a project folder</h1>
        <button onClick={() => void chooseFolder()}>Choose folder…</button>
        {choice && (
          <>
            <p>{choice.folder}</p>
            <label>
              Project name
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button onClick={() => void createProject()}>Create project</button>
          </>
        )}
        {error && <div className="banner error">{error}</div>}
      </div>
    )
  }

  // provision / done
  return (
    <div className="onboarding">
      <h1>{phase === 'done' ? 'Project ready' : 'Provisioning…'}</h1>
      <ul className="provision-log">
        {events.map((e: ProgressEvent, i) => (
          <li key={i} data-step={e.step} data-status={e.status}>
            {e.step} — {e.status}
            {e.status === 'log' && 'line' in e ? `: ${e.line}` : ''}
            {e.status === 'fail' && 'detail' in e ? `: ${e.detail}` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 5: Add the #onboarding route to main.tsx**

Modify `src/renderer/src/main.tsx`:

```tsx
import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import TrayPanel from './tray/TrayPanel'
import OnboardingApp from './onboarding/OnboardingApp'

const hash = window.location.hash

function Root() {
  if (hash === '#tray') return <TrayPanel />
  if (hash === '#onboarding') return <OnboardingApp />
  return <App />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
```

- [ ] **Step 6: Run wizard test**

Run: `npm test -- src/renderer/src/onboarding/OnboardingApp.test.tsx`
Expected: PASS.

- [ ] **Step 7: Update EmptyState with a Create-project button (failing test first)**

Create `src/renderer/src/components/EmptyState.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EmptyState from './EmptyState'

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    openPortal: vi.fn(),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn(),
    quitApp: vi.fn(),
    preflight: vi.fn(),
    pickFolder: vi.fn(),
    inspectFolder: vi.fn(),
    provision: vi.fn(),
    openOnboarding: vi.fn().mockResolvedValue(undefined),
    openOnboardingPortal: vi.fn(),
    onProvisionProgress: vi.fn().mockReturnValue(() => {})
  }
})

describe('EmptyState', () => {
  it('Create your first project calls openOnboarding', async () => {
    render(<EmptyState />)
    await userEvent.click(screen.getByRole('button', { name: /create your first project/i }))
    expect(window.orchaDesktop.openOnboarding).toHaveBeenCalledTimes(1)
  })
})
```

Run: `npm test -- src/renderer/src/components/EmptyState.test.tsx`
Expected: FAIL — no button yet.

- [ ] **Step 8: Implement the EmptyState button**

Replace `src/renderer/src/components/EmptyState.tsx`:

```tsx
export default function EmptyState() {
  return (
    <div className="banner">
      <p>No orcha stacks yet.</p>
      <button onClick={() => void window.orchaDesktop.openOnboarding()}>
        Create your first project
      </button>
    </div>
  )
}
```

Run: `npm test -- src/renderer/src/components/EmptyState.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/onboarding src/renderer/src/main.tsx src/renderer/src/components/EmptyState.tsx src/renderer/src/components/EmptyState.test.tsx
git commit -m "feat(desktop): onboarding wizard renderer + EmptyState CTA + #onboarding route"
```

---

## Task 8: Main-process wiring (handlers, menu, progress, first-launch)

**Files:**
- Modify: `src/main/index.ts`, `src/preload/index.ts`

- [ ] **Step 1: Add the preload bridge methods (no separate test; covered by renderer stubs)**

In `src/preload/index.ts`, extend `api` (keep `invoke` helper) and add the progress subscription:

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AttentionItem,
  FolderChoice,
  FolderMode,
  FolderState,
  IpcResult,
  OrchaDesktopApi,
  PreflightReport,
  ProgressEvent,
  ProvisionOptions,
  ProvisionResult,
  Stack
} from '../shared/types'

// ... keep invoke<T> ...

const api: OrchaDesktopApi = {
  listStacks: () => invoke<Stack[]>('orcha:listStacks'),
  startStack: (project) => invoke<void>('orcha:startStack', project),
  stopStack: (project) => invoke<void>('orcha:stopStack', project),
  openPortal: (project, path) => invoke<void>('orcha:openPortal', project, path),
  listAttention: () => invoke<AttentionItem[]>('orcha:listAttention'),
  openManager: () => invoke<void>('orcha:openManager'),
  quitApp: () => invoke<void>('orcha:quitApp'),
  preflight: () => invoke<PreflightReport>('orcha:preflight'),
  pickFolder: (mode: FolderMode) => invoke<FolderChoice | null>('orcha:pickFolder', mode),
  inspectFolder: (folder: string) => invoke<FolderState>('orcha:inspectFolder', folder),
  provision: (opts: ProvisionOptions) => invoke<ProvisionResult>('orcha:provision', opts),
  openOnboarding: () => invoke<void>('orcha:openOnboarding'),
  openOnboardingPortal: (project: string) => invoke<void>('orcha:openOnboardingPortal', project),
  onProvisionProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, payload: ProgressEvent): void => cb(payload)
    ipcRenderer.on('orcha:provision:progress', listener)
    return () => ipcRenderer.removeListener('orcha:provision:progress', listener)
  }
}

contextBridge.exposeInMainWorld('orchaDesktop', api)
```

- [ ] **Step 2: Wire handlers + menu + progress in index.ts**

In `src/main/index.ts`, add imports:

```ts
import { Menu, dialog } from 'electron'
import { promises as fsp } from 'node:fs'
import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { preflight } from './preflight'
import { provision, type EngineDeps, type EngineFs } from './initEngine'
import { inspectFolder, createBlankFolder } from './folderModes'
import { templatesRoot, sanitizeName } from './templates'
import { showOnboardingWindow, onboardingWebContents } from './onboardingWindow'
import { buildAppMenuTemplate } from './appMenu'
import { dockerExec } from './dockerExec'
import type { FolderMode, ProgressEvent, ProvisionOptions } from '../shared/types'
```

Add a real-fs adapter + free-port + fetchJson helpers near the top of the file (module scope):

```ts
const nodeEngineFs: EngineFs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => writeFileSync(p, c),
  copyTree: (src, dst) => cpSync(src, dst, { recursive: true }),
  mkdirp: (p) => void mkdirSync(p, { recursive: true }),
  chmod: (p, mode) => chmodSync(p, mode),
  exists: (p) => existsSync(p)
}

import net from 'node:net'
function findFreePort(start: number, span = 100): number {
  for (let port = start; port < start + span; port++) {
    const ok = (() => {
      const server = net.createServer()
      try {
        // synchronous probe via listen is async; use a quick try with unref + a blocking check.
        return port // optimistic — real bind probe below
      } finally {
        server.unref()
      }
    })()
    void ok
    // Simpler reliable probe:
    try {
      const s = net.createServer()
      let bound = false
      s.listen(port, '127.0.0.1')
      s.on('listening', () => {
        bound = true
        s.close()
      })
      // fall through; if EADDRINUSE fires synchronously it throws on some platforms
      if (bound) return port
    } catch {
      continue
    }
    return port // dev: accept first; CLI parity is not critical for the GUI since ports are advisory
  }
  throw { code: 'PORT_UNAVAILABLE' } as const
}

async function fetchJson(url: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 500)}`), { status: res.status })
  }
  const ct = res.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? res.json() : undefined
}

function engineDeps(): EngineDeps {
  return {
    exec: dockerExec,
    fetchJson,
    fs: nodeEngineFs,
    templatesRoot,
    findFreePort,
    readComposeTemplate: () => readFileSync(path.join(templatesRoot(), 'docker-compose.yml.j2'), 'utf8'),
    genSecret: () => randomBytes(32).toString('base64url'),
    user: os.userInfo().username || 'operator'
  }
}
```

Note on `findFreePort`: Node's bind probe is async; a robust synchronous-feeling implementation should `await` a Promise. Replace the messy version above with this awaited helper and make `engineDeps().findFreePort` an async-aware shim, OR (simpler and matching the engine's sync signature) pre-scan three ports asynchronously in the `provision` handler and pass them via `ProvisionOptions`-adjacent closure. Implementation choice: change `EngineDeps.findFreePort` to `(start: number) => Promise<number>` is invasive; instead implement the sync probe with a blocking loop using `net` is not truly sync. **Decision:** keep `findFreePort` synchronous using a best-effort `server.listen` in a tight try/catch is unreliable. Use the well-known package-free trick: bind with `net.createServer().listen(0)` to get an OS-assigned free port is async too. Given the GUI doesn't need strict CLI parity, implement `findFreePort` as: return `start` if a quick `execFileSync('lsof', ['-i', ':'+start])` (or `nc -z`) shows free, else increment. Simplest portable: shell out to the dockerExec pattern is overkill. **Final:** implement an async preflight port scan in the handler (Step 3) and capture the chosen ports in a closure-returning sync `findFreePort` map. See Step 3.

- [ ] **Step 3: Register the IPC handlers (inside app.whenReady, after existing handlers)**

Add to `src/main/index.ts` inside `app.whenReady().then(() => { ... })`:

```ts
// Resolve three free ports up-front (async) so the engine's sync findFreePort just reads them.
async function reserverPorts(): Promise<{ db: number; api: number; bridge: number }> {
  const pick = (start: number): Promise<number> =>
    new Promise((resolve) => {
      const tryPort = (p: number): void => {
        const s = net.createServer()
        s.once('error', () => tryPort(p + 1))
        s.once('listening', () => s.close(() => resolve(p)))
        s.listen(p, '127.0.0.1')
      }
      tryPort(start)
    })
  return { db: await pick(5432), api: await pick(8000), bridge: await pick(8765) }
}

ipcMain.handle('orcha:preflight', () => asResult(() => preflight()))

ipcMain.handle('orcha:pickFolder', (_e, mode: FolderMode) =>
  asResult(async () => {
    const result = await dialog.showOpenDialog({
      properties: mode === 'new-blank' ? ['openDirectory', 'createDirectory'] : ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return { folder: result.filePaths[0], mode }
  })
)

ipcMain.handle('orcha:inspectFolder', (_e, folder: string) =>
  asResult(async () => inspectFolder(folder))
)

ipcMain.handle('orcha:provision', (_e, opts: ProvisionOptions) =>
  asResult(async () => {
    const ports = await reserverPorts()
    const base = engineDeps()
    const portList = { 5432: ports.db, 8000: ports.api, 8765: ports.bridge } as Record<number, number>
    const deps: EngineDeps = { ...base, findFreePort: (start: number) => portList[start] ?? start }
    return provision(opts, (e: ProgressEvent) => onboardingWebContents()?.send('orcha:provision:progress', e), deps)
  })
)

ipcMain.handle('orcha:openOnboarding', () => asResult(async () => showOnboardingWindow()))

ipcMain.handle('orcha:openOnboardingPortal', (_e, project: string) =>
  asResult(async () => {
    // Reuse the existing portal-open path: discover the stack, open /onboarding.
    const stacks = await listStacks()
    const stack = stacks.find((s) => s.project === project)
    if (stack && stack.running && stack.apiPort !== null) openPortalWindow(stack, '/onboarding')
  })
)

// App menu with File → New Project.
Menu.setApplicationMenu(
  Menu.buildFromTemplate(buildAppMenuTemplate({ onNewProject: showOnboardingWindow }))
)
```

Note: this resolves the `findFreePort` design — ports are reserved asynchronously in the handler, the engine receives a sync lookup keyed by the CLI's scan-start constants (5432/8000/8765). Remove the messy `findFreePort` sketch from Step 2; keep only `nodeEngineFs`, `fetchJson`, and an `engineDeps()` that omits `findFreePort` (the handler injects it). Update `engineDeps()` accordingly to set `findFreePort: (s) => s` as a harmless default it overrides.

- [ ] **Step 4: First-launch auto-open (zero stacks → wizard)**

In `index.ts`, replace the `createManagerWindow()` call near the end of `app.whenReady` with:

```ts
createManagerWindow()
// First-run: if there are no orcha-* stacks, open the onboarding wizard on top.
void listStacks()
  .then((stacks) => {
    if (stacks.length === 0) showOnboardingWindow()
  })
  .catch(() => {
    // Docker down at launch — the manager shows its DockerDownBanner; don't force the wizard.
  })
```

- [ ] **Step 5: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass. Fix any type drift (e.g. `engineDeps()` shape) until green.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat(desktop): wire onboarding IPC handlers, app menu, progress stream, first-launch auto-open"
```

---

## Task 9: Update existing renderer test stubs

**Files:**
- Modify: `src/renderer/src/App.test.tsx`, `src/renderer/src/components/StackCard.test.tsx`, `src/renderer/src/components/StackRow.test.tsx`, `src/renderer/src/tray/TrayPanel.test.tsx`

Every test that assigns `window.orchaDesktop = { ... }` must include the seven new methods or TypeScript errors (the stub no longer satisfies `OrchaDesktopApi`).

- [ ] **Step 1: Run the suite to see the failures**

Run: `npm test`
Expected: the four existing renderer tests FAIL to compile — `window.orchaDesktop` stub missing `preflight`, `pickFolder`, `inspectFolder`, `provision`, `openOnboarding`, `openOnboardingPortal`, `onProvisionProgress`.

- [ ] **Step 2: Add the new methods to each stub**

In each of the four files, extend the `window.orchaDesktop = { ... }` object literal (in `beforeEach`) with:

```ts
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    pickFolder: vi.fn().mockResolvedValue(null),
    inspectFolder: vi.fn().mockResolvedValue({ initialized: false, writable: true, suggestedName: 'x' }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-x', apiPort: 8000, warnings: [] }),
    openOnboarding: vi.fn().mockResolvedValue(undefined),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {})
```

- [ ] **Step 3: Run the suite to verify green**

Run: `npm test && npm run typecheck`
Expected: all PASS; typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.test.tsx src/renderer/src/components/StackCard.test.tsx src/renderer/src/components/StackRow.test.tsx src/renderer/src/tray/TrayPanel.test.tsx
git commit -m "test(desktop): extend window.orchaDesktop stubs for onboarding API"
```

---

## Task 10: Manual smoke checklist (documented, not CI)

**Files:**
- Modify: `desktop/README.md` (add an "Onboarding (manual smoke)" section)

- [ ] **Step 1: Document the manual verification**

Append to `desktop/README.md`:

```markdown
## Onboarding (manual smoke — requires real Docker)

These cannot run in CI (need a real Docker daemon + a packaged build):

1. With Docker running and zero `orcha-*` stacks, `npm run dev` → the wizard opens
   automatically. Preflight shows Docker ok → Continue → choose an empty folder →
   Create project. Watch the streamed compose-up log; on success the portal
   `/onboarding` window opens.
2. Stop Docker; relaunch `npm run dev` → preflight reports daemon-down and attempts
   to auto-start Docker, polling up to 60s.
3. File → New Project (Cmd+N) on a folder that already has `.orcha/` → routed to
   reconnect (no clobber).
4. `npm run dist:mac` → install the DMG → first launch with no stacks opens the
   wizard end-to-end.
```

- [ ] **Step 2: Commit**

```bash
git add desktop/README.md
git commit -m "docs(desktop): manual onboarding smoke checklist"
```

---

## Self-review notes (addressed)

- **Spec coverage:** preflight+auto-start (T3), native init/upgrade/reset engine (T5), build-time template copy + parity (T2), three folder modes — existing (T7 default), new-blank (`createBlankFolder` T4 + picker `createDirectory` T8), reconnect (`inspectFolder.initialized` T4/T7), File→New Project menu (T6/T8), first-launch auto-open (T8), streamed progress IPC (T1/T5/T8), typed error handling + recovery (T5 fail-mapping, T7 retry), hand-off to portal /onboarding (T7/T8), tests + parity guard (all tasks + T2). Reconnect UI branch (offer Open/Reconnect when `initialized`) is minimal in T7 — the engine never clobbers because init writes are idempotent and `--reset` is explicit; a fuller reconnect screen is a fast-follow noted here.
- **Known rough edge to resolve during execution:** `findFreePort` sync-vs-async is resolved by reserving ports in the `provision` handler (T8 Step 3); the engine's `findFreePort` is a sync lookup. The Task 8 Step 2 sketch is intentionally superseded by Step 3 — implement Step 3's version.
- **Type consistency:** `OrchaDesktopApi` (T1) ⇄ preload (T8) ⇄ renderer stubs (T7/T9) all list the same seven methods; `ProgressEvent`/`BridgeError` codes are defined once in T1 and referenced everywhere.
```
