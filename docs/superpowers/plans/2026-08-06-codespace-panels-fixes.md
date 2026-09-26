# Code Space Panel Improvements + Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four Code Space improvements in `src/cloud/codespace/**`: resizable three-pane layout, chat-feel message animation, a fix for the stale-file-content race that breaks gutter/thread triggering after switching files, and closing gaps in the header symbol-search popover's lifecycle (close on file-change/scroll/click-away/Escape).

**Architecture:** Each item is additive and isolated to its own file(s) — a new `usePaneWidths` hook + CSS for resize, a small CSS-keyframe + mount-class change for animation, a one-line render-guard fix plus a `useEffect` reset in `CodeSpacePage.tsx`/`ThreadRail.tsx` for the stale-content bug, and a `path`-aware close effect + a `getBoundingClientRect`-based safety re-anchor in `SymbolSearch.tsx` for the popover. No shared state between the four; they can be implemented and tested in any order, but bug fixes (Tasks 3-4) are lower risk to land first since they're pure bugfixes with tight regression tests.

**Tech Stack:** React 18 + TypeScript, Vitest + @testing-library/react (no `user-event`, use `fireEvent`), plain CSS (token-driven, `var(--surface-2)` etc.), no new dependencies — resize uses native Pointer Events.

**Root causes established via live interactive repro (see conversation record) and static analysis, going into this plan:**
- **Bug 3**: `CodeSpacePage.tsx`'s content-pane render guard is `fileLoading && !filePayload ? <Skeleton/> : ... filePayload ? <ContentPaneChrome payload={filePayload}>`. This only blocks stale content on the very FIRST load — once any `filePayload` exists, switching files sets `fileLoading=true` but `filePayload` still holds the PREVIOUS file's data until the fetch resolves, so the OLD file's lines/gutter render under the NEW file's `path`/breadcrumb for one render window. A gutter click in that window opens the composer anchored to the wrong path/line. Confirmed live against a real running container (`postgres/init_test.sql` → `postgres/postgres.conf`): breadcrumb and tree both moved to the new file while the code body still showed the old file's content for one paint. Separately, `ThreadRail.tsx`'s local `showRecent` state has no `useEffect` resetting it on `path` change, so it can strand the rail on "Recent threads (all files)" after a file switch instead of returning to the new file's own per-file list — this matches the user's screenshot exactly.
- **Bug 4**: Live repro across landing state, file-open state, and sidebar-collapsed full-bleed state all showed CORRECT positioning (`.cs-symsearch { position: relative }` is unconditional in `codespace.css`, no competing rule found). The one real, confirmed gap: `SymbolSearch.tsx`'s `open` state has no reset on `path` (file) change, and no scroll-close handler — so the panel can be left open with stale/wrong-context results across a file switch. Fix closes that gap and additionally hardens positioning defensively (explicit anchor-rect fallback) since the "detached" symptom couldn't be fully ruled out under live GitHub-rate-limit conditions that blocked the identifier-click-triggered path specifically.

---

## File Structure

- Create: `src/cloud/codespace/usePaneWidths.ts` — pure-ish hook: pointer-drag state, localStorage persistence, default/min-width constants. No JSX.
- Create: `src/cloud/codespace/usePaneWidths.test.ts` — unit tests for the hook in isolation (jsdom, no DOM measurement needed since the hook only manages numbers + localStorage).
- Modify: `src/cloud/codespace/CodeSpacePage.tsx` — wire `usePaneWidths` into the three panes' inline widths + divider elements; fix the stale-content render guard; reset `symbolPrefillToken`'s consumer path-awareness is already fine, but pass `path` to `SymbolSearch` for its own reset.
- Modify: `src/cloud/codespace/codespace.css` — divider hit-area/hover/drag styling, `.cs-message` mount animation keyframes, `prefers-reduced-motion` override.
- Modify: `src/cloud/codespace/ThreadRail.tsx` — reset `showRecent` on `path` change; add mount-class to message-adjacent seed transition (pending→settled softening lives in `ThreadView.tsx` instead, see below).
- Modify: `src/cloud/codespace/ThreadView.tsx` — apply `.cs-message-mount` class to newly-appended messages (seed + replies + poll-arrived); auto-scroll-to-bottom on append using `nearBottom`/`pinToBottom` from `../../lib/logScroll`.
- Modify: `src/cloud/codespace/symbols/SymbolSearch.tsx` — accept a `path` prop, close on path change; close on scroll (capture-phase); harden panel positioning.
- Modify: `src/cloud/codespace/CodeSpacePage.test.tsx` — regression tests for both bug-3 flows (same-file different-line, cross-file), and the "Back to threads" per-file-context assertion.
- Modify: `src/cloud/codespace/ThreadRail.test.tsx` — regression test for `showRecent` resetting on `path` change.
- Modify: `src/cloud/codespace/symbols/SymbolSearch.test.tsx` — regression tests for close-on-path-change, close-on-scroll.
- Modify: `src/cloud/codespace/ThreadView.test.tsx` — animation mount-class + auto-scroll tests.

---

### Task 1: `usePaneWidths` hook — pure state + persistence

**Files:**
- Create: `src/cloud/codespace/usePaneWidths.ts`
- Test: `src/cloud/codespace/usePaneWidths.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/cloud/codespace/usePaneWidths.test.ts
/**
 * usePaneWidths — pure width-state management for the three-pane resize
 * system (tree | code | rail). No DOM measurement here: the hook only owns
 * numbers (px widths) + localStorage persistence + drag-delta application.
 * CodeSpacePage.tsx wires pointer events and applies the returned widths as
 * inline grid-template-columns / explicit widths.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_WIDTHS, MIN_WIDTHS, usePaneWidths } from "./usePaneWidths";

describe("usePaneWidths", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it("starts at the default widths when localStorage is empty", () => {
    const { result } = renderHook(() => usePaneWidths());
    expect(result.current.widths).toEqual(DEFAULT_WIDTHS);
  });

  it("restores persisted widths from localStorage on mount", () => {
    localStorage.setItem("orcha:cs:panes", JSON.stringify({ tree: 220, rail: 300 }));
    const { result } = renderHook(() => usePaneWidths());
    expect(result.current.widths).toEqual({ tree: 220, rail: 300 });
  });

  it("ignores corrupt localStorage and falls back to defaults", () => {
    localStorage.setItem("orcha:cs:panes", "not json");
    const { result } = renderHook(() => usePaneWidths());
    expect(result.current.widths).toEqual(DEFAULT_WIDTHS);
  });

  it("ignores a persisted shape with non-numeric values", () => {
    localStorage.setItem("orcha:cs:panes", JSON.stringify({ tree: "wide", rail: 300 }));
    const { result } = renderHook(() => usePaneWidths());
    expect(result.current.widths).toEqual(DEFAULT_WIDTHS);
  });

  it("dragTree applies a delta clamped to the tree pane's min width", () => {
    const { result } = renderHook(() => usePaneWidths());
    act(() => { result.current.dragTree(-1000); }); // huge negative delta
    expect(result.current.widths.tree).toBe(MIN_WIDTHS.tree);
  });

  it("dragRail applies a delta in the correct direction (dragging left grows the rail)", () => {
    const { result } = renderHook(() => usePaneWidths());
    const before = result.current.widths.rail;
    act(() => { result.current.dragRail(-40); }); // drag left = rail grows
    expect(result.current.widths.rail).toBe(before + 40);
  });

  it("dragTree grows the tree when dragging right", () => {
    const { result } = renderHook(() => usePaneWidths());
    const before = result.current.widths.tree;
    act(() => { result.current.dragTree(30); });
    expect(result.current.widths.tree).toBe(before + 30);
  });

  it("persists to localStorage after a drag", () => {
    const { result } = renderHook(() => usePaneWidths());
    act(() => { result.current.dragTree(30); });
    const raw = localStorage.getItem("orcha:cs:panes");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.tree).toBe(result.current.widths.tree);
  });

  it("resetTree restores just the tree pane's default width, leaving rail untouched", () => {
    const { result } = renderHook(() => usePaneWidths());
    act(() => { result.current.dragTree(30); result.current.dragRail(-40); });
    act(() => { result.current.resetTree(); });
    expect(result.current.widths.tree).toBe(DEFAULT_WIDTHS.tree);
    expect(result.current.widths.rail).not.toBe(DEFAULT_WIDTHS.rail);
  });

  it("resetRail restores just the rail pane's default width", () => {
    const { result } = renderHook(() => usePaneWidths());
    act(() => { result.current.dragRail(-40); });
    act(() => { result.current.resetRail(); });
    expect(result.current.widths.rail).toBe(DEFAULT_WIDTHS.rail);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/usePaneWidths.test.ts`
Expected: FAIL — `usePaneWidths.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write the implementation**

```typescript
// src/cloud/codespace/usePaneWidths.ts
/**
 * Pure width-state for the three resizable Code Space panes (tree | code |
 * rail — the code pane is the flexible middle, never persisted directly:
 * its width falls out of the container minus tree/rail). Persists to
 * localStorage under "orcha:cs:panes", namespaced GLOBALLY (not per-project)
 * since a human's preferred pane widths are a UI preference, not per-repo
 * data — matches shell/Shell.tsx's theme-persistence convention (global key,
 * try/catch private-mode guard).
 *
 * No DOM/pointer-event code here — CodeSpacePage.tsx owns the actual
 * pointerdown/move/up wiring and calls dragTree/dragRail with the delta
 * since the last event; this hook only clamps + persists the resulting
 * widths. Keeping the two separate makes the width math trivially unit-
 * testable without mounting anything or faking PointerEvent.
 */
import { useCallback, useState } from "react";

export interface PaneWidths {
  tree: number;
  rail: number;
}

export const DEFAULT_WIDTHS: PaneWidths = { tree: 280, rail: 340 };
export const MIN_WIDTHS: PaneWidths = { tree: 160, rail: 240 };
// The code pane's own min-width (320px per spec) is enforced by the CALLER
// (CodeSpacePage.tsx), which knows the container's total width and can
// clamp tree/rail deltas against how much room the code pane has left —
// this hook has no way to know the container width on its own.
export const CODE_MIN_WIDTH = 320;

const STORAGE_KEY = "orcha:cs:panes";

function loadPersisted(): PaneWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTHS;
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed === "object" &&
      typeof parsed.tree === "number" && typeof parsed.rail === "number"
    ) {
      return { tree: parsed.tree, rail: parsed.rail };
    }
    return DEFAULT_WIDTHS;
  } catch {
    return DEFAULT_WIDTHS; // private mode / corrupt JSON — degrade to defaults, never throw
  }
}

function persist(widths: PaneWidths): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    /* private mode — in-memory state still lets the current session resize */
  }
}

export interface UsePaneWidthsResult {
  widths: PaneWidths;
  // delta > 0 means "dragged right" in screen space; each pane interprets
  // that in its own natural direction (tree grows right, rail grows LEFT so
  // its own divider is on its left edge — CodeSpacePage negates the raw
  // pointer delta before calling dragRail, see its own doc comment).
  dragTree: (delta: number) => void;
  dragRail: (delta: number) => void;
  resetTree: () => void;
  resetRail: () => void;
}

export function usePaneWidths(): UsePaneWidthsResult {
  const [widths, setWidths] = useState<PaneWidths>(loadPersisted);

  const dragTree = useCallback((delta: number) => {
    setWidths((prev) => {
      const next = { ...prev, tree: Math.max(MIN_WIDTHS.tree, prev.tree + delta) };
      persist(next);
      return next;
    });
  }, []);

  const dragRail = useCallback((delta: number) => {
    setWidths((prev) => {
      const next = { ...prev, rail: Math.max(MIN_WIDTHS.rail, prev.rail + delta) };
      persist(next);
      return next;
    });
  }, []);

  const resetTree = useCallback(() => {
    setWidths((prev) => {
      const next = { ...prev, tree: DEFAULT_WIDTHS.tree };
      persist(next);
      return next;
    });
  }, []);

  const resetRail = useCallback(() => {
    setWidths((prev) => {
      const next = { ...prev, rail: DEFAULT_WIDTHS.rail };
      persist(next);
      return next;
    });
  }, []);

  return { widths, dragTree, dragRail, resetTree, resetRail };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/usePaneWidths.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels
git add orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/usePaneWidths.ts orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/usePaneWidths.test.ts
git commit -m "cloud: usePaneWidths hook — pure width state + persistence for resizable panes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire pointer-drag divider handles into `CodeSpacePage.tsx` + CSS

**Files:**
- Modify: `src/cloud/codespace/CodeSpacePage.tsx`
- Modify: `src/cloud/codespace/codespace.css`
- Test: `src/cloud/codespace/CodeSpacePage.test.tsx` (new `describe` block)

- [ ] **Step 1: Write the failing tests**

Add this block to `src/cloud/codespace/CodeSpacePage.test.tsx` (append at the end of the file, before the final closing — i.e. as a new top-level `describe`):

```typescript
/* ---- resizable panes (Code Space panel improvements) --------------------- */
describe("CodeSpacePage — resizable panes", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  function firePointer(el: Element, type: string, clientX: number) {
    const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent & { clientX: number; pointerId: number };
    Object.defineProperty(ev, "clientX", { value: clientX });
    Object.defineProperty(ev, "pointerId", { value: 1 });
    el.dispatchEvent(ev);
  }

  it("renders a divider between the tree and code panes, and between code and rail", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-divider-tree")).not.toBeNull();
    expect(document.querySelector(".cs-divider-rail")).not.toBeNull();
  });

  it("dragging the tree divider changes the tree pane's width and persists it", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const treePane = document.querySelector(".cs-tree-pane") as HTMLElement;
    const before = treePane.style.width;
    const divider = document.querySelector(".cs-divider-tree") as HTMLElement;

    firePointer(divider, "pointerdown", 280);
    firePointer(document, "pointermove", 340); // +60px right
    firePointer(document, "pointerup", 340);

    expect(treePane.style.width).not.toBe(before);
    expect(treePane.style.width).toBe("340px");
    const raw = localStorage.getItem("orcha:cs:panes");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).tree).toBe(340);
  });

  it("restores a persisted width on mount", async () => {
    localStorage.setItem("orcha:cs:panes", JSON.stringify({ tree: 200, rail: 260 }));
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const treePane = document.querySelector(".cs-tree-pane") as HTMLElement;
    const railPane = document.querySelector(".cs-rail") as HTMLElement;
    expect(treePane.style.width).toBe("200px");
    expect(railPane.style.width).toBe("260px");
  });

  it("double-clicking the tree divider resets just the tree pane to its default width", async () => {
    localStorage.setItem("orcha:cs:panes", JSON.stringify({ tree: 200, rail: 260 }));
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const divider = document.querySelector(".cs-divider-tree") as HTMLElement;
    fireEvent.doubleClick(divider);
    const treePane = document.querySelector(".cs-tree-pane") as HTMLElement;
    const railPane = document.querySelector(".cs-rail") as HTMLElement;
    expect(treePane.style.width).toBe("280px"); // DEFAULT_WIDTHS.tree
    expect(railPane.style.width).toBe("260px"); // untouched
  });

  it("dragging the rail divider left grows the rail pane", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const railPane = document.querySelector(".cs-rail") as HTMLElement;
    const beforeWidth = parseInt(railPane.style.width || "340", 10);
    const divider = document.querySelector(".cs-divider-rail") as HTMLElement;

    firePointer(divider, "pointerdown", 900);
    firePointer(document, "pointermove", 860); // dragged 40px LEFT
    firePointer(document, "pointerup", 860);

    expect(parseInt(railPane.style.width, 10)).toBe(beforeWidth + 40);
  });

  it("a plain click on the code pane (not a drag) still selects text normally — no stray preventDefault", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    // sanity: clicking a line's text span (not the gutter) doesn't throw and
    // doesn't open the composer — regression guard against a global
    // pointerdown handler swallowing normal code-pane interaction.
    const lineText = document.querySelector('[data-cs-line="1"] .cs-line-text') as HTMLElement;
    fireEvent.mouseDown(lineText);
    expect(screen.queryByText(/line 1/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/CodeSpacePage.test.tsx -t "resizable panes"`
Expected: FAIL — no `.cs-divider-tree`/`.cs-divider-rail` elements exist yet.

- [ ] **Step 3: Implement — add divider elements + pointer wiring to `CodeSpacePage.tsx`**

Add the import (near the top, alongside the other local imports):

```typescript
import { usePaneWidths } from "./usePaneWidths";
```

Inside the `CodeSpacePage` function body, add right after the `gutterDotsForLine` `useMemo` (before the `if (!cid) return null;` line):

```typescript
  // Panel improvements item 1 — resizable tree/code/rail panes. Native
  // Pointer Events (setPointerCapture keeps receiving move/up even if the
  // cursor leaves the divider's own small hit area mid-drag) — no drag
  // library, matching this codebase's zero-new-dependency convention.
  const { widths, dragTree, dragRail, resetTree, resetRail } = usePaneWidths();
  const dragState = useRef<{ pane: "tree" | "rail"; startX: number } | null>(null);

  const startDrag = useCallback((pane: "tree" | "rail") => (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { pane, startX: e.clientX };
  }, []);

  const onDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st) return;
    const delta = e.clientX - st.startX;
    st.startX = e.clientX;
    // dragRail negates the delta INTERNALLY (usePaneWidths.ts's own doc
    // comment) — pass the raw pointer delta unmodified for both panes.
    if (st.pane === "tree") dragTree(delta);
    else dragRail(delta);
  }, [dragTree, dragRail]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragState.current) (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    dragState.current = null;
  }, []);
```

Now modify the `.cs-body` JSX. Find this block (the three-pane container):

```jsx
        <div className="cs-body">
          <div className="cs-tree-pane">
```

Replace the opening of `.cs-body` through the tree pane's opening tag, and insert dividers. The full modified `.cs-body` structure:

```jsx
        <div className="cs-body">
          <div className="cs-tree-pane" style={{ width: widths.tree }}>
            <div className="rb-tree-scroll">
              <ErrorBoundary label="tree">
                <BrowseTree
                  rows={rows}
                  dirCache={dirCache}
                  expanded={expanded}
                  selectedPath={path}
                  onToggleDir={toggleDir}
                  onSelectFile={selectFile}
                  fileBadge={(p) => {
                    const n = fileThreads.filter((t) => t.path === p).length;
                    return n ? <span className="cs-tree-badge">{n}</span> : null;
                  }}
                />
              </ErrorBoundary>
            </div>
          </div>

          <div
            className="cs-divider cs-divider-tree"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree pane"
            title="Drag to resize, double-click to reset"
            onPointerDown={startDrag("tree")}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onDoubleClick={resetTree}
          />

          <div className="cs-code-pane">
```

(everything from the existing `<div className="cs-code-scroll">` through the end of the code pane's closing `</div>` stays exactly as-is — no change there.)

Then, right after the code pane's closing `</div>` and right before `<ErrorBoundary label="rail">`, insert the rail divider:

```jsx
          <div
            className="cs-divider cs-divider-rail"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize thread rail pane"
            title="Drag to resize, double-click to reset"
            onPointerDown={startDrag("rail")}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onDoubleClick={resetRail}
          />

          <ErrorBoundary label="rail">
            <ThreadRail
```

And add `style={{ width: widths.rail }}` to the `ThreadRail`'s own root — `ThreadRail` renders `<aside className="cs-rail">` internally, so instead pass the width as a wrapper. Simplest correct approach: wrap the existing `<ErrorBoundary label="rail">...</ErrorBoundary>` in a plain sizing div:

```jsx
          <div style={{ width: widths.rail, flex: "none" }}>
            <ErrorBoundary label="rail">
              <ThreadRail
                cid={cid}
                gitRef={gitRef}
                path={path}
                agents={agents}
                tab={railTab}
                onTabChange={setRailTab}
                composerSelection={composerOpen ? selection : null}
                onComposerClose={closeComposer}
                onJumpToLine={jumpToLine}
                onJumpToPinnedSha={jumpToPinnedSha}
                openThreadId={openThreadId}
                onOpenThread={openThread}
                onThreadsLoaded={setFileThreads}
                raiseHand={raiseHand}
                onRaiseHandDone={() => setRaiseHand(null)}
                onRaiseHandRequested={onRaiseHand}
                onNavigateToThread={navigateToThread}
              />
            </ErrorBoundary>
          </div>
```

- [ ] **Step 4: Update `codespace.css`**

Change the fixed-width tree/rail rules to work with inline `style` widths (remove the hardcoded `width` from `.cs-tree-pane` — the inline style now owns it — but KEEP `min-width`/`max-width` as a CSS safety net in case JS hasn't hydrated yet):

Find:
```css
.cs-tree-pane { width: 280px; min-width: 200px; max-width: 360px; flex: none;
  display: flex; flex-direction: column; border-right: 1px solid var(--border);
  background: var(--surface-2); overflow: hidden; }
```

Replace with:
```css
.cs-tree-pane { min-width: 160px; flex: none;
  display: flex; flex-direction: column; border-right: 1px solid var(--border);
  background: var(--surface-2); overflow: hidden; }
```

Find:
```css
.cs-rail { width: 340px; min-width: 260px; max-width: 420px; flex: none;
  display: flex; flex-direction: column; border-left: 1px solid var(--border);
  background: var(--surface-2); overflow: hidden; }
```

Replace with:
```css
.cs-rail { min-width: 240px; flex: none;
  display: flex; flex-direction: column; border-left: 1px solid var(--border);
  background: var(--surface-2); overflow: hidden; }
```

Add the divider styling (append near the end of the "middle: code viewer" section, right after `.cs-code-scroll { flex: 1; overflow: auto; }`):

```css
/* ---- Panel improvements item 1: resizable pane dividers -------------------
   6px hit area (comfortable pointer target without visually widening the
   1px border look), col-resize cursor, a subtle highlight on hover/drag
   done via a ::after inset bar so the divider's own box stays hairline-thin
   at rest. touch-action:none stops the browser's own scroll/pan gesture
   from fighting the drag on trackpad/touch input. */
.cs-divider { flex: none; width: 6px; margin: 0 -3px; position: relative; z-index: 5;
  cursor: col-resize; touch-action: none; -webkit-user-select: none; user-select: none; }
.cs-divider::after { content: ""; position: absolute; top: 0; bottom: 0; left: 2px; right: 2px;
  border-radius: 2px; background: transparent; transition: background .12s; }
.cs-divider:hover::after, .cs-divider.dragging::after { background: var(--accent-line); }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/CodeSpacePage.test.tsx -t "resizable panes"`
Expected: PASS, 6 tests.

- [ ] **Step 6: Full-suite sanity check (nothing else in CodeSpacePage.test.tsx broke)**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/CodeSpacePage.test.tsx`
Expected: PASS, all tests (baseline + 6 new).

- [ ] **Step 7: Commit**

```bash
cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels
git add orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/CodeSpacePage.tsx orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/codespace.css orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/CodeSpacePage.test.tsx
git commit -m "cloud: resizable tree/code/rail panes via pointer-drag dividers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Fix bug 3 — stale file content during file-switch loading

**Root cause:** `CodeSpacePage.tsx`'s content-pane render guard `fileLoading && !filePayload ? <Skeleton/> : ... filePayload ? <ContentPaneChrome payload={filePayload}>` only blocks stale content on the very first load. On every SUBSEQUENT file switch, `filePayload` still holds the PREVIOUS file while `fileLoading` is true, so the previous file's lines/gutter render under the new file's URL/breadcrumb until the fetch resolves — confirmed via live repro against a running container.

**Files:**
- Modify: `src/cloud/codespace/CodeSpacePage.tsx`
- Test: `src/cloud/codespace/CodeSpacePage.test.tsx` (new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append this block to `src/cloud/codespace/CodeSpacePage.test.tsx`:

```typescript
/* ---- BUG 3: stale file content during file-switch loading ---------------- */
describe("CodeSpacePage — bug 3: no stale content while switching files", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  // A fetch stub whose file-content responses can be held open (resolved
  // manually) so the test can inspect the DOM MID-transition, exactly the
  // race window the live repro caught.
  function stubFetchWithControllableFileLoad() {
    const fileResolvers: Record<string, (v: unknown) => void> = {};
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
      if (url.startsWith("/api/containers/c1/github/browse/file")) {
        const isB = url.includes("path=b.ts");
        const key = isB ? "b.ts" : "a.ts";
        return new Promise((resolve) => { fileResolvers[key] = () => resolve(json(isB ? FILE_B : FILE_A)); });
      }
      if (url.startsWith("/api/containers/c1/code/threads")) return json(THREADS_MD);
      if (url.startsWith("/api/containers/c1")) {
        return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
      }
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      return json({});
    }) as unknown as typeof fetch;
    return fileResolvers;
  }

  const FILE_B = { ref: "HEAD", path: "b.ts", content: "const z = 9;", size: 12 };

  it("does not render the PREVIOUS file's lines while the NEW file is still loading", async () => {
    const resolvers = stubFetchWithControllableFileLoad();
    mount();
    resolvers["a.ts"]({});
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    // a.ts's real content is 3 lines; confirm it painted before switching.
    expect(document.querySelector('[data-cs-line="3"]')).not.toBeNull();

    fireEvent.click(screen.getByText("b.ts", { selector: "button.cs-crumb, .dfv-nm" }));
    // b.ts's fetch is still pending (resolver not called yet) — the pane
    // must show the skeleton, NEVER a.ts's stale 3-line content, and must
    // NOT still show "a.ts" as the active file path in the breadcrumb.
    expect(document.querySelector(".rb-file-path")?.textContent).not.toBe("a.ts");
    expect(document.querySelector(".ork-sk, .rb-skel, [class*='skel']")).not.toBeNull();
  });

  it("gutter clicks during the loading window do nothing (no composer opens for stale content)", async () => {
    const resolvers = stubFetchWithControllableFileLoad();
    mount();
    resolvers["a.ts"]({});
    await screen.findByText("a.ts", { selector: ".rb-file-path" });

    fireEvent.click(screen.getByText("b.ts", { selector: ".dfv-nm" }));
    // still mid-load — there should be NO clickable .cs-gutter at all right
    // now (the skeleton has no gutter), so no stray composer can open.
    expect(document.querySelector(".cs-gutter")).toBeNull();

    resolvers["b.ts"]({});
    await screen.findByText("b.ts", { selector: ".rb-file-path" });
    // once loaded, b.ts's own single line IS clickable and anchors correctly.
    const gutter1 = document.querySelector('[data-cs-line="1"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter1);
    expect(await screen.findByText(/line 1/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/CodeSpacePage.test.tsx -t "bug 3"`
Expected: FAIL — the first test fails because `a.ts`'s stale content (3 lines, `.rb-file-path` text "a.ts") is still on screen when `b.ts` is mid-load.

- [ ] **Step 3: Implement the fix**

In `src/cloud/codespace/CodeSpacePage.tsx`, find the content-pane render ladder:

```jsx
              {!path ? (
                <CodeSpaceLanding
                  cid={cid}
                  onNavigateToThread={navigateToThread}
                  onOpenFile={selectFile}
                  onSearchSymbols={focusSymbolSearch}
                  onFocusTree={focusTree}
                />
              ) : fileLoading && !filePayload ? (
                <BrowseSkeletonPane />
              ) : fileError ? (
                <BrowseErrorBody err={fileError} what="File" />
              ) : filePayload ? (
```

Replace the guard so it also treats a payload for the WRONG path as stale (falls through to the skeleton instead of rendering it):

```jsx
              {!path ? (
                <CodeSpaceLanding
                  cid={cid}
                  onNavigateToThread={navigateToThread}
                  onOpenFile={selectFile}
                  onSearchSymbols={focusSymbolSearch}
                  onFocusTree={focusTree}
                />
              ) : fileLoading || (filePayload && filePayload.path !== path) ? (
                <BrowseSkeletonPane />
              ) : fileError ? (
                <BrowseErrorBody err={fileError} what="File" />
              ) : filePayload ? (
```

This is the root-cause fix: `fileLoading` alone (not `fileLoading && !filePayload`) now gates the skeleton — ANY in-flight fetch shows the skeleton rather than risking stale content, and the `filePayload.path !== path` clause is a second independent guard in case `fileLoading` and `path` ever race each other (defense in depth — `useBrowseTree.ts`'s token-guard already prevents a stale response from ever calling `setFilePayload` for an abandoned fetch, but this belt-and-suspenders check costs nothing and protects against a future refactor of that hook reintroducing the same class of bug).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/CodeSpacePage.test.tsx -t "bug 3"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the FULL CodeSpacePage test file to confirm no regressions**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/CodeSpacePage.test.tsx`
Expected: PASS, all tests (this guard change touches the render path every existing test exercises, so this is the critical regression checkpoint).

- [ ] **Step 6: Commit**

```bash
cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels
git add orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/CodeSpacePage.tsx orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/CodeSpacePage.test.tsx
git commit -m "cloud: fix BUG 3 root cause — stale file content rendered during file-switch loading

The content-pane render guard only blocked stale content on the very
first file load (fileLoading && !filePayload). Switching files sets
fileLoading=true but filePayload still holds the PREVIOUS file until
the fetch resolves, so the previous file's lines/gutter render under
the new file's path/breadcrumb for one paint. A gutter click in that
window opens the composer anchored to the wrong path/line — this is
the root cause of 'thread triggering dies after switching files'.

Confirmed via live repro against a running container: init_test.sql
-> postgres.conf briefly re-rendered init_test.sql's content under the
new breadcrumb/tree selection before self-correcting.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Fix bug 3's second half — rail stuck on "Recent threads (all files)"

**Root cause:** `ThreadRail.tsx`'s local `showRecent` state has no `useEffect` resetting it when `path` changes, so navigating to a new file while `showRecent` is `true` strands the rail on the repo-wide Recent list instead of returning to the new file's own per-file list — matches the user's screenshot exactly.

**Files:**
- Modify: `src/cloud/codespace/ThreadRail.tsx`
- Test: `src/cloud/codespace/ThreadRail.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `src/cloud/codespace/ThreadRail.test.tsx`, inside (or right after) the existing `describe("ThreadRail — Recent quick-jump (item 3)", ...)` block:

```typescript
  it("BUG 3: switching to a different file resets showRecent back to the per-file list", async () => {
    stubFetch();
    const { rerender } = mount({ path: "a.ts" });
    await screen.findByText("Question");
    fireEvent.click(screen.getByText(/recent threads/i));
    expect(await screen.findByText(/back to a\.ts/i)).toBeInTheDocument();

    // simulate CodeSpacePage navigating to a different file (path prop changes)
    rerender(
      <ToastProvider>
        <SnapshotProvider>
          <ThreadRail
            cid="c1" gitRef="HEAD" path="b.ts" agents={AGENTS} tab="threads"
            onTabChange={vi.fn()} composerSelection={null} onComposerClose={vi.fn()}
            onJumpToLine={vi.fn()} openThreadId={null} onOpenThread={vi.fn()}
            raiseHand={null} onRaiseHandDone={vi.fn()}
          />
        </SnapshotProvider>
      </ToastProvider>,
    );

    // must NOT still show the repo-wide "Recent threads (all files)" state —
    // it should be back to b.ts's own per-file list (with its own compact
    // Recent link, not the "back to a.ts" link from before).
    expect(screen.queryByText(/back to a\.ts/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/b\.ts:7/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/ThreadRail.test.tsx -t "BUG 3"`
Expected: FAIL — after `rerender` with `path="b.ts"`, `showRecent` is still `true` from the earlier click, so "back to a.ts" (or the repo-wide Recent list) is still showing.

- [ ] **Step 3: Implement the fix**

In `src/cloud/codespace/ThreadRail.tsx`, find:

```typescript
  const [showRecent, setShowRecent] = useState(false);
```

Add a reset effect right after the other `useEffect`s that key on `path` (place it near the top-level effects, right after the `threads`-fetching `useEffect` that already depends on `path`):

```typescript
  // BUG 3 fix — showRecent is UI state scoped to "am I looking at this
  // file's own threads, or the repo-wide Recent list". Switching to a
  // DIFFERENT file must always land back on that file's own list — carrying
  // over showRecent=true stranded the rail on "Recent threads (all files)"
  // after a file switch (screenshot: rail lost the current file's context).
  useEffect(() => {
    setShowRecent(false);
  }, [path]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/ThreadRail.test.tsx -t "BUG 3"`
Expected: PASS.

- [ ] **Step 5: Run the full ThreadRail test file**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/ThreadRail.test.tsx`
Expected: PASS, all tests (the reset effect must not break the "no file open" landing behavior — `wantsRecent = !path || showRecent` still correctly shows Recent when `path` is empty regardless of this new effect, since an empty `path` never fires a false reset that matters: `showRecent` being forced `false` when `path` is falsy is a no-op for the `!path` branch of `wantsRecent`).

- [ ] **Step 6: Also add the CodeSpacePage-level end-to-end version of both bug-3 flows**

Append to the `describe("CodeSpacePage — bug 3: ...")` block from Task 3 (same file, same describe block):

```typescript
  it("flow (a): after opening an existing thread, clicking a DIFFERENT line in the SAME file reopens the composer", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const chip = await screen.findByText("Question");
    fireEvent.click(chip.closest(".cs-thread-chip") as HTMLElement);
    expect(await screen.findByText(/back to threads/i)).toBeInTheDocument();

    const gutter3 = document.querySelector('[data-cs-line="3"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter3);
    expect(await screen.findByText(/line 3/i)).toBeInTheDocument();
    expect(screen.queryByText(/back to threads/i)).not.toBeInTheDocument();
  });

  it("flow (b): after opening a thread, switching file and clicking a line reopens the composer AND the rail shows the new file's own context", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const chip = await screen.findByText("Question");
    fireEvent.click(chip.closest(".cs-thread-chip") as HTMLElement);
    expect(await screen.findByText(/back to threads/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText("readme.md"));
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Raw")); // readme.md defaults to Rendered — need Raw for a gutter

    const gutter1 = document.querySelector('[data-cs-line="1"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter1);
    expect(await screen.findByText(/line 1/i)).toBeInTheDocument();
    // rail must NOT be stuck on the repo-wide Recent list.
    expect(screen.queryByText(/recent threads \(all files\)/i)).not.toBeInTheDocument();
  });
```

- [ ] **Step 7: Run these two tests**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/CodeSpacePage.test.tsx -t "flow"`
Expected: PASS, 2 tests.

- [ ] **Step 8: Commit**

```bash
cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels
git add orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/ThreadRail.tsx orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/ThreadRail.test.tsx orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/CodeSpacePage.test.tsx
git commit -m "cloud: fix BUG 3 second half — rail stuck on repo-wide Recent after file switch

ThreadRail's local showRecent state had no reset on path change, so
navigating to a new file while viewing the repo-wide Recent list
stranded the rail there instead of returning to the new file's own
per-file thread list. Matches the reported screenshot exactly.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Fix bug 4 — SymbolSearch popover lifecycle (close on file-change/scroll, harden positioning)

**Root cause:** Live repro across landing state, file-open state, and sidebar-collapsed full-bleed state showed CORRECT positioning — `.cs-symsearch { position: relative }` is unconditional with no competing rule. The confirmed real gap: `SymbolSearch.tsx` has no reset on `path` (file) change and no scroll-close handler, so the panel can be left open with stale/wrong-context results across a file switch. This task closes that gap and adds a defensive positioning hardening (explicit anchor tracking via `getBoundingClientRect`, applied as inline `top`/`left`/`width` instead of relying purely on CSS `position:absolute` inheritance) so the panel is correct even if some future layout change breaks the CSS containing-block chain.

**Files:**
- Modify: `src/cloud/codespace/symbols/SymbolSearch.tsx`
- Modify: `src/cloud/codespace/CodeSpacePage.tsx` (pass the new `path` prop)
- Test: `src/cloud/codespace/symbols/SymbolSearch.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `src/cloud/codespace/symbols/SymbolSearch.test.tsx`:

```typescript
  it("BUG 4: closes when the current file path changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: true, ref: "HEAD", results: [{ name: "helper", kind: "function", path: "a.ts", line: 2 }] });
    const { rerender } = render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} path="a.ts" />);
    fireEvent.change(screen.getByPlaceholderText(/search symbols/i), { target: { value: "helper" } });
    fireEvent.focus(screen.getByPlaceholderText(/search symbols/i));
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(await screen.findByText("helper")).toBeInTheDocument();

    rerender(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} path="b.ts" />);
    expect(screen.queryByText("helper")).not.toBeInTheDocument();
  });

  it("BUG 4: closes on scroll (capture-phase, any scrollable ancestor)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({ available: true, ref: "HEAD", results: [{ name: "helper", kind: "function", path: "a.ts", line: 2 }] });
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} path="a.ts" />);
    fireEvent.change(screen.getByPlaceholderText(/search symbols/i), { target: { value: "helper" } });
    fireEvent.focus(screen.getByPlaceholderText(/search symbols/i));
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(await screen.findByText("helper")).toBeInTheDocument();

    fireEvent.scroll(window);
    expect(screen.queryByText("helper")).not.toBeInTheDocument();
  });

  it("does NOT close on scroll while the panel is already closed (no-op guard)", () => {
    render(<SymbolSearch cid="c1" gitRef="HEAD" onNavigate={vi.fn()} path="a.ts" />);
    expect(() => fireEvent.scroll(window)).not.toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/symbols/SymbolSearch.test.tsx -t "BUG 4"`
Expected: FAIL — `path` prop doesn't exist on `SymbolSearchProps` yet (TS error surfaces as a runtime prop simply being ignored, and the panel stays open in both new tests).

- [ ] **Step 3: Implement the fix**

In `src/cloud/codespace/symbols/SymbolSearch.tsx`, update the props interface:

```typescript
export interface SymbolSearchProps {
  cid: string;
  gitRef: string;
  onNavigate: (path: string, line: number) => void;
  prefill?: string;
  prefillToken?: number;
  focusToken?: number;
  // BUG 4 fix — the currently open file's path. Closes the panel whenever
  // this changes (a file switch mid-search left stale, wrong-context
  // results open — never literally "detached" in testing, but stale
  // results reading as broken is the same bad outcome for the human).
  path?: string;
}
```

Update the function signature:

```typescript
export function SymbolSearch({ cid, gitRef, onNavigate, prefill, prefillToken, focusToken, path }: SymbolSearchProps) {
```

Add two new effects right after the existing Cmd/Ctrl+P effect (which already lives inside the component):

```typescript
  // BUG 4 fix — close on file navigation. A file switch invalidates
  // whatever's currently shown (results were scoped to the OLD context the
  // human was searching from) — closing is the same "picked something,
  // done" convention RecentFilesDropdown.tsx already uses for its own panel.
  useEffect(() => {
    setOpen(false);
  }, [path]);

  // BUG 4 fix — close on scroll. A window/ancestor scroll while the panel is
  // open would otherwise leave it visually anchored to wherever the input
  // WAS, not where it now is — capture:true catches scroll on any
  // scrollable ancestor (scroll events don't bubble, only capture).
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open]);
```

Now harden the positioning defensively. Replace the panel's render:

```jsx
      {showPanel ? (
        <div className="cs-symsearch-panel">
```

with an anchor-rect-tracked version. First add a ref and a rect-tracking effect near the other refs:

```typescript
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number; width: number } | null>(null);

  // BUG 4 defensive hardening — recompute the anchor's own rect every time
  // the panel opens, and apply it as an EXPLICIT inline position rather than
  // relying purely on the CSS position:relative/absolute containing-block
  // chain. If some future layout change ever breaks that chain (a missing
  // position:relative on an ancestor, a transform/contain property that
  // creates an unexpected new containing block), the panel still lands in
  // the right place instead of falling back to the viewport's initial
  // containing block (the exact "stranded at top-left" failure mode).
  useEffect(() => {
    if (!open || !rootRef.current) { setAnchorRect(null); return; }
    const r = rootRef.current.getBoundingClientRect();
    setAnchorRect({ top: r.bottom + 6, left: r.left, width: r.width });
  }, [open]);
```

Update the root div to carry the ref:

```jsx
    <div className="cs-symsearch" ref={rootRef}>
```

And update the panel render to apply the explicit rect when available, falling back to the existing CSS-relative behavior when it isn't (e.g. jsdom, where `getBoundingClientRect` returns all-zeros — the `anchorRect &&` guard below only overrides positioning when there's a REAL non-degenerate rect, which the `top/left/width` fixed-position styles express):

```jsx
      {showPanel ? (
        <div
          className="cs-symsearch-panel"
          style={anchorRect ? { position: "fixed", top: anchorRect.top, left: anchorRect.left, width: anchorRect.width, right: "auto" } : undefined}
        >
```

- [ ] **Step 4: Wire `path` from `CodeSpacePage.tsx`**

In `src/cloud/codespace/CodeSpacePage.tsx`, find:

```jsx
          <SymbolSearch
            cid={cid}
            gitRef={gitRef}
            onNavigate={navigateToSymbol}
            prefill={symbolPrefill}
            prefillToken={symbolPrefillToken}
            focusToken={symbolFocusToken}
          />
```

Add the `path` prop:

```jsx
          <SymbolSearch
            cid={cid}
            gitRef={gitRef}
            onNavigate={navigateToSymbol}
            prefill={symbolPrefill}
            prefillToken={symbolPrefillToken}
            focusToken={symbolFocusToken}
            path={path}
          />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/symbols/SymbolSearch.test.tsx`
Expected: PASS, all tests (baseline + 3 new). Note: `getBoundingClientRect` in jsdom returns `{top:0,left:0,width:0,...}` by default — the existing tests that don't mock it will get `anchorRect = {top:6, left:0, width:0}`, which still renders (a 0-width fixed panel is valid, if visually odd only in jsdom); confirm no test asserts on the panel's pixel position, only its presence/content, so this is safe. If any test unexpectedly fails on this, inspect whether it was asserting DOM structure that the `style` attribute now affects (none currently do, per the read of this file above).

- [ ] **Step 6: Run the identifier-click integration test (CodeSpacePage.tsx wiring)**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/CodeSpacePage.test.tsx -t "identifier token"`
Expected: PASS — confirms the `path` prop wiring didn't break the existing identifier-click-prefills-search flow.

- [ ] **Step 7: Full regression run for this task's touched files**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/symbols/SymbolSearch.test.tsx src/cloud/codespace/CodeSpacePage.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels
git add orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/symbols/SymbolSearch.tsx orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/symbols/SymbolSearch.test.tsx orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/CodeSpacePage.tsx
git commit -m "cloud: fix BUG 4 — SymbolSearch popover closes on file-change/scroll, hardened positioning

Live repro across landing/file-open/sidebar-collapsed states showed
correct positioning in every reachable state, but SymbolSearch had no
reset on file navigation or scroll, leaving stale/wrong-context
results open across a file switch. Closes that gap, and additionally
computes the panel's position from an explicit getBoundingClientRect
anchor (applied as fixed top/left/width) rather than relying solely on
the CSS containing-block chain, as a defensive hardening against the
'stranded at viewport corner' failure mode the report described.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Chat-feel message animation + auto-scroll (item 2)

**Files:**
- Modify: `src/cloud/codespace/ThreadView.tsx`
- Modify: `src/cloud/codespace/codespace.css`
- Test: `src/cloud/codespace/ThreadView.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `src/cloud/codespace/ThreadView.test.tsx` (check its existing mount helper/stub pattern first — reuse it; the block below assumes a `mount(props)` helper and `stubFetch()` already exist in that file, matching this codebase's per-file test convention seen in `ThreadRail.test.tsx`/`CodeSpacePage.test.tsx`):

```typescript
describe("ThreadView — chat-feel animation + auto-scroll (panel improvements item 2)", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("newly-mounted messages carry the mount animation class", async () => {
    stubFetch();
    mount({ threadId: "t1" });
    const bubble = await screen.findByText(/./, { selector: ".cs-message" });
    expect(bubble.className).toContain("cs-message-mount");
  });

  it("a pending (optimistic) message uses an opacity-shift class, not a hard pending/settled swap", async () => {
    stubFetch();
    mount({ threadId: "t1" });
    await screen.findByText(/./, { selector: ".cs-message" });
    fireEvent.change(screen.getByLabelText(/reply to thread/i), { target: { value: "hello" } });
    fireEvent.click(screen.getByText("Reply"));
    const pending = document.querySelector(".cs-message.pending");
    expect(pending).not.toBeNull();
    expect(pending!.className).toContain("cs-message-mount");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/ThreadView.test.tsx -t "chat-feel"`
Expected: FAIL — no element carries `.cs-message-mount` yet.

- [ ] **Step 3: Implement — add the mount class + auto-scroll in `ThreadView.tsx`**

Add the import:

```typescript
import { nearBottom, pinToBottom } from "../../lib/logScroll";
```

Add a ref for the scrollable messages container and an auto-scroll effect. Find:

```typescript
  const [detail, setDetail] = useState<CodeThreadDetailPayload | null>(seed ?? null);
```

Add right after it:

```typescript
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const prevMessageCount = useRef(0);
```

Add an effect right after the polling `useEffect` (the one with `fetchThread`), still inside the component body but before the `if (!detail) return ...` early return — actually, since `detail` may be null on first render, place this effect AFTER the early returns aren't possible (hooks must run unconditionally) — so place it immediately after the `messagesRef`/`prevMessageCount` declarations, reading `detail?.messages` defensively:

```typescript
  // Panel improvements item 2 — auto-scroll the thread pane to the newest
  // message on append, but ONLY if the reader is already at/near the
  // bottom (logScroll.ts's house rule: "stick to the bottom while the
  // reader is at the bottom", reused verbatim rather than reimplemented).
  useEffect(() => {
    const count = detail?.messages?.length ?? 0;
    const el = messagesRef.current;
    if (el && count > prevMessageCount.current && nearBottom(el)) {
      pinToBottom(el);
    }
    prevMessageCount.current = count;
  }, [detail?.messages?.length]);
```

Now find the messages container:

```jsx
      <div className="cs-messages">
        {(messages ?? []).map((m) => (
          <div key={m.id} className={"cs-message" + (m.is_human ? " human" : "") + (m.id.startsWith("optimistic-") ? " pending" : "")}>
```

Replace with:

```jsx
      <div className="cs-messages" ref={messagesRef}>
        {(messages ?? []).map((m) => (
          <div key={m.id} className={"cs-message cs-message-mount" + (m.is_human ? " human" : "") + (m.id.startsWith("optimistic-") ? " pending" : "")}>
```

(Every message bubble always carries `cs-message-mount` — the CSS keyframe plays once on mount for EVERY message, matching the spec's "posted messages (optimistic seed + replies + poll-arriving agent replies) animate in like a chat" — there's no need to distinguish "just arrived" from "already there" at the React layer since a CSS mount-triggered keyframe only ever plays once per DOM node's lifetime by definition; a message that was already on screen before this render never remounts because its `key={m.id}` is stable, so it never replays.)

- [ ] **Step 4: Add the CSS**

In `src/cloud/codespace/codespace.css`, find:

```css
.cs-message { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: 8px;
  background: var(--surface); border: 1px solid var(--border); }
.cs-message.human { border-color: var(--accent-line); }
.cs-message.pending { opacity: 0.6; }
```

Replace with:

```css
.cs-message { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: 8px;
  background: var(--surface); border: 1px solid var(--border); }
.cs-message.human { border-color: var(--accent-line); }
/* Panel improvements item 2 — pending->settled softens via an opacity
   transition rather than a hard class-swap flash; the optimistic bubble
   fades to full opacity the instant `pending` is removed (reconcile() in
   this file swaps the class in the same render the real row lands). */
.cs-message { transition: opacity .18s ease-out; }
.cs-message.pending { opacity: 0.6; }

/* Chat-feel mount animation — ~180ms ease-out slide-up+fade, CSS-only so it
   plays exactly once per bubble's mount (stable `key={m.id}` means an
   already-on-screen message never remounts/replays this). Respects
   prefers-reduced-motion: users who've asked for less motion get an
   instant, static appearance instead. */
@keyframes cs-message-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.cs-message-mount { animation: cs-message-in .18s ease-out; }
@media (prefers-reduced-motion: reduce) {
  .cs-message-mount { animation: none; }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run src/cloud/codespace/ThreadView.test.tsx`
Expected: PASS, all tests (baseline + 2 new).

- [ ] **Step 6: Commit**

```bash
cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels
git add orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/ThreadView.tsx orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/codespace.css orcha-cli/orcha_cli/templates/portal/frontend/src/cloud/codespace/ThreadView.test.tsx
git commit -m "cloud: chat-feel message animation + bottom-follow auto-scroll (item 2)

Reuses lib/logScroll.ts's nearBottom/pinToBottom helpers verbatim
(generic DOM-shape typing, no log-specific coupling) for the
'stick to the bottom while the reader is at the bottom' rule. CSS
keyframe mount animation respects prefers-reduced-motion.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Final full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck clean**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 2: Full Vitest suite green**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels/orcha-cli/orcha_cli/templates/portal/frontend && npx vitest run`
Expected: all test files pass. Baseline was 530 tests across 68 files; this plan adds roughly 10 (usePaneWidths) + 6 (resize integration) + 2 (bug 3 stale-content) + 2 (bug 3 flows a/b) + 1 (ThreadRail showRecent) + 3 (bug 4 SymbolSearch) + 2 (chat animation) = ~26 new tests, so expect ~556 passed, 0 failed.

- [ ] **Step 3: If anything fails, stop and re-run systematic-debugging on that specific failure — do not proceed to sign-off with red tests.**

- [ ] **Step 4: Final commit check — confirm branch state**

Run: `cd /Users/husseinmohamed/Desktop/quantal-projects/ocs-panels && git log --oneline fix/codespace-panels -8 && git status`
Expected: 6 commits on `fix/codespace-panels` (Tasks 1,2,3,4,5,6 each committed separately), working tree clean, branch NOT pushed (per the task brief: "do NOT push").

---

## Self-Review Notes

- **Spec coverage**: Item 1 (resizable panels, min widths, localStorage key `orcha:cs:panes`, double-click reset per-divider) — Tasks 1-2. Item 2 (chat animation, pending->settled softening, auto-scroll reusing logScroll.ts) — Task 6. Item 3 (bug 3, both flows + "Back to threads" file-context) — Tasks 3-4. Item 4 (bug 4, popover close-on-nav/scroll + hardened positioning) — Task 5. Verification commands (`tsc --noEmit`, `vitest run` full green) — Task 7.
- **Code pane min-width (320px)**: enforced structurally — the code pane has no persisted width of its own (`flex:1` fills whatever's left of the container after tree+rail), and `CODE_MIN_WIDTH` is exported from the hook as a documented constant for `CodeSpacePage.tsx` to consult if it ever needs to clamp drag deltas against total container width; Task 2 doesn't wire that clamp explicitly because jsdom has no real layout (`getBoundingClientRect` on the container returns zeros in tests), making a true container-width clamp untestable in this suite — flagging this as a known follow-up rather than a silent gap: **the drag handlers currently clamp each pane's OWN min-width but not the code pane's remaining space**, which in a real browser could theoretically let tree+rail combined squeeze the code pane below 320px on a narrow window. Acceptable for v1 given no min-width violation was in the original bug reports, but worth a fast-follow if real usage surfaces it.
- **Placeholder scan**: no TBD/TODO left in any step; every step has literal code.
- **Type consistency**: `usePaneWidths` returns `{ widths, dragTree, dragRail, resetTree, resetRail }` and Task 2 consumes exactly those five names; `SymbolSearchProps.path` flows from `CodeSpacePage.tsx`'s existing `path` (already a `string`, matches `path?: string` optionality on the prop — `CodeSpacePage.tsx` always has a defined `path` when rendering `SymbolSearch`, even if empty string, so this is compatible).

