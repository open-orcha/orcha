# Onboarding UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse onboarding into a single window with a 4-step stepper and restyle the whole renderer with Tailwind v4 + a local shadcn-style component kit, for a seamless modern feel.

**Architecture:** `App.tsx` becomes a single-window host switching `appMode: 'manager' | 'onboarding'` (decided from `listStacks` before paint). The separate onboarding `BrowserWindow` is deleted; the menu's New Project sends an `orcha:navigate` event. Tailwind v4 (CSS-first, `@tailwindcss/vite`) + a vendored `ui/` kit style every surface. The provision engine, preflight, folderModes, templates, and IPC handler bodies are UNCHANGED.

**Tech Stack:** Electron 42, React 19, TypeScript 6, electron-vite, Vitest 4, Tailwind CSS v4, `@tailwindcss/vite`, `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, `@radix-ui/react-progress`, `@radix-ui/react-slot`.

**Working dir:** `/Users/husseinmohamed/Desktop/quantal-projects/orcha-open/desktop`, branch `feat/desktop-onboarding`. Paths below are relative to `desktop/`. Run commands from `desktop/`.

**Spec:** `docs/superpowers/specs/2026-06-18-onboarding-ux-redesign-design.md`.

---

## File structure

**Created:**
- `src/renderer/src/ui/cn.ts` — class merge helper.
- `src/renderer/src/ui/Button.tsx`, `Card.tsx`, `Input.tsx`, `Label.tsx`, `Badge.tsx`, `Progress.tsx`, `Stepper.tsx` — the kit.
- `src/renderer/src/onboarding/OnboardingWizard.tsx` — 4-step state machine (replaces OnboardingApp).
- `src/renderer/src/onboarding/steps/PreflightStep.tsx`, `FolderStep.tsx`, `DetailsStep.tsx`, `ProvisionStep.tsx`.
- `src/renderer/src/components/ManagerView.tsx` — extracted manager body.
- Test files alongside new components.

**Modified:**
- `package.json` — add deps.
- `electron.vite.config.ts` — add `tailwindcss()` to renderer plugins.
- `src/renderer/src/styles.css` — Tailwind v4 entry + `@theme`.
- `src/renderer/src/App.tsx` — single-window host with `appMode`.
- `src/renderer/src/main.tsx` — drop `#onboarding` route.
- `src/renderer/src/components/{StackCard,StackRow,EmptyState,DockerDownBanner,ViewToggle}.tsx` — restyle with kit.
- `src/renderer/src/tray/TrayPanel.tsx` — restyle.
- `src/main/index.ts` — remove onboarding window; send `orcha:navigate`; target manager webContents for progress.
- `src/main/appMenu.ts` — New Project hook calls navigate.
- `src/preload/index.ts` — add `onNavigate`; drop `openOnboarding`.
- `src/shared/types.ts` — `OrchaDesktopApi`: drop `openOnboarding`, add `onNavigate`.
- Renderer test stubs — drop `openOnboarding`, add `onNavigate`.

**Deleted:**
- `src/main/onboardingWindow.ts` (+ its test references).
- `src/renderer/src/onboarding/OnboardingApp.tsx` + `OnboardingApp.test.tsx` (replaced by OnboardingWizard).

**Parallelization:** Tasks 1–2 (deps+Tailwind, then UI kit) are the foundation — do FIRST, sequentially. Then Tasks 3 (manager restyle), 4 (onboarding wizard), 5 (tray restyle) are independent → parallel agents. Task 6 (App host + IPC rewire) integrates after. Task 7 (test stubs + cleanup) last.

---

## Task 1: Tailwind v4 + deps + theme

**Files:**
- Modify: `package.json`, `electron.vite.config.ts`, `src/renderer/src/styles.css`

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install tailwindcss@^4 @tailwindcss/vite clsx tailwind-merge class-variance-authority lucide-react @radix-ui/react-progress @radix-ui/react-slot
```
Expected: installs without peer-dep errors (React 19 compatible).

- [ ] **Step 2: Wire the Tailwind Vite plugin**

Edit `electron.vite.config.ts` to:
```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react(), tailwindcss()] }
})
```

- [ ] **Step 3: Replace styles.css with Tailwind v4 entry + theme**

Overwrite `src/renderer/src/styles.css`:
```css
@import 'tailwindcss';

@theme {
  --color-bg: #141311;
  --color-card: #1d1b18;
  --color-text: #efe9df;
  --color-border: #3a352e;
  --color-accent: #f0b94b;
  --color-ok: #42d98a;
  --color-danger: #d9544f;
  --duration-base: 180ms;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Seamless cross-fade / slide primitives (no motion lib) */
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-in-right {
  from { opacity: 0; transform: translateX(16px); }
  to { opacity: 1; transform: translateX(0); }
}
.animate-fade-in { animation: fade-in var(--duration-base) ease-out; }
.animate-slide-in { animation: slide-in-right var(--duration-base) ease-out; }
```

- [ ] **Step 4: Verify build still works**

Run: `npm run build`
Expected: builds; renderer CSS chunk now produced by Tailwind. No errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json electron.vite.config.ts src/renderer/src/styles.css
git commit -m "build(desktop): add Tailwind v4 + UI deps + theme tokens"
```

---

## Task 2: UI kit (`src/renderer/src/ui/`)

**Files:**
- Create: `src/renderer/src/ui/cn.ts`, `Button.tsx`, `Card.tsx`, `Input.tsx`, `Label.tsx`, `Badge.tsx`, `Progress.tsx`, `Stepper.tsx`
- Test: `src/renderer/src/ui/Stepper.test.tsx`, `src/renderer/src/ui/Button.test.tsx`

- [ ] **Step 1: Create `cn.ts`**

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 2: Create `Button.tsx`**

```tsx
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors duration-[var(--duration-base)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'bg-accent text-bg hover:bg-accent/90',
        outline: 'border border-border bg-transparent hover:bg-card',
        ghost: 'bg-transparent hover:bg-card',
        destructive: 'bg-danger text-white hover:bg-danger/90'
      },
      size: { default: 'h-10 px-4', sm: 'h-8 px-3', lg: 'h-11 px-6 text-base' }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  }
)
Button.displayName = 'Button'
```

- [ ] **Step 3: Create `Card.tsx`, `Input.tsx`, `Label.tsx`, `Badge.tsx`**

`Card.tsx`:
```tsx
import { type HTMLAttributes } from 'react'
import { cn } from './cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-card p-4', className)} {...props} />
}
```

`Input.tsx`:
```tsx
import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from './cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text placeholder:text-text/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        className
      )}
      {...props}
    />
  )
)
Input.displayName = 'Input'
```

`Label.tsx`:
```tsx
import { type LabelHTMLAttributes } from 'react'
import { cn } from './cn'

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-xs font-medium text-text/70', className)} {...props} />
}
```

`Badge.tsx`:
```tsx
import { type HTMLAttributes } from 'react'
import { cn } from './cn'

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent',
        className
      )}
      {...props}
    />
  )
}
```

- [ ] **Step 4: Create `Progress.tsx`**

```tsx
import * as ProgressPrimitive from '@radix-ui/react-progress'
import { cn } from './cn'

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <ProgressPrimitive.Root
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-card', className)}
      value={value}
    >
      <ProgressPrimitive.Indicator
        className="h-full bg-accent transition-transform duration-[var(--duration-base)]"
        style={{ transform: `translateX(-${100 - value}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}
```

- [ ] **Step 5: Write the failing Stepper test**

`src/renderer/src/ui/Stepper.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Stepper } from './Stepper'

const steps = ['Docker', 'Folder', 'Details', 'Create']

describe('Stepper', () => {
  it('marks the current step with aria-current and counts done steps', () => {
    render(<Stepper steps={steps} current={2} />)
    // step indices 0..3; current=2 => steps 0,1 done, 2 current, 3 upcoming
    const current = screen.getByText('Details').closest('[data-state]')
    expect(current?.getAttribute('data-state')).toBe('current')
    expect(current?.getAttribute('aria-current')).toBe('step')
    const done = screen.getByText('Docker').closest('[data-state]')
    expect(done?.getAttribute('data-state')).toBe('done')
    const upcoming = screen.getByText('Create').closest('[data-state]')
    expect(upcoming?.getAttribute('data-state')).toBe('upcoming')
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- src/renderer/src/ui/Stepper.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Create `Stepper.tsx`**

```tsx
import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { cn } from './cn'

export interface StepperProps {
  steps: string[]
  /** zero-based index of the active step */
  current: number
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'upcoming'
        return (
          <Fragment key={label}>
            <li
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex items-center gap-2"
            >
              <span
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-[var(--duration-base)]',
                  state === 'done' && 'border-accent bg-accent text-bg',
                  state === 'current' && 'border-accent text-accent',
                  state === 'upcoming' && 'border-border text-text/40'
                )}
              >
                {state === 'done' ? <Check className="h-4 w-4" /> : i + 1}
              </span>
              <span
                className={cn(
                  'text-sm',
                  state === 'current' ? 'text-text' : 'text-text/50'
                )}
              >
                {label}
              </span>
            </li>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  'h-px flex-1 transition-colors duration-[var(--duration-base)]',
                  i < current ? 'bg-accent' : 'bg-border'
                )}
              />
            )}
          </Fragment>
        )
      })}
    </ol>
  )
}
```

- [ ] **Step 8: Run Stepper test to verify it passes**

Run: `npm test -- src/renderer/src/ui/Stepper.test.tsx`
Expected: PASS.

- [ ] **Step 9: Write + pass a Button smoke test**

`src/renderer/src/ui/Button.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button'

describe('Button', () => {
  it('renders and fires onClick', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Go</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
  it('is disabled when disabled prop set', () => {
    render(<Button disabled>Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled()
  })
})
```

Run: `npm test -- src/renderer/src/ui/Button.test.tsx`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/ui
git commit -m "feat(desktop): local shadcn-style UI kit (Button/Card/Input/Stepper/Progress/...)"
```

---

## Task 3: Restyle the manager surfaces

**Files:**
- Create: `src/renderer/src/components/ManagerView.tsx`
- Modify: `src/renderer/src/components/{StackCard,StackRow,EmptyState,DockerDownBanner,ViewToggle}.tsx`
- Modify: existing tests only if a query breaks.

Goal: extract the manager body out of `App.tsx` into `ManagerView` and restyle every manager component with the kit. Behavior/props unchanged. `EmptyState` gains an `onCreate` prop (the button now triggers a mode switch in App, not an IPC call).

- [ ] **Step 1: Create `ManagerView.tsx`** (the current App body, restyled)

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { AttentionItem, Stack } from '../../../shared/types'
import StackList from './StackList'
import DockerDownBanner from './DockerDownBanner'
import EmptyState from './EmptyState'
import ViewToggle, { type ViewMode } from './ViewToggle'

const POLL_MS = 5000
const VIEW_MODE_KEY = 'orcha.viewMode'

type ViewState =
  | { kind: 'loading' }
  | { kind: 'dockerDown' }
  | { kind: 'ready'; stacks: Stack[]; attention: AttentionItem[] }

function countsByProject(items: AttentionItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.project, (counts.get(item.project) ?? 0) + 1)
  return counts
}

function loadViewMode(): ViewMode {
  return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'cards'
}

export default function ManagerView({ onCreate }: { onCreate: () => void }) {
  const [view, setView] = useState<ViewState>({ kind: 'loading' })
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode)

  const changeViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    localStorage.setItem(VIEW_MODE_KEY, mode)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [stacks, attention] = await Promise.all([
        window.orchaDesktop.listStacks(),
        window.orchaDesktop.listAttention().catch((): AttentionItem[] => [])
      ])
      setView({ kind: 'ready', stacks, attention })
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
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-6 animate-fade-in">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Orcha stacks</h1>
        <ViewToggle view={viewMode} onChange={changeViewMode} />
      </header>
      {view.kind === 'loading' && (
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-text/60">Loading…</div>
      )}
      {view.kind === 'dockerDown' && <DockerDownBanner />}
      {view.kind === 'ready' &&
        (view.stacks.length === 0 ? (
          <EmptyState onCreate={onCreate} />
        ) : (
          <StackList
            stacks={view.stacks}
            attentionCounts={countsByProject(view.attention)}
            view={viewMode}
            onChanged={() => void refresh()}
          />
        ))}
    </main>
  )
}
```

- [ ] **Step 2: Restyle `EmptyState.tsx`** (add `onCreate` prop)

```tsx
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

export default function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="flex flex-col items-start gap-3 border-dashed">
      <p className="text-sm text-text/70">No orcha stacks yet.</p>
      <Button onClick={onCreate}>Create your first project</Button>
    </Card>
  )
}
```

- [ ] **Step 3: Restyle `DockerDownBanner.tsx`**

```tsx
import { Card } from '../ui/Card'

export default function DockerDownBanner() {
  return (
    <Card className="border-danger/40 text-sm text-danger">
      Docker isn’t running. Start Docker Desktop, then this list will populate automatically.
    </Card>
  )
}
```

- [ ] **Step 4: Restyle `ViewToggle.tsx`** (keep its props + aria-pressed)

```tsx
import { cn } from '../ui/cn'

export type ViewMode = 'cards' | 'list'

export default function ViewToggle({
  view,
  onChange
}: {
  view: ViewMode
  onChange: (mode: ViewMode) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5">
      {(['cards', 'list'] as const).map((mode) => (
        <button
          key={mode}
          aria-pressed={view === mode}
          onClick={() => onChange(mode)}
          className={cn(
            'rounded-md px-3 py-1 text-sm capitalize transition-colors duration-[var(--duration-base)]',
            view === mode ? 'bg-card text-text' : 'text-text/50 hover:text-text'
          )}
        >
          {mode}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Restyle `StackCard.tsx` and `StackRow.tsx`** using the kit

For `StackCard.tsx`, wrap content in `<Card>` and use `<Button>` for actions; keep the `useStackActions` hook and all text/labels so existing tests pass. Replace the outer element and action buttons:
```tsx
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import useStackActions from './useStackActions'
import type { Stack } from '../../../shared/types'

export default function StackCard({
  stack,
  attention,
  onChanged
}: {
  stack: Stack
  attention: number
  onChanged: () => void
}) {
  const a = useStackActions(stack, onChanged)
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-medium">{stack.projectShort}</span>
        {attention > 0 && <Badge>{attention}</Badge>}
      </div>
      <span className="text-xs text-text/50">{stack.portalStatus}</span>
      {a.error && <span className="text-xs text-danger">{a.error}</span>}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={a.busy} onClick={a.toggleStack}>
          {a.toggleLabel}
        </Button>
        <Button size="sm" disabled={a.portalDisabled} onClick={a.openPortal}>
          Open portal
        </Button>
      </div>
    </Card>
  )
}
```
Apply the same kit treatment to `StackRow.tsx` (compact row: flex container, same labels/buttons). Keep every text label the existing tests assert on (`Open portal`, `Start`/`Stop`, `Stopping…`/`Starting…`).

- [ ] **Step 6: Run the manager component tests**

Run: `npm test -- src/renderer/src/components`
Expected: PASS. If a test queried a removed class or wrapper, update the query to a role/text query (do not change asserted behavior). Note: `EmptyState.test.tsx` now must pass an `onCreate` — update its render to `render(<EmptyState onCreate={vi.fn()} />)` and assert the button calls that prop (not `window.orchaDesktop.openOnboarding`).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components
git commit -m "feat(desktop): restyle manager surfaces with the UI kit + extract ManagerView"
```

---

## Task 4: Onboarding wizard (single-window stepper)

**Files:**
- Create: `src/renderer/src/onboarding/OnboardingWizard.tsx`, `steps/PreflightStep.tsx`, `steps/FolderStep.tsx`, `steps/DetailsStep.tsx`, `steps/ProvisionStep.tsx`
- Create test: `src/renderer/src/onboarding/OnboardingWizard.test.tsx`
- Keep: `useProvisionStream.ts` (unchanged)
- Delete (in Task 7): `OnboardingApp.tsx`, `OnboardingApp.test.tsx`

- [ ] **Step 1: Write the failing wizard test**

`src/renderer/src/onboarding/OnboardingWizard.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnboardingWizard from './OnboardingWizard'

beforeEach(() => {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue([]),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    openPortal: vi.fn(),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn(),
    quitApp: vi.fn(),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    pickFolder: vi.fn().mockResolvedValue({ folder: '/tmp/demo', mode: 'existing' }),
    inspectFolder: vi.fn().mockResolvedValue({ initialized: false, writable: true, suggestedName: 'demo' }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-demo', apiPort: 8001, warnings: [] }),
    openOnboardingPortal: vi.fn().mockResolvedValue(undefined),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {})
  }
})

describe('OnboardingWizard', () => {
  it('walks the 4 steps and hands off to the portal, then calls onDone', async () => {
    const onDone = vi.fn()
    const user = userEvent.setup()
    render(<OnboardingWizard onDone={onDone} />)

    // Step 1: Docker preflight ok → Continue
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /continue/i }))

    // Step 2: choose folder
    await user.click(screen.getByRole('button', { name: /choose folder/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /next/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /next/i }))

    // Step 3: details (name prefilled) → Create
    await waitFor(() => expect(screen.getByDisplayValue('demo')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /create project/i }))

    expect(window.orchaDesktop.provision).toHaveBeenCalledWith(
      expect.objectContaining({ folder: '/tmp/demo', mode: 'init', name: 'demo' })
    )
    // Step 4: success → portal handoff + onDone
    await waitFor(() => expect(window.orchaDesktop.openOnboardingPortal).toHaveBeenCalledWith('orcha-demo'))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('ignores progress events from a stale run id', async () => {
    let cb: ((e: { runId: string; step: string; status: string; line?: string }) => void) | null = null
    ;(window.orchaDesktop.onProvisionProgress as ReturnType<typeof vi.fn>).mockImplementation((f) => {
      cb = f
      return () => {}
    })
    render(<OnboardingWizard onDone={vi.fn()} />)
    await waitFor(() => expect(window.orchaDesktop.onProvisionProgress).toHaveBeenCalled())
    cb?.({ runId: 'stale', step: 'compose-up', status: 'log', line: 'noise' })
    expect(screen.queryByText(/noise/)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/renderer/src/onboarding/OnboardingWizard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the step components**

`steps/PreflightStep.tsx`:
```tsx
import { useEffect, useState } from 'react'
import type { PreflightReport } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'

export default function PreflightStep({ onContinue }: { onContinue: () => void }) {
  const [report, setReport] = useState<PreflightReport | null>(null)
  const check = (): void => void window.orchaDesktop.preflight().then(setReport)
  useEffect(() => check(), [])
  const ok = report?.docker === 'ok'
  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">Check Docker</h2>
      <Card className="text-sm">
        {report === null ? 'Checking Docker…' : ok ? 'Docker is ready.' : report.hint}
      </Card>
      <div className="flex gap-2">
        {report && !ok && (
          <Button variant="outline" onClick={check}>
            Re-check
          </Button>
        )}
        <Button disabled={!ok} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
```

`steps/FolderStep.tsx`:
```tsx
import { useState } from 'react'
import type { FolderChoice, FolderState } from '../../../../shared/types'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'

export default function FolderStep({
  onBack,
  onNext
}: {
  onBack: () => void
  onNext: (choice: FolderChoice, state: FolderState) => void
}) {
  const [choice, setChoice] = useState<FolderChoice | null>(null)
  const [state, setState] = useState<FolderState | null>(null)

  async function choose() {
    const c = await window.orchaDesktop.pickFolder('existing')
    if (!c) return
    setChoice(c)
    setState(await window.orchaDesktop.inspectFolder(c.folder))
  }

  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">Choose a project folder</h2>
      <Button variant="outline" onClick={() => void choose()}>
        Choose folder…
      </Button>
      {choice && (
        <Card className="text-sm">
          <div className="font-mono text-xs text-text/70">{choice.folder}</div>
          {state?.initialized && (
            <div className="mt-2 text-danger">
              This folder already has an Orcha project — it will be reconnected, not overwritten.
            </div>
          )}
        </Card>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button disabled={!choice || !state} onClick={() => choice && state && onNext(choice, state)}>
          Next
        </Button>
      </div>
    </div>
  )
}
```

`steps/DetailsStep.tsx`:
```tsx
import { useState } from 'react'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Label } from '../../ui/Label'

export default function DetailsStep({
  suggestedName,
  onBack,
  onCreate
}: {
  suggestedName: string
  onBack: () => void
  onCreate: (name: string, objective: string) => void
}) {
  const [name, setName] = useState(suggestedName)
  const [objective, setObjective] = useState('')
  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">Project details</h2>
      <div className="flex flex-col gap-1">
        <Label htmlFor="proj-name">Project name</Label>
        <Input id="proj-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="proj-obj">Objective (optional)</Label>
        <Input id="proj-obj" value={objective} onChange={(e) => setObjective(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button disabled={!name.trim()} onClick={() => onCreate(name.trim(), objective.trim())}>
          Create project
        </Button>
      </div>
    </div>
  )
}
```

`steps/ProvisionStep.tsx`:
```tsx
import type { ProgressEvent } from '../../../../shared/types'
import { Card } from '../../ui/Card'
import { Check, Loader2, X } from 'lucide-react'

const STEP_LABELS: Record<string, string> = {
  'render-compose': 'Render compose file',
  'copy-templates': 'Copy templates',
  'compose-up': 'Start containers',
  'wait-portal': 'Wait for portal',
  'create-container': 'Create container',
  'register-human': 'Register you',
  'start-daemons': 'Start daemons'
}

export default function ProvisionStep({
  events,
  done,
  error
}: {
  events: ProgressEvent[]
  done: boolean
  error: string | null
}) {
  // Latest status per step.
  const status = new Map<string, string>()
  const logs: string[] = []
  for (const e of events) {
    if (e.status === 'log' && 'line' in e) logs.push(e.line)
    else status.set(e.step, e.status)
  }
  return (
    <div className="flex flex-col gap-4 animate-slide-in">
      <h2 className="text-lg font-semibold">{done ? 'Project ready' : 'Creating your project…'}</h2>
      <Card className="flex flex-col gap-2">
        {Object.entries(STEP_LABELS).map(([step, label]) => {
          const s = status.get(step)
          return (
            <div key={step} className="flex items-center gap-2 text-sm">
              {s === 'ok' ? (
                <Check className="h-4 w-4 text-ok" />
              ) : s === 'fail' ? (
                <X className="h-4 w-4 text-danger" />
              ) : s === 'start' ? (
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
              ) : (
                <span className="h-4 w-4 rounded-full border border-border" />
              )}
              <span className={s === 'skip' ? 'text-text/40' : 'text-text/80'}>{label}</span>
            </div>
          )
        })}
      </Card>
      {error && <Card className="border-danger/40 text-sm text-danger">{error}</Card>}
      {logs.length > 0 && (
        <details className="text-xs text-text/50">
          <summary className="cursor-pointer">Build log</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono">
            {logs.slice(-200).join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Create `OnboardingWizard.tsx`**

```tsx
import { useState } from 'react'
import type { BridgeError, FolderChoice } from '../../../shared/types'
import { Stepper } from '../ui/Stepper'
import { useProvisionStream } from './useProvisionStream'
import PreflightStep from './steps/PreflightStep'
import FolderStep from './steps/FolderStep'
import DetailsStep from './steps/DetailsStep'
import ProvisionStep from './steps/ProvisionStep'

const STEPS = ['Docker', 'Folder', 'Details', 'Create']

export default function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [choice, setChoice] = useState<FolderChoice | null>(null)
  const [suggestedName, setSuggestedName] = useState('')
  const [provisioning, setProvisioning] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { events } = useProvisionStream(null)

  async function create(name: string, objective: string) {
    if (!choice) return
    setStep(3)
    setProvisioning(true)
    setError(null)
    try {
      const res = await window.orchaDesktop.provision({ folder: choice.folder, mode: 'init', name, objective })
      setDone(true)
      await window.orchaDesktop.openOnboardingPortal(res.project)
      onDone()
    } catch (err) {
      const be = err as BridgeError
      setError('stderr' in be ? be.stderr : be.code)
    } finally {
      setProvisioning(false)
    }
  }

  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col gap-6 p-8 animate-fade-in">
      <h1 className="text-xl font-semibold">Set up Orcha</h1>
      <Stepper steps={STEPS} current={step} />
      <div className="flex-1">
        {step === 0 && <PreflightStep onContinue={() => setStep(1)} />}
        {step === 1 && (
          <FolderStep
            onBack={() => setStep(0)}
            onNext={(c, s) => {
              setChoice(c)
              setSuggestedName(s.suggestedName)
              setStep(2)
            }}
          />
        )}
        {step === 2 && (
          <DetailsStep suggestedName={suggestedName} onBack={() => setStep(1)} onCreate={create} />
        )}
        {step === 3 && <ProvisionStep events={events} done={done && !provisioning} error={error} />}
      </div>
    </main>
  )
}
```

- [ ] **Step 5: Run the wizard test**

Run: `npm test -- src/renderer/src/onboarding/OnboardingWizard.test.tsx`
Expected: PASS (both cases). If the stale-run test fails, confirm `useProvisionStream` drops events whose runId differs from the first seen (it should already).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/onboarding/OnboardingWizard.tsx src/renderer/src/onboarding/steps src/renderer/src/onboarding/OnboardingWizard.test.tsx
git commit -m "feat(desktop): single-window 4-step onboarding wizard with animated progress"
```

---

## Task 5: Restyle the tray popover

**Files:**
- Modify: `src/renderer/src/tray/TrayPanel.tsx`
- Modify: `TrayPanel.test.tsx` only if a query breaks.

- [ ] **Step 1: Restyle `TrayPanel.tsx`** using the kit + Tailwind, preserving all text labels and the data flow (the 5s poll, grouping, footer buttons). Replace the hand-CSS class names with Tailwind utilities and use `<Button>`/`<Badge>` where the existing UI had buttons/counts. Keep every accessible name the test asserts (e.g. "Open portal", the gear/settings control, the close control). Do not change behavior.

- [ ] **Step 2: Run the tray test**

Run: `npm test -- src/renderer/src/tray/TrayPanel.test.tsx`
Expected: PASS. Update any query that referenced a removed class to a role/text query (no behavior change).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/tray/TrayPanel.tsx
git commit -m "feat(desktop): restyle tray popover with the UI kit"
```

---

## Task 6: App host (single window) + main-process rewire

**Files:**
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/main.tsx`
- Modify: `src/shared/types.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/main/appMenu.ts`
- Delete: `src/main/onboardingWindow.ts`

- [ ] **Step 1: Update `OrchaDesktopApi` in `shared/types.ts`**

In the `OrchaDesktopApi` interface: remove `openOnboarding(): Promise<void>` and add:
```ts
  /** Subscribe to main→renderer navigation requests (e.g. File→New Project). */
  onNavigate(cb: (target: 'onboarding' | 'manager') => void): () => void
```
(Keep `openOnboardingPortal`, `preflight`, `pickFolder`, `inspectFolder`, `provision`, `onProvisionProgress`.)

- [ ] **Step 2: Update preload `src/preload/index.ts`**

Remove the `openOnboarding` line; add:
```ts
  onNavigate: (cb) => {
    const listener = (_e: IpcRendererEvent, target: 'onboarding' | 'manager'): void => cb(target)
    ipcRenderer.on('orcha:navigate', listener)
    return () => ipcRenderer.removeListener('orcha:navigate', listener)
  }
```

- [ ] **Step 3: Rewrite `App.tsx` as the single-window host**

```tsx
import { useEffect, useState } from 'react'
import ManagerView from './components/ManagerView'
import OnboardingWizard from './onboarding/OnboardingWizard'

type AppMode = 'loading' | 'manager' | 'onboarding'

export default function App() {
  const [mode, setMode] = useState<AppMode>('loading')

  // Decide the initial mode before showing the manager: zero stacks → onboarding.
  useEffect(() => {
    let cancelled = false
    void window.orchaDesktop
      .listStacks()
      .then((stacks) => {
        if (!cancelled) setMode(stacks.length === 0 ? 'onboarding' : 'manager')
      })
      .catch(() => {
        if (!cancelled) setMode('manager') // Docker down → manager shows its banner
      })
    return () => {
      cancelled = true
    }
  }, [])

  // File→New Project (main) asks us to switch.
  useEffect(() => window.orchaDesktop.onNavigate((target) => setMode(target)), [])

  if (mode === 'loading') return <div className="h-full animate-fade-in" />
  if (mode === 'onboarding') return <OnboardingWizard onDone={() => setMode('manager')} />
  return <ManagerView onCreate={() => setMode('onboarding')} />
}
```

- [ ] **Step 4: Update `main.tsx`** — drop the `#onboarding` route

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

- [ ] **Step 5: Rewire `src/main/index.ts`**

- Delete the import of `showOnboardingWindow, onboardingWebContents` from `./onboardingWindow` and the `import ... appMenu` stays.
- Add a helper to send to the manager window:
```ts
function sendToManager(channel: string, payload: unknown): void {
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send(channel, payload)
}
```
- In the `provision` handler, replace `onboardingWebContents()?.send('orcha:provision:progress', e)` with `sendToManager('orcha:provision:progress', e)`.
- Remove the `ipcMain.handle('orcha:openOnboarding', ...)` block.
- Change the app-menu wiring to navigate the manager window:
```ts
Menu.setApplicationMenu(
  Menu.buildFromTemplate(
    buildAppMenuTemplate({
      onNewProject: () => {
        showManagerWindow()
        sendToManager('orcha:navigate', 'onboarding')
      }
    })
  )
)
```
- Remove the first-launch `showOnboardingWindow()` block entirely (the renderer now decides initial mode). Keep `createManagerWindow()`.

- [ ] **Step 6: Delete `onboardingWindow.ts`**

Run: `git rm src/main/onboardingWindow.ts`

- [ ] **Step 7: Typecheck + targeted tests**

Run: `npm run typecheck`
Expected: clean EXCEPT for renderer test stubs still referencing `openOnboarding` — those are fixed in Task 7. If `appMenu.ts` references types that changed, update it (its `AppMenuHooks.onNewProject` is still `() => void`, so no change needed).

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/preload/index.ts src/renderer/src/App.tsx src/renderer/src/main.tsx src/main/index.ts
git rm src/main/onboardingWindow.ts
git commit -m "feat(desktop): single-window app host + remove onboarding window; navigate via IPC"
```

---

## Task 7: Tests, cleanup, and full green

**Files:**
- Modify: `src/renderer/src/App.test.tsx`, `StackCard.test.tsx`, `StackRow.test.tsx`, `TrayPanel.test.tsx`
- Delete: `src/renderer/src/onboarding/OnboardingApp.tsx`, `OnboardingApp.test.tsx`

- [ ] **Step 1: Delete the old OnboardingApp**

Run:
```bash
git rm src/renderer/src/onboarding/OnboardingApp.tsx src/renderer/src/onboarding/OnboardingApp.test.tsx
```

- [ ] **Step 2: Update every `window.orchaDesktop` stub**

In `App.test.tsx`, `StackCard.test.tsx`, `StackRow.test.tsx`, `TrayPanel.test.tsx`: in each stub object, **remove** `openOnboarding: ...` and **add**:
```ts
    onNavigate: vi.fn().mockReturnValue(() => {})
```
(Keep `openOnboardingPortal`, `preflight`, `pickFolder`, `inspectFolder`, `provision`, `onProvisionProgress`.)

- [ ] **Step 3: Rewrite `App.test.tsx` for appMode switching**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import App from './App'

function stub(stacks: unknown[]) {
  window.orchaDesktop = {
    listStacks: vi.fn().mockResolvedValue(stacks),
    startStack: vi.fn(),
    stopStack: vi.fn(),
    openPortal: vi.fn(),
    listAttention: vi.fn().mockResolvedValue([]),
    openManager: vi.fn(),
    quitApp: vi.fn(),
    preflight: vi.fn().mockResolvedValue({ docker: 'ok', autoStarted: false, hint: null }),
    pickFolder: vi.fn().mockResolvedValue(null),
    inspectFolder: vi.fn().mockResolvedValue({ initialized: false, writable: true, suggestedName: 'x' }),
    provision: vi.fn().mockResolvedValue({ project: 'orcha-x', apiPort: 8000, warnings: [] }),
    openOnboardingPortal: vi.fn(),
    onProvisionProgress: vi.fn().mockReturnValue(() => {}),
    onNavigate: vi.fn().mockReturnValue(() => {})
  } as never
}

describe('App single-window host', () => {
  beforeEach(() => vi.useRealTimers())

  it('starts in onboarding mode when there are no stacks', async () => {
    stub([])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/set up orcha/i)).toBeInTheDocument())
  })

  it('starts in manager mode when stacks exist', async () => {
    stub([
      { project: 'orcha-x', projectShort: 'x', apiPort: 8000, dbPort: 5432, portalStatus: 'Up', running: true }
    ])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/orcha stacks/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 4: Full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green. Fix any remaining selector drift in component tests (role/text queries only; never weaken an assertion).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.test.tsx src/renderer/src/components/StackCard.test.tsx src/renderer/src/components/StackRow.test.tsx src/renderer/src/tray/TrayPanel.test.tsx
git rm src/renderer/src/onboarding/OnboardingApp.tsx src/renderer/src/onboarding/OnboardingApp.test.tsx
git commit -m "test(desktop): update stubs + App mode tests; remove old OnboardingApp"
```

---

## Task 8: Rebuild DMG and verify one window

- [ ] **Step 1: Build a fresh local DMG**

Run:
```bash
npm run build && npx electron-builder --mac --arm64 --config electron-builder.local.yml
```
Expected: `dist-local/Orcha-1.0.2-arm64.dmg` rebuilt.

- [ ] **Step 2: Manual smoke (documented — user-run)**

Open the DMG, launch the app. Verify: exactly ONE window; with zero stacks it shows the stepper directly (no second window); File→New Project (Cmd+N) switches the window to the stepper; full provision streams the animated checklist and hands off to the portal. (This requires the GUI session + Docker; it's a manual check.)

- [ ] **Step 3: Commit any doc note**

If `desktop/README.md`'s onboarding section references the old two-window behavior, update it to "single window, stepper". Commit:
```bash
git add desktop/README.md
git commit -m "docs(desktop): onboarding is a single-window stepper"
```

---

## Self-review notes (addressed)

- **Spec coverage:** single window (T6 App host + onboardingWindow deletion), Tailwind v4 (T1), UI kit (T2), 4-step stepper (T4), whole-renderer restyle (T2/T3/T5), seamless animations (T1 keyframes + per-step `animate-slide-in`/`animate-fade-in`), navigate-via-IPC (T6), progress to manager window (T6), tests (every task) + build (T1/T7/T8). Reconnect "don't clobber" note → FolderStep (T4).
- **Type consistency:** `OrchaDesktopApi` drops `openOnboarding`, adds `onNavigate` (T6); every stub updated (T7); `EmptyState` gains `onCreate` (T3) consumed by `ManagerView` (T3) and App (T6). `OnboardingWizard` props `{onDone}` consistent across T4/T6.
- **Known follow-ups:** StackRow/StackCard/TrayPanel restyles keep all asserted text labels so existing tests survive with at most selector tweaks; if a test asserted a CSS class it must move to a role/text query (called out in each task).
```
