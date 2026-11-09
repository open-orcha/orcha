/**
 * Modifier-click on a scenario node toggles it in the selection (D100).
 *
 * xyflow's own multi-select reads its key from keydown/keyup on the document, not from the
 * click, and was set to Shift only: ⌘-click on a node of a "Select 20 drafts" selection did
 * nothing, and a Shift-click whose keydown the page never saw (a click synthesised with the
 * modifier, a key held while focus was elsewhere) was a plain click on an already-selected node,
 * also nothing. So the canvas decides from the click's own `metaKey`/`ctrlKey`/`shiftKey`, and
 * stops the event before xyflow handles it (capture phase), so the two never disagree.
 */
export interface ModifierEventLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  button?: number;
  target: EventTarget | null;
}

/** The node id a modifier-click (⌘, Ctrl or Shift, primary button) landed on, else null. */
export function modifierClickNodeId(e: ModifierEventLike): string | null {
  if (!(e.metaKey || e.ctrlKey || e.shiftKey)) return null;
  if (e.button !== undefined && e.button !== 0) return null;
  const el = e.target instanceof Element ? e.target.closest(".react-flow__node[data-id]") : null;
  return el?.getAttribute("data-id") ?? null;
}

/** `ids` with `id` added, or removed when it was already selected. */
export function toggleSelection(ids: ReadonlySet<string>, id: string): string[] {
  const next = new Set(ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return [...next];
}

/** The part of an xyflow node change the selection cares about (`NodeSelectionChange`). */
export interface SelectChangeLike {
  type: string;
  id?: string;
  selected?: boolean;
}

/**
 * The selection after xyflow's own `select` changes (a click, a pane click, a box select), or
 * null when the changes do not alter it. The canvas reads the user's selection from these
 * changes rather than from `onSelectionChange`: that callback also fires whenever the node list
 * the canvas passes in changes, so a selection set by the canvas itself (a `?scenario=` link)
 * came straight back as xyflow's view of it, often still empty, and undid or looped it.
 */
export function selectionAfterChanges(current: ReadonlySet<string>, changes: readonly SelectChangeLike[]): string[] | null {
  const next = new Set(current);
  for (const c of changes) {
    if (c.type !== "select" || !c.id) continue;
    if (c.selected) next.add(c.id);
    else next.delete(c.id);
  }
  if (next.size === current.size && [...next].every((id) => current.has(id))) return null;
  return [...next];
}
