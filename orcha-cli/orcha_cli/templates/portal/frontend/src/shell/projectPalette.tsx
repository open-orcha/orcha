/**
 * D13: ONE project → colour map for every shell surface (sidebar, header
 * crumb, ⌘K palette). The slots are `assignPalette()` over the SAME ordered
 * project list the sidebar renders (pinned first, local order, server order;
 * the open project prepended when the list doesn't have it yet), so a project
 * has one colour everywhere and no two projects in the list collide.
 *
 * Review (round 2, B1): the header and palette used the raw hashed slot while
 * the sidebar used the collision-free one — "mobile" shared orcha-web's green
 * in the palette. Every surface now reads the slot from here.
 */
import { ProjectIcon } from "../components/primitives/ProjectIcon";
import { orderProjects, type ProjectRow } from "../state/projects";
import { rowPaletteSlots, useProjectPalette } from "../cloud/projects/palette";

/** The sidebar's row order (pure, tested). */
export function paletteRows(list: ProjectRow[] | null, current: ProjectRow | null): ProjectRow[] {
  let rows: ProjectRow[] = list ? orderProjects(list) : current ? [current] : [];
  if (list && current && !list.some((r) => r.id === current.id)) rows = [current, ...rows];
  return rows;
}

/** Container id → collision-free palette slot (pure, tested) — the ONE core assignment. */
export function projectPaletteSlots(rows: ProjectRow[]): Map<string, number> {
  return rowPaletteSlots(rows);
}

/** The shared map for the current project list — single implementation in cloud/projects/palette. */
export { useProjectPalette };

/**
 * The project's face on shell surfaces (header crumb, ⌘K palette) — D14: the
 * user-chosen project icon (emoji / glyph + colour), else the neutral default
 * glyph; never initials. `palette` is kept for call-site compatibility (the
 * D13 slot still colours agent avatars, not project icons).
 */
export function ProjectFace({ id, className }: { name: string; id?: string | null; palette?: number; className?: string }) {
  return <ProjectIcon cid={id ?? null} size={16} className={className} />;
}
