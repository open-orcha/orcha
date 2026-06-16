# Orcha Desktop v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron + React + TypeScript window app in `desktop/` that lists every `orcha-*` Docker stack (running or stopped), starts/stops them, and opens each stack's existing web portal in an app window — per `docs/superpowers/specs/2026-06-11-desktop-app-design.md`.

**Architecture:** electron-vite project. Main process owns all child-process work (`docker ps -a` discovery, `docker compose -p <project> start|stop`) behind four IPC channels that return discriminated `{ok}` results; a sandboxed preload bridge converts `{ok:false}` into typed promise rejections; the React renderer polls and renders stack cards. Portal windows are plain `BrowserWindow`s pointed at `http://localhost:<apiPort>/`.

**Tech Stack:** Electron, electron-vite, React 18+, TypeScript, Vitest (+ jsdom + @testing-library/react). Node 22 / npm 10 verified on the dev machine.

---

**Conventions (this repo):**
- Branch `feat/desktop-app` (verify `git branch --show-current` before every commit; never switch).
- Everything in this plan lives under `desktop/` except a root `.gitignore` addition. NO HTTP routes or DB shapes change ⇒ `docs/orcha.postman_collection.json` must NOT be touched.
- Commit messages: conventional prefix, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- All npm commands run from `/Users/husseinmohamed/Desktop/quantal-projects/Orcha/desktop` unless stated otherwise.
- A REAL stack exists on this machine for fixtures/manual tests: compose project `orcha-quantal-ehr`, containers `orcha-quantal-ehr-portal-1` (8001→8000) and `orcha-quantal-ehr-db-1` (5435→5432).

---

### Task 1: Scaffold the electron-vite project

**Files:**
- Create: `desktop/package.json` (via npm + edits), `desktop/electron.vite.config.ts`, `desktop/tsconfig.json`, `desktop/tsconfig.node.json`, `desktop/tsconfig.web.json`, `desktop/vitest.config.ts`, `desktop/.gitignore`
- Create (minimal entries so the build passes): `desktop/src/main/index.ts`, `desktop/src/preload/index.ts`, `desktop/src/renderer/index.html`, `desktop/src/renderer/src/main.tsx`, `desktop/src/renderer/src/App.tsx`, `desktop/src/renderer/src/env.d.ts`, `desktop/src/renderer/test-setup.ts`
- Modify: `/Users/husseinmohamed/Desktop/quantal-projects/Orcha/.gitignore` (root)

- [ ] **Step 1: Create the directory and install dependencies** (resolves current versions at install time — do not hand-pin):

```bash
mkdir -p desktop && cd desktop
npm init -y
npm install react react-dom
npm install -D electron electron-vite vite typescript @types/react @types/react-dom @types/node @vitejs/plugin-react vitest jsdom @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 2: Edit `desktop/package.json`** — set these fields (keep the generated dependency blocks):

```json
{
  "name": "orcha-desktop",
  "version": "0.1.0",
  "description": "Orcha Desktop — stack manager for orcha-* Docker stacks (Orcha#237)",
  "main": "./out/main/index.js",
  "private": true,
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "start": "electron-vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"
  }
}
```

- [ ] **Step 3: Create `desktop/electron.vite.config.ts`:**

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
})
```

- [ ] **Step 4: Create the three tsconfigs.**

`desktop/tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

`desktop/tsconfig.node.json` (main + preload + shared):

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": false,
    "emitDeclarationOnly": true,
    "outDir": "out/types-node",
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src/main/**/*.ts", "src/preload/**/*.ts", "src/shared/**/*.ts", "electron.vite.config.ts", "vitest.config.ts"]
}
```

`desktop/tsconfig.web.json` (renderer + shared):

```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": false,
    "emitDeclarationOnly": true,
    "outDir": "out/types-web",
    "types": ["vite/client"],
    "skipLibCheck": true
  },
  "include": ["src/renderer/src/**/*.ts", "src/renderer/src/**/*.tsx", "src/shared/**/*.ts", "src/renderer/test-setup.ts"]
}
```

- [ ] **Step 5: Create `desktop/vitest.config.ts`** (node env by default; component tests opt into jsdom with a pragma):

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['./src/renderer/test-setup.ts']
  }
})
```

`desktop/src/renderer/test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 6: Create the minimal entry points.**

`desktop/src/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

let managerWindow: BrowserWindow | null = null

function createManagerWindow(): void {
  managerWindow = new BrowserWindow({
    width: 760,
    height: 560,
    title: 'Orcha',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // electron-vite dev server URL in dev; built file in prod.
  if (process.env['ELECTRON_RENDERER_URL']) {
    managerWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    managerWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  managerWindow.on('closed', () => {
    managerWindow = null
  })
}

app.whenReady().then(() => {
  createManagerWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createManagerWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
```

`desktop/src/preload/index.ts` (placeholder until Task 5):

```ts
// Bridge lands in Task 5; preload must exist for electron-vite to build.
export {}
```

`desktop/src/renderer/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Orcha</title>
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`desktop/src/renderer/src/main.tsx`:

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

`desktop/src/renderer/src/App.tsx` (placeholder until Task 6):

```tsx
export default function App() {
  return <h1>Orcha Desktop</h1>
}
```

`desktop/src/renderer/src/env.d.ts` (typed bridge global; the type arrives in Task 2 — write this file in Task 2 instead if you prefer, but it must exist before `App.tsx` uses the bridge):

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 7: Create `desktop/.gitignore`** and add the root entry.

`desktop/.gitignore`:

```
node_modules/
out/
dist/
```

Append to the ROOT `/Users/husseinmohamed/Desktop/quantal-projects/Orcha/.gitignore` (read it first; add only if absent):

```
desktop/node_modules/
desktop/out/
desktop/dist/
```

- [ ] **Step 8: Verify the scaffold builds and typechecks**

```bash
cd desktop && npm run build && npm run typecheck
```

Expected: electron-vite builds main/preload/renderer into `out/` with no errors; tsc passes. (Do not run `npm run dev` here — GUI run is Task 7.)

- [ ] **Step 9: Commit** (from repo root; verify `git status` shows no `node_modules`/`out`):

```bash
git add desktop .gitignore
git commit -m "feat(desktop): scaffold electron-vite + React + TS app shell

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared types

**Files:**
- Create: `desktop/src/shared/types.ts`
- Modify: `desktop/src/renderer/src/env.d.ts`

- [ ] **Step 1: Create `desktop/src/shared/types.ts`:**

```ts
/** One orcha-* Docker compose stack (stack:db:container is 1:1:1 per orcha's model). */
export interface Stack {
  /** Full compose project name, e.g. "orcha-todo-app". */
  project: string
  /** Display name with the "orcha-" prefix stripped, e.g. "todo-app". */
  projectShort: string
  /** Host port mapped to the portal's container port 8000; null when unpublished (stopped). */
  apiPort: number | null
  /** Host port mapped to postgres 5432; null when unpublished (stopped). */
  dbPort: number | null
  /** Raw docker status of the portal container, e.g. "Up 3 hours" / "Exited (0) 2 days ago". */
  portalStatus: string
  /** True iff portalStatus starts with "Up". */
  running: boolean
}

export type BridgeError =
  | { code: 'DOCKER_UNAVAILABLE' }
  | { code: 'COMPOSE_FAILED'; stderr: string }
  | { code: 'UNKNOWN_STACK' }

/** Discriminated IPC result — structured errors survive the IPC boundary
 *  (thrown Errors get flattened to message strings by ipcMain.handle). */
export type IpcResult<T> = { ok: true; data: T } | ({ ok: false } & BridgeError)

/** The full surface the preload bridge exposes as window.orchaDesktop.
 *  Rejections are BridgeError objects (the preload re-throws ok:false results). */
export interface OrchaDesktopApi {
  listStacks(): Promise<Stack[]>
  startStack(project: string): Promise<void>
  stopStack(project: string): Promise<void>
  openPortal(project: string): Promise<void>
}
```

- [ ] **Step 2: Replace `desktop/src/renderer/src/env.d.ts` with:**

```ts
/// <reference types="vite/client" />
import type { OrchaDesktopApi } from '../../shared/types'

declare global {
  interface Window {
    orchaDesktop: OrchaDesktopApi
  }
}

export {}
```

- [ ] **Step 3: Verify typecheck still passes**

```bash
cd desktop && npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add desktop/src/shared/types.ts desktop/src/renderer/src/env.d.ts
git commit -m "feat(desktop): shared Stack/BridgeError/OrchaDesktopApi types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Discovery (TDD)

Ports the CLI's `_discover_stacks` + `_parse_host_port` (see `orcha-cli/orcha_cli/__main__.py:428` and `:761`) to TypeScript, but over `docker ps -a` so stopped stacks appear.

**Files:**
- Create: `desktop/src/main/discovery.ts`
- Test: `desktop/src/main/discovery.test.ts`

- [ ] **Step 1: Write the failing tests** — `desktop/src/main/discovery.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { parseHostPort, parseDockerPs, listStacks } from './discovery'

// Real output shape from this machine (docker ps -a --format with tab separators).
const REAL_OUTPUT = [
  'orcha-quantal-ehr-portal-1\tUp 4 hours\t0.0.0.0:8001->8000/tcp\torcha-quantal-ehr',
  'kan69-plan-localstack\tUp 18 hours (healthy)\t4510-4559/tcp, 5678/tcp, 0.0.0.0:4567->4566/tcp\t',
  'orcha-quantal-ehr-db-1\tUp 21 hours (healthy)\t0.0.0.0:5435->5432/tcp\torcha-quantal-ehr',
  'quantal-backend\tUp 20 hours (healthy)\t0.0.0.0:8103->8103/tcp\tintegration-all-prs',
  ''
].join('\n')

const STOPPED_OUTPUT = [
  'orcha-todo-app-portal-1\tExited (0) 2 days ago\t\torcha-todo-app',
  'orcha-todo-app-db-1\tExited (0) 2 days ago\t\torcha-todo-app',
  ''
].join('\n')

describe('parseHostPort', () => {
  it('extracts the host port for a container port', () => {
    expect(parseHostPort('0.0.0.0:8001->8000/tcp', '8000')).toBe(8001)
  })
  it('picks the right mapping out of a multi-port list', () => {
    expect(
      parseHostPort('4510-4559/tcp, 5678/tcp, 0.0.0.0:4567->4566/tcp', '4566')
    ).toBe(4567)
  })
  it('returns null when the container port is not published', () => {
    expect(parseHostPort('', '8000')).toBeNull()
    expect(parseHostPort('4510-4559/tcp', '8000')).toBeNull()
  })
})

describe('parseDockerPs', () => {
  it('groups orcha-* projects and extracts portal/db ports', () => {
    const stacks = parseDockerPs(REAL_OUTPUT)
    expect(stacks).toEqual([
      {
        project: 'orcha-quantal-ehr',
        projectShort: 'quantal-ehr',
        apiPort: 8001,
        dbPort: 5435,
        portalStatus: 'Up 4 hours',
        running: true
      }
    ])
  })
  it('ignores non-orcha projects and unlabeled containers', () => {
    const stacks = parseDockerPs(REAL_OUTPUT)
    expect(stacks.map((s) => s.project)).not.toContain('integration-all-prs')
  })
  it('includes stopped stacks with null ports and running=false', () => {
    const [stack] = parseDockerPs(STOPPED_OUTPUT)
    expect(stack).toEqual({
      project: 'orcha-todo-app',
      projectShort: 'todo-app',
      apiPort: null,
      dbPort: null,
      portalStatus: 'Exited (0) 2 days ago',
      running: false
    })
  })
  it('skips malformed lines', () => {
    expect(parseDockerPs('garbage\nno\ttabs here\n')).toEqual([])
  })
  it('sorts stacks by project name', () => {
    const out =
      'orcha-zeta-portal-1\tUp 1 hour\t0.0.0.0:8002->8000/tcp\torcha-zeta\n' +
      'orcha-alpha-portal-1\tUp 1 hour\t0.0.0.0:8001->8000/tcp\torcha-alpha\n'
    expect(parseDockerPs(out).map((s) => s.project)).toEqual(['orcha-alpha', 'orcha-zeta'])
  })
})

describe('listStacks', () => {
  it('runs docker ps -a with the label format and parses the output', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_OUTPUT })
    const stacks = await listStacks(exec)
    expect(exec).toHaveBeenCalledWith('docker', [
      'ps',
      '-a',
      '--format',
      '{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}'
    ])
    expect(stacks).toHaveLength(1)
  })
  it('maps exec failure to DOCKER_UNAVAILABLE', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('spawn docker ENOENT'))
    await expect(listStacks(exec)).rejects.toEqual({ code: 'DOCKER_UNAVAILABLE' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd desktop && npx vitest run src/main/discovery.test.ts
```

Expected: FAIL — cannot resolve `./discovery`.

- [ ] **Step 3: Implement `desktop/src/main/discovery.ts`:**

```ts
import { execFile } from 'node:child_process'
import type { Stack } from '../shared/types'

export interface ExecResult {
  stdout: string
}
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve({ stdout })
    })
  })

const PS_FORMAT = '{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}'

/** Mirror of the CLI's _parse_host_port: host port published for a container port. */
export function parseHostPort(portsStr: string, containerPort: string): number | null {
  for (const raw of portsStr.split(',')) {
    const chunk = raw.trim()
    if (chunk.includes(`->${containerPort}/`) && chunk.includes('0.0.0.0:')) {
      const host = chunk.split('0.0.0.0:')[1]?.split('->')[0]
      const port = Number(host)
      if (Number.isInteger(port)) return port
    }
  }
  return null
}

/** Mirror of the CLI's _discover_stacks parsing, over `docker ps -a` output. */
export function parseDockerPs(stdout: string): Stack[] {
  const byProject = new Map<string, Array<{ name: string; status: string; ports: string }>>()
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 4) continue
    const [name, status, ports, project] = parts
    if (!project.startsWith('orcha-')) continue
    const rows = byProject.get(project) ?? []
    rows.push({ name, status, ports })
    byProject.set(project, rows)
  }

  return [...byProject.keys()].sort().map((project) => {
    let apiPort: number | null = null
    let dbPort: number | null = null
    let portalStatus = ''
    for (const { name, status, ports } of byProject.get(project)!) {
      if (name.includes('portal')) {
        portalStatus = status
        apiPort = parseHostPort(ports, '8000')
      } else if (name.includes('db')) {
        dbPort = parseHostPort(ports, '5432')
      }
    }
    return {
      project,
      projectShort: project.replace(/^orcha-/, ''),
      apiPort,
      dbPort,
      portalStatus,
      running: portalStatus.startsWith('Up')
    }
  })
}

/** All orcha-* stacks on this machine, running or stopped.
 *  Rejects with {code:'DOCKER_UNAVAILABLE'} when docker is missing or the daemon is down. */
export async function listStacks(exec: Exec = defaultExec): Promise<Stack[]> {
  let result: ExecResult
  try {
    result = await exec('docker', ['ps', '-a', '--format', PS_FORMAT])
  } catch {
    throw { code: 'DOCKER_UNAVAILABLE' } as const
  }
  return parseDockerPs(result.stdout)
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd desktop && npx vitest run src/main/discovery.test.ts && npm run typecheck
```

Expected: all tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/discovery.ts desktop/src/main/discovery.test.ts
git commit -m "feat(desktop): stack discovery via docker ps -a (ports CLI _discover_stacks)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Lifecycle (TDD)

**Files:**
- Create: `desktop/src/main/lifecycle.ts`
- Test: `desktop/src/main/lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests** — `desktop/src/main/lifecycle.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { startStack, stopStack } from './lifecycle'

describe('lifecycle', () => {
  it('startStack runs docker compose -p <project> start', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '' })
    await startStack('orcha-demo', exec)
    expect(exec).toHaveBeenCalledWith('docker', ['compose', '-p', 'orcha-demo', 'start'])
  })

  it('stopStack runs docker compose -p <project> stop', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '' })
    await stopStack('orcha-demo', exec)
    expect(exec).toHaveBeenCalledWith('docker', ['compose', '-p', 'orcha-demo', 'stop'])
  })

  it('rejects non-orcha project names without invoking docker', async () => {
    const exec = vi.fn()
    await expect(startStack('shadow; rm -rf /', exec)).rejects.toEqual({
      code: 'UNKNOWN_STACK'
    })
    expect(exec).not.toHaveBeenCalled()
  })

  it('maps compose failure to COMPOSE_FAILED with the stderr tail', async () => {
    const err = Object.assign(new Error('exit 1'), {
      stderr: 'a'.repeat(2000) + '\nno such project'
    })
    const exec = vi.fn().mockRejectedValue(err)
    await expect(stopStack('orcha-demo', exec)).rejects.toMatchObject({
      code: 'COMPOSE_FAILED'
    })
    const rejection = await stopStack('orcha-demo', exec).catch((e) => e)
    expect(rejection.stderr.endsWith('no such project')).toBe(true)
    expect(rejection.stderr.length).toBeLessThanOrEqual(500)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd desktop && npx vitest run src/main/lifecycle.test.ts
```

Expected: FAIL — cannot resolve `./lifecycle`.

- [ ] **Step 3: Implement `desktop/src/main/lifecycle.ts`:**

```ts
import { execFile } from 'node:child_process'

export interface ExecResult {
  stdout: string
}
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve({ stdout })
    })
  })

// Belt-and-braces: main/index.ts also validates against the discovery snapshot;
// this guard makes lifecycle safe in isolation (argv is never renderer-controlled
// beyond choosing a known orcha-* project).
const SAFE_PROJECT = /^orcha-[A-Za-z0-9_-]+$/

const STDERR_TAIL = 500

async function compose(project: string, action: 'start' | 'stop', exec: Exec): Promise<void> {
  if (!SAFE_PROJECT.test(project)) {
    throw { code: 'UNKNOWN_STACK' } as const
  }
  try {
    await exec('docker', ['compose', '-p', project, action])
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '')
    throw { code: 'COMPOSE_FAILED', stderr: stderr.slice(-STDERR_TAIL) } as const
  }
}

export const startStack = (project: string, exec: Exec = defaultExec): Promise<void> =>
  compose(project, 'start', exec)

export const stopStack = (project: string, exec: Exec = defaultExec): Promise<void> =>
  compose(project, 'stop', exec)
```

- [ ] **Step 4: Run to verify pass**

```bash
cd desktop && npx vitest run src/main/lifecycle.test.ts && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/lifecycle.ts desktop/src/main/lifecycle.test.ts
git commit -m "feat(desktop): compose start/stop lifecycle with typed failures

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: IPC wiring — main handlers, portal windows, preload bridge

No new unit tests (thin glue; covered by renderer tests with a mocked bridge + Task 7 manual gate). Build + typecheck are the verification.

**Files:**
- Modify: `desktop/src/main/index.ts`
- Modify: `desktop/src/preload/index.ts`

- [ ] **Step 1: Replace `desktop/src/main/index.ts` with:**

```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { listStacks } from './discovery'
import { startStack, stopStack } from './lifecycle'
import type { BridgeError, IpcResult, Stack } from '../shared/types'

let managerWindow: BrowserWindow | null = null
const portalWindows = new Map<string, BrowserWindow>()

function createManagerWindow(): void {
  managerWindow = new BrowserWindow({
    width: 760,
    height: 560,
    title: 'Orcha',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    managerWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    managerWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  managerWindow.on('closed', () => {
    managerWindow = null
  })
}

function openPortalWindow(stack: Stack): void {
  const existing = portalWindows.get(stack.project)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: `Orcha — ${stack.projectShort}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.loadURL(`http://localhost:${stack.apiPort}/`)
  win.on('closed', () => {
    portalWindows.delete(stack.project)
  })
  portalWindows.set(stack.project, win)
}

/** Wrap a handler so structured BridgeErrors survive IPC (thrown Errors get
 *  flattened to strings by ipcMain.handle — so we return IpcResult instead). */
function asResult<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  return fn().then(
    (data) => ({ ok: true as const, data }),
    (err: BridgeError) => ({ ok: false as const, ...err })
  )
}

/** Validate a renderer-supplied project name against the live discovery snapshot. */
async function requireKnownStack(project: string): Promise<Stack> {
  const stacks = await listStacks()
  const stack = stacks.find((s) => s.project === project)
  if (!stack) throw { code: 'UNKNOWN_STACK' } as const
  return stack
}

app.whenReady().then(() => {
  ipcMain.handle('orcha:listStacks', () => asResult(() => listStacks()))

  ipcMain.handle('orcha:startStack', (_event, project: string) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      await startStack(stack.project)
    })
  )

  ipcMain.handle('orcha:stopStack', (_event, project: string) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      await stopStack(stack.project)
    })
  )

  ipcMain.handle('orcha:openPortal', (_event, project: string) =>
    asResult(async () => {
      const stack = await requireKnownStack(project)
      if (!stack.running || stack.apiPort === null) throw { code: 'UNKNOWN_STACK' } as const
      openPortalWindow(stack)
    })
  )

  createManagerWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createManagerWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
```

- [ ] **Step 2: Replace `desktop/src/preload/index.ts` with:**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcResult, OrchaDesktopApi, Stack } from '../shared/types'

/** Unwrap IpcResult: ok:false becomes a typed rejection (the BridgeError object). */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) {
    const { ok: _ok, ...error } = result
    throw error
  }
  return result.data
}

const api: OrchaDesktopApi = {
  listStacks: () => invoke<Stack[]>('orcha:listStacks'),
  startStack: (project) => invoke<void>('orcha:startStack', project),
  stopStack: (project) => invoke<void>('orcha:stopStack', project),
  openPortal: (project) => invoke<void>('orcha:openPortal', project)
}

contextBridge.exposeInMainWorld('orchaDesktop', api)
```

- [ ] **Step 3: Verify**

```bash
cd desktop && npm run build && npm run typecheck && npm test
```

Expected: build + typecheck clean; existing discovery/lifecycle tests still pass.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main/index.ts desktop/src/preload/index.ts
git commit -m "feat(desktop): IPC handlers, portal windows, preload bridge

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Renderer — App, StackList, StackCard, banners (TDD)

**Files:**
- Create: `desktop/src/renderer/src/components/StackCard.tsx`, `StackList.tsx`, `DockerDownBanner.tsx`, `EmptyState.tsx`
- Create: `desktop/src/renderer/src/styles.css`
- Modify: `desktop/src/renderer/src/App.tsx`, `desktop/src/renderer/src/main.tsx` (import styles)
- Test: `desktop/src/renderer/src/components/StackCard.test.tsx`, `desktop/src/renderer/src/App.test.tsx`

- [ ] **Step 1: Write the failing component tests.**

`desktop/src/renderer/src/components/StackCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StackCard from './StackCard'
import type { Stack } from '../../../shared/types'

const runningStack: Stack = {
  project: 'orcha-quantal-ehr',
  projectShort: 'quantal-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true
}

const stoppedStack: Stack = {
  ...runningStack,
  apiPort: null,
  dbPort: null,
  portalStatus: 'Exited (0) 2 days ago',
  running: false
}

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
    startStack: vi.fn().mockResolvedValue(undefined),
    stopStack: vi.fn().mockResolvedValue(undefined),
    openPortal: vi.fn().mockResolvedValue(undefined)
  }
})

describe('StackCard', () => {
  it('shows name, running pill, ports, and a Stop button when running', () => {
    render(<StackCard stack={runningStack} onChanged={vi.fn()} />)
    expect(screen.getByText('quantal-ehr')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText(/API :8001/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Open portal' })).toBeEnabled()
  })

  it('shows stopped pill, Start button, and disables Open portal when stopped', () => {
    render(<StackCard stack={stoppedStack} onChanged={vi.fn()} />)
    expect(screen.getByText('stopped')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Open portal' })).toBeDisabled()
  })

  it('calls stopStack then onChanged on Stop click', async () => {
    const onChanged = vi.fn()
    render(<StackCard stack={runningStack} onChanged={onChanged} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(window.orchaDesktop.stopStack).toHaveBeenCalledWith('orcha-quantal-ehr')
  })

  it('calls openPortal with the project on Open portal click', async () => {
    render(<StackCard stack={runningStack} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open portal' }))
    expect(window.orchaDesktop.openPortal).toHaveBeenCalledWith('orcha-quantal-ehr')
  })

  it('shows the stderr tail inline when an action fails', async () => {
    window.orchaDesktop.startStack = vi
      .fn()
      .mockRejectedValue({ code: 'COMPOSE_FAILED', stderr: 'no such project' })
    render(<StackCard stack={stoppedStack} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByText(/no such project/)).toBeInTheDocument()
  })
})
```

`desktop/src/renderer/src/App.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'
import type { Stack } from '../../shared/types'

const stack: Stack = {
  project: 'orcha-demo',
  projectShort: 'demo',
  apiPort: 8001,
  dbPort: 5433,
  portalStatus: 'Up 1 hour',
  running: true
}

beforeEach(() => {
  // shouldAdvanceTime keeps findBy*/waitFor working while the 5s poll timer is faked.
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('App', () => {
  it('renders stack cards when stacks exist', async () => {
    window.orchaDesktop = {
      listStacks: vi.fn().mockResolvedValue([stack]),
      startStack: vi.fn(),
      stopStack: vi.fn(),
      openPortal: vi.fn()
    }
    render(<App />)
    expect(await screen.findByText('demo')).toBeInTheDocument()
  })

  it('shows the Docker banner when discovery rejects with DOCKER_UNAVAILABLE', async () => {
    window.orchaDesktop = {
      listStacks: vi.fn().mockRejectedValue({ code: 'DOCKER_UNAVAILABLE' }),
      startStack: vi.fn(),
      stopStack: vi.fn(),
      openPortal: vi.fn()
    }
    render(<App />)
    expect(await screen.findByText(/Docker isn't running/)).toBeInTheDocument()
  })

  it('shows the empty state when Docker is up but no stacks exist', async () => {
    window.orchaDesktop = {
      listStacks: vi.fn().mockResolvedValue([]),
      startStack: vi.fn(),
      stopStack: vi.fn(),
      openPortal: vi.fn()
    }
    render(<App />)
    expect(await screen.findByText(/No orcha stacks yet/)).toBeInTheDocument()
  })
})
```

Note: `@testing-library/user-event` is needed — install it in this task:

```bash
cd desktop && npm install -D @testing-library/user-event
```

- [ ] **Step 2: Run to verify failure**

```bash
cd desktop && npx vitest run src/renderer
```

Expected: FAIL — cannot resolve `./components/StackCard` (and App has no bridge usage yet).

- [ ] **Step 3: Implement the components.**

`desktop/src/renderer/src/components/StackCard.tsx`:

```tsx
import { useState } from 'react'
import type { BridgeError, Stack } from '../../../shared/types'

interface Props {
  stack: Stack
  onChanged: () => void
}

export default function StackCard({ stack, onChanged }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      const bridgeError = err as BridgeError
      setError('stderr' in bridgeError ? bridgeError.stderr : bridgeError.code)
    } finally {
      setBusy(false)
    }
  }

  const api = window.orchaDesktop
  return (
    <div className="stack-card">
      <div className="stack-card-header">
        <span className="stack-name">{stack.projectShort}</span>
        <span className={`pill ${stack.running ? 'pill-running' : 'pill-stopped'}`}>
          {stack.running ? 'running' : 'stopped'}
        </span>
      </div>
      <div className="stack-meta">
        {stack.running && stack.apiPort !== null ? (
          <span>
            API :{stack.apiPort} · DB :{stack.dbPort ?? '?'}
          </span>
        ) : (
          <span className="muted">{stack.portalStatus || 'not running'}</span>
        )}
      </div>
      <div className="stack-actions">
        <button
          disabled={!stack.running || stack.apiPort === null || busy}
          onClick={() => run(() => api.openPortal(stack.project))}
        >
          Open portal
        </button>
        {stack.running ? (
          <button disabled={busy} onClick={() => run(() => api.stopStack(stack.project))}>
            Stop
          </button>
        ) : (
          <button disabled={busy} onClick={() => run(() => api.startStack(stack.project))}>
            Start
          </button>
        )}
      </div>
      {error && <div className="stack-error">{error}</div>}
    </div>
  )
}
```

`desktop/src/renderer/src/components/StackList.tsx`:

```tsx
import type { Stack } from '../../../shared/types'
import StackCard from './StackCard'

interface Props {
  stacks: Stack[]
  onChanged: () => void
}

export default function StackList({ stacks, onChanged }: Props) {
  return (
    <div className="stack-list">
      {stacks.map((stack) => (
        <StackCard key={stack.project} stack={stack} onChanged={onChanged} />
      ))}
    </div>
  )
}
```

`desktop/src/renderer/src/components/DockerDownBanner.tsx`:

```tsx
export default function DockerDownBanner() {
  return (
    <div className="banner banner-error">
      Docker isn't running. Start Docker Desktop (or OrbStack/Colima) — this list refreshes
      automatically.
    </div>
  )
}
```

`desktop/src/renderer/src/components/EmptyState.tsx`:

```tsx
export default function EmptyState() {
  return (
    <div className="banner">
      No orcha stacks yet — run <code>orcha init</code> in a project to create one.
    </div>
  )
}
```

- [ ] **Step 4: Replace `desktop/src/renderer/src/App.tsx`:**

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { Stack } from '../../shared/types'
import StackList from './components/StackList'
import DockerDownBanner from './components/DockerDownBanner'
import EmptyState from './components/EmptyState'

const POLL_MS = 5000

type ViewState =
  | { kind: 'loading' }
  | { kind: 'dockerDown' }
  | { kind: 'ready'; stacks: Stack[] }

export default function App() {
  const [view, setView] = useState<ViewState>({ kind: 'loading' })

  const refresh = useCallback(async () => {
    try {
      const stacks = await window.orchaDesktop.listStacks()
      setView({ kind: 'ready', stacks })
    } catch {
      setView({ kind: 'dockerDown' })
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  return (
    <main>
      <h1>Orcha stacks</h1>
      {view.kind === 'loading' && <div className="banner">Loading…</div>}
      {view.kind === 'dockerDown' && <DockerDownBanner />}
      {view.kind === 'ready' &&
        (view.stacks.length === 0 ? (
          <EmptyState />
        ) : (
          <StackList stacks={view.stacks} onChanged={() => void refresh()} />
        ))}
    </main>
  )
}
```

- [ ] **Step 5: Create `desktop/src/renderer/src/styles.css`** and import it as the first line of `main.tsx` (`import './styles.css'`):

```css
:root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color-scheme: light dark;
}

body {
  margin: 0;
}

main {
  padding: 1.25rem;
}

h1 {
  font-size: 1.15rem;
  margin: 0 0 1rem;
}

.stack-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.stack-card {
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 10px;
  padding: 0.85rem 1rem;
}

.stack-card-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.stack-name {
  font-weight: 600;
}

.pill {
  font-size: 0.72rem;
  border-radius: 999px;
  padding: 0.1rem 0.55rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.pill-running {
  background: #16341f;
  color: #42d98a;
}

.pill-stopped {
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.stack-meta {
  margin: 0.4rem 0 0.7rem;
  font-size: 0.85rem;
}

.muted {
  opacity: 0.65;
}

.stack-actions {
  display: flex;
  gap: 0.5rem;
}

button {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  background: transparent;
  color: inherit;
  border-radius: 7px;
  padding: 0.3rem 0.8rem;
  cursor: pointer;
}

button:disabled {
  opacity: 0.45;
  cursor: default;
}

.stack-error {
  margin-top: 0.6rem;
  font-size: 0.8rem;
  color: #d9544f;
  white-space: pre-wrap;
}

.banner {
  padding: 0.85rem 1rem;
  border-radius: 10px;
  border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);
}

.banner-error {
  border-style: solid;
  color: #d9544f;
}
```

- [ ] **Step 6: Run all tests + build**

```bash
cd desktop && npm test && npm run typecheck && npm run build
```

Expected: all vitest suites pass (discovery, lifecycle, StackCard, App); build clean.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/renderer desktop/package.json desktop/package-lock.json
git commit -m "feat(desktop): React stack manager UI — cards, banners, poll loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Local verification gate (manual) + wrap-up

**Files:** none (verification only; PR happens only after the human confirms).

- [ ] **Step 1: Full check from clean state**

```bash
cd desktop && rm -rf out && npm test && npm run typecheck && npm run build
```

Expected: everything green.

- [ ] **Step 2: Confirm the Postman collection is untouched**

```bash
git diff main --stat -- docs/orcha.postman_collection.json
```

Expected: empty.

- [ ] **Step 3: Launch the app for manual verification** (GUI session on this Mac):

```bash
cd desktop && npm run dev
```

Run in the background and report to the human what to check:
- The window lists the real stack `quantal-ehr` with a green "running" pill and `API :8001 · DB :5435`.
- "Open portal" opens the dashboard window (the portal at localhost:8001).
- "Stop" flips the card to stopped (give the 5 s poll a beat); "Start" brings it back. ⚠️ Only do the stop/start round-trip with the human's OK — it briefly interrupts the live stack.
- Quitting Docker Desktop (optional) shows the banner.

- [ ] **Step 4: STOP — wait for the human's confirmation of the manual test.** Only after their OK: push and open the PR.

```bash
git push -u origin feat/desktop-app
gh pr create --title "Orcha Desktop v1 — Electron+React stack manager (Orcha#237)" --body "$(cat <<'EOF'
## What

v1 of the desktop app (#237): an Electron + React + TypeScript window app in `desktop/` that lists every `orcha-*` Docker stack (running or stopped), starts/stops them via `docker compose -p`, and opens each stack's existing web portal in an app window.

- Discovery ports the CLI's `_discover_stacks` to TS over `docker ps -a` (stopped stacks appear).
- All privileged work in the main process behind a 4-method typed IPC bridge (`IpcResult` discriminated results; sandboxed renderer, contextIsolation on).
- Vitest: discovery/lifecycle unit tests + StackCard/App component tests (jsdom).
- Verified locally against the real `orcha-quantal-ehr` stack (cards, start/stop, portal window, Docker-down banner).

Spec: `docs/superpowers/specs/2026-06-11-desktop-app-design.md`
Plan: `docs/superpowers/plans/2026-06-11-desktop-app.md`

## Out of scope (recorded in spec §8)

Packaging/signing/DMG/auto-update (gated on #238's release pipeline), `orcha init` from the app, tray icon, Windows/Linux. Desktop CI wiring deferred (runner Node availability unverified).

## Notes

- No HTTP routes / DB shapes changed ⇒ Postman collection untouched (FT-DEPLOY-4 unaffected).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Report** — PR URL + what was manually verified.

---

# v1.1 addendum — Tray, attention & notifications (approved; spec §9)

> Task 7's Step 4 (push + PR) is **superseded**: the PR happens at Task 11 after the
> v1.1 manual gate. Everything below is API-consuming only — Postman untouched.
> Real API shapes (captured live from localhost:8001):
> `GET /api/containers` → `{containers:[{id,name,...}]}`;
> `GET /api/containers/{cid}` → `{agents:[{id,alias,kind:'human'|'ai',status}],...}`;
> `GET /api/containers/{cid}/requests?limit=N` → `{requests:[{id,type,status:'open'|'answered'|'closed',target_id,requester_id,detail,...}],total,has_more}`;
> `GET /api/containers/{cid}/tasks?limit=N` → `{tasks:[{id,title,status,...}],total,has_more}`.

### Task 8: Attention engine (TDD)

**Files:**
- Modify: `desktop/src/shared/types.ts` (append)
- Create: `desktop/src/main/attention.ts`
- Test: `desktop/src/main/attention.test.ts`

- [ ] **Step 1: Append to `desktop/src/shared/types.ts`:**

```ts
/** One thing waiting on the human, surfaced in tray/popover/notifications/cards. */
export interface AttentionItem {
  project: string
  projectShort: string
  kind: 'request_answer' | 'request_close' | 'task_verify' | 'health'
  /** Stable id for dedup (request/task uuid, or health:<project>:<up|down>). */
  id: string
  title: string
}
```

And extend `OrchaDesktopApi` with three methods (same rejection contract):

```ts
  listAttention(): Promise<AttentionItem[]>
  openManager(): Promise<void>
  quitApp(): Promise<void>
```

- [ ] **Step 2: Write the failing tests** — create `desktop/src/main/attention.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { computeAttention, fetchStackAttention } from './attention'
import type { Stack } from '../shared/types'

const stack: Stack = {
  project: 'orcha-quantal-ehr',
  projectShort: 'quantal-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true
}

// Shapes captured from the live portal API.
const AGENTS = [
  { id: 'human-1', alias: 'husseinmohamed', kind: 'human' },
  { id: 'ai-1', alias: 'Atlas', kind: 'ai' }
]

describe('computeAttention', () => {
  it('flags open requests targeting a human as request_answer', () => {
    const items = computeAttention(stack, AGENTS, [
      { id: 'r1', status: 'open', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'Need a decision' }
    ], [])
    expect(items).toEqual([
      {
        project: 'orcha-quantal-ehr',
        projectShort: 'quantal-ehr',
        kind: 'request_answer',
        id: 'r1',
        title: 'Need a decision'
      }
    ])
  })

  it('flags escalated requests (null target) as request_answer', () => {
    const items = computeAttention(stack, AGENTS, [
      { id: 'r2', status: 'open', target_id: null, requester_id: 'ai-1', type: 'approval', detail: null }
    ], [])
    expect(items.map((i) => i.kind)).toEqual(['request_answer'])
    expect(items[0].title).toBe('approval')   // falls back to type when detail is null
  })

  it('ignores open requests targeting an AI', () => {
    expect(computeAttention(stack, AGENTS, [
      { id: 'r3', status: 'open', target_id: 'ai-1', requester_id: 'human-1', type: 'info', detail: 'x' }
    ], [])).toEqual([])
  })

  it('flags answered requests raised by a human as request_close', () => {
    const items = computeAttention(stack, AGENTS, [
      { id: 'r4', status: 'answered', target_id: 'ai-1', requester_id: 'human-1', type: 'info', detail: 'My question' }
    ], [])
    expect(items.map((i) => i.kind)).toEqual(['request_close'])
  })

  it('ignores answered requests raised by an AI, and closed requests entirely', () => {
    expect(computeAttention(stack, AGENTS, [
      { id: 'r5', status: 'answered', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'x' },
      { id: 'r6', status: 'closed', target_id: 'human-1', requester_id: 'human-1', type: 'info', detail: 'x' }
    ], [])).toEqual([])
  })

  it('flags needs_verification tasks and ignores other statuses', () => {
    const items = computeAttention(stack, AGENTS, [], [
      { id: 't1', title: 'Ship the feature', status: 'needs_verification' },
      { id: 't2', title: 'WIP', status: 'in_progress' },
      { id: 't3', title: 'Ready', status: 'ready' }
    ])
    expect(items).toEqual([
      {
        project: 'orcha-quantal-ehr',
        projectShort: 'quantal-ehr',
        kind: 'task_verify',
        id: 't1',
        title: 'Ship the feature'
      }
    ])
  })

  it('truncates long titles to 80 chars', () => {
    const items = computeAttention(stack, AGENTS, [
      { id: 'r7', status: 'open', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'x'.repeat(200) }
    ], [])
    expect(items[0].title.length).toBeLessThanOrEqual(80)
  })
})

describe('fetchStackAttention', () => {
  it('returns [] without fetching when the stack is not running', async () => {
    const fetchJson = vi.fn()
    const stopped: Stack = { ...stack, running: false, apiPort: null }
    expect(await fetchStackAttention(stopped, fetchJson)).toEqual([])
    expect(fetchJson).not.toHaveBeenCalled()
  })

  it('walks containers -> detail -> requests -> tasks and computes items', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/containers')) return { containers: [{ id: 'cid-1' }] }
      if (url.endsWith('/api/containers/cid-1')) return { agents: AGENTS }
      if (url.includes('/requests')) return {
        requests: [{ id: 'r1', status: 'open', target_id: 'human-1', requester_id: 'ai-1', type: 'info', detail: 'Hi' }]
      }
      if (url.includes('/tasks')) return {
        tasks: [{ id: 't1', title: 'Verify me', status: 'needs_verification' }]
      }
      throw new Error(`unexpected url ${url}`)
    })
    const items = await fetchStackAttention(stack, fetchJson)
    expect(items.map((i) => i.id).sort()).toEqual(['r1', 't1'])
    expect(fetchJson).toHaveBeenCalledWith('http://localhost:8001/api/containers')
    expect(fetchJson).toHaveBeenCalledWith('http://localhost:8001/api/containers/cid-1/requests?limit=100')
    expect(fetchJson).toHaveBeenCalledWith('http://localhost:8001/api/containers/cid-1/tasks?limit=100')
  })

  it('returns [] when the stack has no container yet', async () => {
    const fetchJson = vi.fn(async () => ({ containers: [] }))
    expect(await fetchStackAttention(stack, fetchJson)).toEqual([])
  })
})
```

- [ ] **Step 3: Run to verify failure** — `cd desktop && npx vitest run src/main/attention.test.ts` → cannot resolve `./attention`.

- [ ] **Step 4: Implement `desktop/src/main/attention.ts`:**

```ts
import type { AttentionItem, Stack } from '../shared/types'

export type FetchJson = (url: string) => Promise<unknown>

export const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res.json()
}

interface AgentRow { id: string; kind: string }
interface RequestRow {
  id: string
  status: string
  target_id: string | null
  requester_id: string | null
  type?: string | null
  detail?: string | null
}
interface TaskRow { id: string; title: string; status: string }

const TITLE_MAX = 80

function clip(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text
}

/** Pure: which requests/tasks are waiting on a HUMAN right now.
 *  Open request → the target owes an answer (null target = escalated to a human).
 *  Answered request → the requester owes a close.
 *  needs_verification task → a human owes verification (standing working agreement). */
export function computeAttention(
  stack: Stack,
  agents: AgentRow[],
  requests: RequestRow[],
  tasks: TaskRow[]
): AttentionItem[] {
  const humans = new Set(agents.filter((a) => a.kind === 'human').map((a) => a.id))
  const base = { project: stack.project, projectShort: stack.projectShort }
  const items: AttentionItem[] = []
  for (const r of requests) {
    const title = clip(r.detail || r.type || 'request')
    if (r.status === 'open' && (r.target_id === null || humans.has(r.target_id))) {
      items.push({ ...base, kind: 'request_answer', id: r.id, title })
    } else if (r.status === 'answered' && r.requester_id !== null && humans.has(r.requester_id)) {
      items.push({ ...base, kind: 'request_close', id: r.id, title })
    }
  }
  for (const t of tasks) {
    if (t.status === 'needs_verification') {
      items.push({ ...base, kind: 'task_verify', id: t.id, title: clip(t.title) })
    }
  }
  return items
}

/** Fetch + compute one running stack's attention items (containers → detail →
 *  requests → tasks, all existing portal endpoints — consume-only). */
export async function fetchStackAttention(
  stack: Stack,
  fetchJson: FetchJson = defaultFetchJson
): Promise<AttentionItem[]> {
  if (!stack.running || stack.apiPort === null) return []
  const base = `http://localhost:${stack.apiPort}`
  const containers = (await fetchJson(`${base}/api/containers`)) as {
    containers: Array<{ id: string }>
  }
  const cid = containers.containers[0]?.id
  if (!cid) return []
  const detail = (await fetchJson(`${base}/api/containers/${cid}`)) as { agents: AgentRow[] }
  const reqs = (await fetchJson(`${base}/api/containers/${cid}/requests?limit=100`)) as {
    requests: RequestRow[]
  }
  const tasks = (await fetchJson(`${base}/api/containers/${cid}/tasks?limit=100`)) as {
    tasks: TaskRow[]
  }
  return computeAttention(stack, detail.agents, reqs.requests, tasks.tasks)
}
```

- [ ] **Step 5: Verify** — `cd desktop && npx vitest run src/main/attention.test.ts && npm run typecheck` → 10 tests pass, clean.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/shared/types.ts desktop/src/main/attention.ts desktop/src/main/attention.test.ts
git commit -m "feat(desktop): attention engine — human-pending requests/tasks per stack

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Note: typecheck will fail at this point ONLY if the preload hasn't implemented the three new OrchaDesktopApi methods — it won't, because preload assigns a complete `api: OrchaDesktopApi` object. If `npm run typecheck` reports the preload api object as incomplete, implement the three preload methods in THIS commit too (copy the pattern: `listAttention: () => invoke<AttentionItem[]>('orcha:listAttention')` etc.) and note it in your report — Task 10 wires the main-process side.)

### Task 9: Poller — baseline, dedup, health transitions (TDD)

**Files:**
- Create: `desktop/src/main/attentionPoller.ts`
- Test: `desktop/src/main/attentionPoller.test.ts`

- [ ] **Step 1: Write the failing tests** — create `desktop/src/main/attentionPoller.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { AttentionPoller } from './attentionPoller'
import type { AttentionItem, Stack } from '../shared/types'

const stackUp: Stack = {
  project: 'orcha-demo',
  projectShort: 'demo',
  apiPort: 8001,
  dbPort: 5433,
  portalStatus: 'Up 1 hour',
  running: true
}
const stackDown: Stack = { ...stackUp, running: false, apiPort: null, portalStatus: 'Exited (0)' }

const item = (id: string): AttentionItem => ({
  project: 'orcha-demo',
  projectShort: 'demo',
  kind: 'request_answer',
  id,
  title: `item ${id}`
})

function makePoller(overrides: Partial<{
  listStacks: () => Promise<Stack[]>
  fetchStackAttention: (s: Stack) => Promise<AttentionItem[]>
}> = {}) {
  const notify = vi.fn()
  const onUpdate = vi.fn()
  const deps = {
    listStacks: overrides.listStacks ?? vi.fn(async () => [stackUp]),
    fetchStackAttention: overrides.fetchStackAttention ?? vi.fn(async () => []),
    notify,
    onUpdate
  }
  return { poller: new AttentionPoller(deps), notify, onUpdate, deps }
}

describe('AttentionPoller', () => {
  it('first tick is a silent baseline (no notifications, cache populated)', async () => {
    const { poller, notify, onUpdate } = makePoller({
      fetchStackAttention: vi.fn(async () => [item('r1')])
    })
    await poller.tick()
    expect(notify).not.toHaveBeenCalled()
    expect(poller.current()).toEqual([item('r1')])
    expect(onUpdate).toHaveBeenCalledWith([item('r1')])
  })

  it('notifies once for an item that appears after the baseline', async () => {
    const fetch = vi.fn(async () => [] as AttentionItem[])
    const { poller, notify } = makePoller({ fetchStackAttention: fetch })
    await poller.tick()                                  // baseline: empty
    fetch.mockResolvedValue([item('r1')])
    await poller.tick()                                  // r1 appears
    await poller.tick()                                  // still present
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(item('r1'))
  })

  it('re-notifies when an item disappears and reappears', async () => {
    const fetch = vi.fn(async () => [] as AttentionItem[])
    const { poller, notify } = makePoller({ fetchStackAttention: fetch })
    await poller.tick()                                  // baseline
    fetch.mockResolvedValue([item('r1')])
    await poller.tick()                                  // appears -> notify 1
    fetch.mockResolvedValue([])
    await poller.tick()                                  // gone
    fetch.mockResolvedValue([item('r1')])
    await poller.tick()                                  // back -> notify 2
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('does not fetch attention for stopped stacks', async () => {
    const fetch = vi.fn(async () => [item('r1')])
    const { poller } = makePoller({
      listStacks: vi.fn(async () => [stackDown]),
      fetchStackAttention: fetch
    })
    await poller.tick()
    expect(fetch).not.toHaveBeenCalled()
    expect(poller.current()).toEqual([])
  })

  it('emits health notifications on running-state transitions (after baseline only)', async () => {
    const list = vi.fn(async () => [stackUp])
    const { poller, notify } = makePoller({ listStacks: list })
    await poller.tick()                                  // baseline: up, silent
    list.mockResolvedValue([stackDown])
    await poller.tick()                                  // up -> down
    list.mockResolvedValue([stackUp])
    await poller.tick()                                  // down -> up
    const healthCalls = notify.mock.calls.map((c) => c[0]).filter((i) => i.kind === 'health')
    expect(healthCalls.map((i) => i.id)).toEqual(['health:orcha-demo:down', 'health:orcha-demo:up'])
  })

  it('a per-stack fetch failure skips that stack but the tick survives', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('api hiccup')
    })
    const { poller } = makePoller({ fetchStackAttention: fetch })
    await poller.tick()
    expect(poller.current()).toEqual([])
  })

  it('a listStacks failure (docker down) keeps the previous cache', async () => {
    const fetch = vi.fn(async () => [item('r1')])
    const list = vi.fn(async () => [stackUp])
    const { poller, deps } = makePoller({ listStacks: list, fetchStackAttention: fetch })
    await poller.tick()
    ;(deps.listStacks as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'DOCKER_UNAVAILABLE' })
    await poller.tick()
    expect(poller.current()).toEqual([item('r1')])
  })
})
```

- [ ] **Step 2: Run to verify failure** — cannot resolve `./attentionPoller`.

- [ ] **Step 3: Implement `desktop/src/main/attentionPoller.ts`:**

```ts
import type { AttentionItem, Stack } from '../shared/types'

export interface PollerDeps {
  listStacks(): Promise<Stack[]>
  fetchStackAttention(stack: Stack): Promise<AttentionItem[]>
  /** Fire a user-facing notification (system Notification in production). */
  notify(item: AttentionItem): void
  /** Called with the full current item list after every successful tick. */
  onUpdate?(items: AttentionItem[]): void
}

const key = (i: AttentionItem): string => `${i.project}:${i.kind}:${i.id}`

/** Polls stacks for human-attention items. First tick is a silent baseline;
 *  afterwards every newly-appearing item notifies exactly once (and again if
 *  it disappears and comes back). Health transitions notify directly. */
export class AttentionPoller {
  private seen = new Set<string>()
  private baselined = false
  private lastRunning = new Map<string, boolean>()
  private cached: AttentionItem[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private deps: PollerDeps,
    private intervalMs = 15_000
  ) {}

  current(): AttentionItem[] {
    return this.cached
  }

  start(): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    let stacks: Stack[]
    try {
      stacks = await this.deps.listStacks()
    } catch {
      return // docker down: keep the previous cache; recover next tick
    }

    for (const s of stacks) {
      const was = this.lastRunning.get(s.project)
      if (this.baselined && was !== undefined && was !== s.running) {
        this.deps.notify({
          project: s.project,
          projectShort: s.projectShort,
          kind: 'health',
          id: `health:${s.project}:${s.running ? 'up' : 'down'}`,
          title: s.running ? `${s.projectShort} is back up` : `${s.projectShort} went down`
        })
      }
      this.lastRunning.set(s.project, s.running)
    }

    const items: AttentionItem[] = []
    for (const s of stacks) {
      if (!s.running) continue
      try {
        items.push(...(await this.deps.fetchStackAttention(s)))
      } catch {
        // one stack's API hiccup must not kill the tick
      }
    }

    if (this.baselined) {
      for (const i of items) {
        if (!this.seen.has(key(i))) this.deps.notify(i)
      }
    }
    this.seen = new Set(items.map(key))
    this.cached = items
    this.baselined = true
    this.deps.onUpdate?.(items)
  }
}
```

- [ ] **Step 4: Verify** — `cd desktop && npx vitest run src/main/attentionPoller.test.ts && npm run typecheck && npm test` → 7 new tests pass; whole suite green.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/attentionPoller.ts desktop/src/main/attentionPoller.test.ts
git commit -m "feat(desktop): attention poller — silent baseline, dedup, health transitions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 10: Tray + popover + IPC + renderer surfaces

**Files:**
- Create: `desktop/src/main/tray.ts`
- Modify: `desktop/src/main/index.ts`, `desktop/src/preload/index.ts`
- Create: `desktop/src/renderer/src/tray/TrayPanel.tsx`
- Modify: `desktop/src/renderer/src/main.tsx` (hash route), `desktop/src/renderer/src/styles.css` (append), `desktop/src/renderer/src/App.tsx` + `components/StackCard.tsx` (attention badge)
- Test: `desktop/src/renderer/src/tray/TrayPanel.test.tsx`, extend `components/StackCard.test.tsx`

- [ ] **Step 1: Create `desktop/src/main/tray.ts`:**

```ts
import { BrowserWindow, Menu, Tray, nativeImage } from 'electron'

export interface TrayController {
  update(count: number): void
  destroy(): void
}

/** Menu-bar presence. v1.1 uses a text glyph as the tray face (empty image +
 *  title) — a proper template-image icon lands with packaging. Left-click
 *  toggles the popover; right-click shows a minimal native menu. */
export function createTray(opts: {
  onOpenManager(): void
  createPopover(): BrowserWindow
}): TrayController {
  const tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('⬡')
  let popover: BrowserWindow | null = null

  tray.on('click', () => {
    if (popover && !popover.isDestroyed() && popover.isVisible()) {
      popover.hide()
      return
    }
    if (!popover || popover.isDestroyed()) {
      popover = opts.createPopover()
      popover.on('blur', () => {
        if (popover && !popover.isDestroyed()) popover.hide()
      })
    }
    const b = tray.getBounds()
    const { width } = popover.getBounds()
    popover.setPosition(Math.round(b.x + b.width / 2 - width / 2), Math.round(b.y + b.height + 4))
    popover.show()
  })

  tray.on('right-click', () => {
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Orcha', click: opts.onOpenManager },
        { type: 'separator' },
        { label: 'Quit Orcha', role: 'quit' }
      ])
    )
  })

  return {
    update(count: number): void {
      tray.setTitle(count > 0 ? `⬢ ${count}` : '⬡')
    },
    destroy(): void {
      tray.destroy()
    }
  }
}
```

- [ ] **Step 2: Wire `desktop/src/main/index.ts`.** Keep everything that exists; make these changes:

a) Extend imports:

```ts
import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron'
import { fetchStackAttention } from './attention'
import { AttentionPoller } from './attentionPoller'
import { createTray, type TrayController } from './tray'
import type { AttentionItem, BridgeError, IpcResult, Stack } from '../shared/types'
```

b) Module state additions:

```ts
let tray: TrayController | null = null
let poller: AttentionPoller | null = null
```

c) `createManagerWindow` gains a guard so it can be reused as "open or focus":

```ts
function showManagerWindow(): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
    managerWindow.show()
    managerWindow.focus()
    return
  }
  createManagerWindow()
}
```

d) Popover factory (frameless, hidden until positioned, `#tray` route):

```ts
function createPopoverWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#tray`)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'tray' })
  }
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}
```

e) Notifications + portal-by-project helper:

```ts
async function openPortalByProject(project: string): Promise<void> {
  const stacks = await listStacks()
  const stack = stacks.find((s) => s.project === project)
  if (stack && stack.running && stack.apiPort !== null) openPortalWindow(stack)
}

function showAttentionNotification(item: AttentionItem): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: `Orcha — ${item.projectShort}`, body: item.title })
  n.on('click', () => void openPortalByProject(item.project))
  n.show()
}
```

f) Inside `app.whenReady().then(() => { ... })`, add the three new handlers next to the existing four, then the tray + poller setup before `createManagerWindow()`:

```ts
  ipcMain.handle('orcha:listAttention', () => asResult(async () => poller?.current() ?? []))

  ipcMain.handle('orcha:openManager', () => asResult(async () => showManagerWindow()))

  ipcMain.handle('orcha:quitApp', () => asResult(async () => app.quit()))

  tray = createTray({ onOpenManager: showManagerWindow, createPopover: createPopoverWindow })
  poller = new AttentionPoller({
    listStacks,
    fetchStackAttention,
    notify: showAttentionNotification,
    onUpdate: (items) => tray?.update(items.length)
  })
  poller.start()
```

g) Close-to-tray: replace the `window-all-closed` handler and the `activate` callback:

```ts
app.on('window-all-closed', () => {
  // Tray app: stay alive on macOS; quit elsewhere (v1.1 is macOS-first).
  if (process.platform !== 'darwin') app.quit()
})
```

and in `activate`: `showManagerWindow()` instead of the `getAllWindows().length === 0` check.

Also change the existing `activate` registration accordingly, and call `poller?.stop()` + `tray?.destroy()` in a `before-quit` handler:

```ts
app.on('before-quit', () => {
  poller?.stop()
  tray?.destroy()
})
```

- [ ] **Step 3: Extend `desktop/src/preload/index.ts`** — add to the `api` object:

```ts
  listAttention: () => invoke<AttentionItem[]>('orcha:listAttention'),
  openManager: () => invoke<void>('orcha:openManager'),
  quitApp: () => invoke<void>('orcha:quitApp')
```

(plus `AttentionItem` in the type-only import).

- [ ] **Step 4: Write the failing renderer tests.**

Create `desktop/src/renderer/src/tray/TrayPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TrayPanel from './TrayPanel'
import type { AttentionItem, Stack } from '../../../shared/types'

const stack: Stack = {
  project: 'orcha-quantal-ehr',
  projectShort: 'quantal-ehr',
  apiPort: 8001,
  dbPort: 5435,
  portalStatus: 'Up 4 hours',
  running: true
}
const items: AttentionItem[] = [
  { project: 'orcha-quantal-ehr', projectShort: 'quantal-ehr', kind: 'task_verify', id: 't1', title: 'Verify foundation layer' },
  { project: 'orcha-quantal-ehr', projectShort: 'quantal-ehr', kind: 'request_answer', id: 'r1', title: 'Need a decision' }
]

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([stack]),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    openPortal: vi.fn().mockResolvedValue(undefined),
    listAttention: vi.fn().mockResolvedValue(items),
    openManager: vi.fn().mockResolvedValue(undefined),
    quitApp: vi.fn().mockResolvedValue(undefined)
  }
})

describe('TrayPanel', () => {
  it('shows the attention count and stack rows', async () => {
    render(<TrayPanel />)
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(screen.getByText('NEEDS ATTENTION')).toBeInTheDocument()
    expect(screen.getByText('quantal-ehr')).toBeInTheDocument()
  })

  it('shows ALL CLEAR when nothing needs attention', async () => {
    window.orchaDesktop.listAttention = vi.fn().mockResolvedValue([])
    render(<TrayPanel />)
    expect(await screen.findByText('ALL CLEAR')).toBeInTheDocument()
  })

  it('clicking a stack row opens its portal', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByText('quantal-ehr'))
    expect(window.orchaDesktop.openPortal).toHaveBeenCalledWith('orcha-quantal-ehr')
  })

  it('the gear opens the manager window', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open Orcha' }))
    expect(window.orchaDesktop.openManager).toHaveBeenCalled()
  })

  it('the primary button opens the most-urgent stack portal', async () => {
    render(<TrayPanel />)
    await userEvent.click(await screen.findByRole('button', { name: 'Open portal' }))
    expect(window.orchaDesktop.openPortal).toHaveBeenCalledWith('orcha-quantal-ehr')
  })
})
```

Extend `desktop/src/renderer/src/components/StackCard.test.tsx` — the existing `beforeEach` bridge mock must gain the three new methods (`listAttention: vi.fn().mockResolvedValue([])`, `openManager: vi.fn()`, `quitApp: vi.fn()` — TypeScript will demand them), and add one test:

```tsx
  it('shows an attention badge when the stack has attention items', () => {
    render(<StackCard stack={runningStack} attentionCount={3} onChanged={vi.fn()} />)
    expect(screen.getByText('needs attention · 3')).toBeInTheDocument()
  })
```

Also update `desktop/src/renderer/src/App.test.tsx`'s bridge mocks the same way (add the three methods to each `window.orchaDesktop = {...}`).

- [ ] **Step 5: Run to verify failure** — `cd desktop && npx vitest run src/renderer` → TrayPanel unresolvable; StackCard badge test fails; typecheck of tests flags incomplete mocks.

- [ ] **Step 6: Implement the renderer pieces.**

`desktop/src/renderer/src/tray/TrayPanel.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AttentionItem, Stack } from '../../../shared/types'

const POLL_MS = 5000

export default function TrayPanel() {
  const [stacks, setStacks] = useState<Stack[]>([])
  const [items, setItems] = useState<AttentionItem[]>([])

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        window.orchaDesktop.listStacks(),
        window.orchaDesktop.listAttention()
      ])
      setStacks(s)
      setItems(a)
    } catch {
      setStacks([])
      setItems([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const byProject = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of items) counts.set(i.project, (counts.get(i.project) ?? 0) + 1)
    return counts
  }, [items])

  const runningCount = stacks.filter((s) => s.running).length
  const mostUrgent =
    [...stacks].sort((a, b) => (byProject.get(b.project) ?? 0) - (byProject.get(a.project) ?? 0))[0]

  return (
    <div className="tray-panel">
      <header className="tray-header">
        <span className="tray-title">Orcha</span>
        <span className="tray-chip">
          {runningCount}/{stacks.length} running
        </span>
      </header>

      <div className={`tray-ring ${items.length === 0 ? 'tray-ring-clear' : ''}`}>
        {items.length === 0 ? (
          <span className="tray-ring-label">ALL CLEAR</span>
        ) : (
          <>
            <span className="tray-ring-label">NEEDS ATTENTION</span>
            <span className="tray-ring-count">{items.length}</span>
          </>
        )}
      </div>

      <ul className="tray-stacks">
        {stacks.map((s) => {
          const count = byProject.get(s.project) ?? 0
          return (
            <li key={s.project}>
              <button
                className={`tray-stack-row ${count > 0 ? 'tray-stack-attention' : ''}`}
                disabled={!s.running || s.apiPort === null}
                onClick={() => void window.orchaDesktop.openPortal(s.project)}
              >
                <span className={`tray-dot ${s.running ? 'tray-dot-up' : ''}`} />
                <span className="tray-stack-name">{s.projectShort}</span>
                <span className="tray-stack-meta">
                  {count > 0 ? `${count} pending` : s.running ? 'running' : 'stopped'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <footer className="tray-footer">
        <button
          className="tray-icon-button"
          aria-label="Open Orcha"
          onClick={() => void window.orchaDesktop.openManager()}
        >
          ⚙
        </button>
        <button
          className="tray-primary"
          disabled={!mostUrgent || !mostUrgent.running || mostUrgent.apiPort === null}
          onClick={() => mostUrgent && void window.orchaDesktop.openPortal(mostUrgent.project)}
        >
          Open portal
        </button>
        <button className="tray-icon-button" aria-label="Close" onClick={() => window.close()}>
          ✕
        </button>
      </footer>
    </div>
  )
}
```

`desktop/src/renderer/src/main.tsx` — route on hash (replace the render call):

```tsx
import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import TrayPanel from './tray/TrayPanel'

const isTray = window.location.hash === '#tray'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isTray ? <TrayPanel /> : <App />}</React.StrictMode>
)
```

`desktop/src/renderer/src/App.tsx` — fetch attention alongside stacks and pass counts:
in `refresh`, fetch both (`Promise.all`) into state `attention: AttentionItem[]`; compute `counts` like TrayPanel; pass `attentionCount={counts.get(stack.project) ?? 0}` to each StackCard via StackList (add the prop through `StackList`).

`desktop/src/renderer/src/components/StackCard.tsx` — new optional prop `attentionCount?: number`; render after the pill:

```tsx
        {attentionCount > 0 && (
          <span className="pill pill-attention">needs attention · {attentionCount}</span>
        )}
```

(with `attentionCount = 0` defaulted in the destructure). `StackList` passes it through (`attentionCounts: Map<string, number>` prop or a per-stack number — keep it simple: `attentionCount={attentionCounts.get(stack.project) ?? 0}` with the Map prop).

Append to `desktop/src/renderer/src/styles.css`:

```css
.pill-attention {
  background: #3d2e12;
  color: #f0b94b;
}

.tray-panel {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 0.9rem;
  box-sizing: border-box;
  gap: 0.8rem;
  background: #1d1b18;
  color: #efe9df;
}

.tray-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tray-title {
  font-weight: 700;
}

.tray-chip {
  font-size: 0.72rem;
  border-radius: 999px;
  padding: 0.15rem 0.6rem;
  background: rgba(255, 255, 255, 0.08);
}

.tray-ring {
  width: 150px;
  height: 150px;
  margin: 0.4rem auto;
  border-radius: 50%;
  border: 5px solid #f0b94b;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.2rem;
}

.tray-ring-clear {
  border-color: #42d98a;
}

.tray-ring-label {
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  opacity: 0.75;
}

.tray-ring-count {
  font-size: 2.6rem;
  font-weight: 700;
  line-height: 1;
}

.tray-stacks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  overflow-y: auto;
  flex: 1;
}

.tray-stack-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  border: 0;
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  border-radius: 9px;
  padding: 0.55rem 0.7rem;
  cursor: pointer;
  text-align: left;
}

.tray-stack-row:disabled {
  opacity: 0.5;
  cursor: default;
}

.tray-stack-attention {
  background: rgba(240, 185, 75, 0.14);
  box-shadow: inset 2px 0 0 #f0b94b;
}

.tray-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
}

.tray-dot-up {
  background: #42d98a;
}

.tray-stack-name {
  flex: 1;
  font-weight: 600;
}

.tray-stack-meta {
  font-size: 0.75rem;
  opacity: 0.8;
}

.tray-footer {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.tray-icon-button {
  border: 0;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  border-radius: 8px;
  width: 34px;
  height: 34px;
  cursor: pointer;
}

.tray-primary {
  flex: 1;
  border: 0;
  background: #9db98a;
  color: #1d1b18;
  font-weight: 700;
  border-radius: 999px;
  padding: 0.55rem 1rem;
  cursor: pointer;
}

.tray-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 7: Verify everything**

```bash
cd desktop && npm test && npm run typecheck && npm run build
```

Expected: full suite green (24 prior + 10 attention + 7 poller + 5 TrayPanel + 1 StackCard badge = 47); typecheck + build clean.

- [ ] **Step 8: Commit**

```bash
git add desktop/src
git commit -m "feat(desktop): tray glyph + snapshot popover, system notifications, attention badges

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 11: v1.1 verification gate + PR (supersedes Task 7 Step 4)

- [ ] **Step 1:** `cd desktop && rm -rf out && npm test && npm run typecheck && npm run build` — all green; `git diff main --stat -- docs/orcha.postman_collection.json` — empty.
- [ ] **Step 2:** Launch `npm run dev` (background). Tell the human what to verify: manager window (cards + attention badge), menu-bar glyph (⬡, flips to ⬢ N when something needs attention), left-click popover (snapshot panel: ring count / ALL CLEAR, stack rows, gear → manager, Open portal, ✕), right-click menu (Open Orcha / Quit), closing the manager window leaves the app in the tray, and a system notification fires when a new attention item appears after launch (e.g. mark a task needs_verification via a stack, or stop/start the stack for a health notification — note macOS may ask to allow notifications for Electron).
- [ ] **Step 3: STOP — wait for the human's confirmation.** Then push + PR with the v1+v1.1 body (describe both the stack manager and the tray/notifications; spec + plan links; out-of-scope: packaging/signing gated on #238, deep links, quiet hours, Windows/Linux; note desktop CI deferred; Postman untouched).
- [ ] **Step 4: Report** — PR URL + what was verified.
