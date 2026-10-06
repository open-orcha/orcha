/**
 * D13 — ONE project → palette-slot assignment for every surface (sidebar,
 * header crumb, ⌘K palette, All projects). Slots are collision-free across the
 * WHOLE project list (assignPalette), so they depend on the list and its order;
 * this module is the single place that computes them, exactly the way the
 * sidebar does: the shared store's list in orderProjects() order (pinned, then
 * local manual order, then server order), with the scoped project prepended
 * when the list does not contain it.
 */
import { useMemo } from "react";
import { assignPalette, paletteIndex, projectAvatarKey } from "../../components/primitives/Avatar";
import { getProjectsState, orderProjects, pinnedProjects, projectOrder, useProjectPrefsVersion, type ProjectRow } from "../../state/projects";
import { useSnapshot } from "../../state/SnapshotProvider";

export interface ScopedProject { id: string; name?: string | null }

/** Pure core (the ONE assignment): id → collision-free slot for rows already in
 *  display order. Every project-colour helper (sidebar, header, ⌘K, Needs,
 *  All projects) funnels through here. */
export function rowPaletteSlots(rows: readonly { id: string | number; name?: string | null }[]): Map<string, number> {
  const keyed = rows.map((r) => [String(r.id), projectAvatarKey(r.name || "", String(r.id))] as const);
  const m = assignPalette(keyed.map(([, k]) => k));
  return new Map(keyed.map(([id, k]) => [id, m.get(k) as number]));
}

/** Pure: id → slot for every project shown together (sidebar order). */
export function projectPaletteSlots(
  list: ProjectRow[] | null | undefined,
  current?: ScopedProject | null,
  pinned: string[] = pinnedProjects(),
  order: string[] = projectOrder(),
): Map<string, number> {
  let rows: ProjectRow[] = list ? orderProjects(list, pinned, order) : current ? [current] : [];
  if (list && current && !list.some((r) => String(r.id) === String(current.id))) rows = [current, ...rows];
  return rowPaletteSlots(rows);
}

/** The slot for one project: its list slot, else its hashed slot (never undefined). */
export function projectPaletteSlot(slots: Map<string, number>, name: string, id?: string | null): number {
  const s = id != null ? slots.get(String(id)) : undefined;
  return s ?? paletteIndex(projectAvatarKey(name || "", id));
}

let memo: { list: ProjectRow[] | null; cur: string; ver: number; slots: Map<string, number> } | null = null;

/**
 * Hook: the shared slot map. Reads the project store WITHOUT subscribing to it
 * (subscribing would start the store's fetch/poll from every avatar); the
 * sidebar keeps the store warm, and callers re-render on the snapshot cadence.
 * Local pin/order changes re-render through the prefs version.
 */
export function useProjectPalette(): Map<string, number> {
  const ver = useProjectPrefsVersion();
  const { cid, snap } = useSnapshot();
  const list = getProjectsState().list;
  const curName = snap?.container?.name ?? null;
  const curKey = cid ? `${cid}\u0000${curName ?? ""}` : "";
  return useMemo(() => {
    if (memo && memo.list === list && memo.cur === curKey && memo.ver === ver) return memo.slots;
    const slots = projectPaletteSlots(list, cid ? { id: String(cid), name: curName } : null);
    memo = { list, cur: curKey, ver, slots };
    return slots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, curKey, ver]);
}

/** test hook */
export function _resetProjectPaletteForTests(): void { memo = null; }
