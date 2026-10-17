/**
 * D14 — a project's icon: the user's emoji, or an app glyph with an optional
 * palette colour; unset = a neutral cube glyph (NEVER initials — the owner
 * found the "OW / BS / MO" circles look-alike and cramped).
 *
 * Same value shape and glyph names as the desktop host
 * (desktop/src/renderer/src/host/projectIcons.ts + ui/ProjectIcon.tsx), stored
 * per PROJECT in `containers.icon` (cloud/projects/projectIcons.ts), so a
 * project shows the same icon to everyone, in the portal and the desktop app. Glyph paths
 * are Lucide's (ISC licence) — the icon set the desktop draws them from.
 */
import { useSyncExternalStore, type CSSProperties } from "react";
import { AVATAR_HUES } from "./Avatar";
import { StatusGlyph } from "./StatusIcon";
import { projectIcons, subscribeProjectIcons, type GlyphName, type ProjectIconValue } from "../../cloud/projects/projectIcons";

export type { ProjectIconValue, GlyphName };

/** Lucide 24×24 path data per glyph name (stroke = currentColor). */
export const GLYPH_PATHS: Record<GlyphName, string> = {
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  flask: '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  briefcase: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  gamepad: '<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.55-.6-6.58-.69-7.26A4 4 0 0 0 17.32 5z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
};

/** Extra search words per glyph (the name itself always matches). */
export const GLYPH_WORDS: Partial<Record<GlyphName, string>> = {
  box: "cube package default", code: "dev brackets", terminal: "cli shell", globe: "web world site",
  smartphone: "mobile phone app ios android", server: "backend api", database: "db data sql",
  cpu: "chip hardware", bot: "ai robot agent", zap: "fast lightning", flask: "lab science experiment",
  shield: "security", book: "docs documentation", briefcase: "work business", cart: "shop store commerce",
  gamepad: "game", chart: "analytics metrics", mail: "email",
};

/** A glyph colour from the shared avatar palette (D13 hues), tuned for a stroke on the dark canvas —
 *  identical to the desktop's glyphColor(). null = neutral (inherits the muted text colour). */
export function glyphColor(slot: number | null | undefined): string | undefined {
  if (slot == null) return undefined;
  const n = AVATAR_HUES.length;
  return `hsl(${AVATAR_HUES[((slot % n) + n) % n]} var(--v2-hue-glyph-s, 70%) var(--v2-hue-glyph-l, 70%))`; // tone per theme (v2-tokens.css)
}

/** Subscribe to the shared project-icon map (re-renders on any pick, local or from the server sync). */
export function useProjectIcons(): Record<string, ProjectIconValue> {
  return useSyncExternalStore(subscribeProjectIcons, projectIcons, projectIcons);
}
/** One project's icon (null = default glyph). */
export function useProjectIcon(cid: string | null | undefined): ProjectIconValue | null {
  const map = useProjectIcons();
  return cid ? map[cid] ?? null : null;
}

export function GlyphSvg({ name, size, color, className }: { name: GlyphName; size: number; color?: string; className?: string }) {
  return (
    <svg
      className={"v2-picon-glyph" + (className ? " " + className : "")} viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={color ? { color } : undefined}
      dangerouslySetInnerHTML={{ __html: GLYPH_PATHS[name] }}
    />
  );
}

const QUIET = new Set(["active", "running", "live"]);

/**
 * Presentational icon. `icon` undefined = read the stored icon for `cid`;
 * null = force the default. A non-quiet project status (stopped, error…) shows
 * the status glyph at the bottom-right, ringed in the surface colour.
 */
export function ProjectIcon({ cid, icon, size = 18, status, badge, className, style, title }: {
  cid?: string | null;
  icon?: ProjectIconValue | null;
  size?: 14 | 16 | 18 | 20 | 24 | 32;
  status?: string | null;
  /** tiny accent dot top-right (the rail's "needs you" marker); the count rides in data-count */
  badge?: string | null;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const stored = useProjectIcon(icon === undefined ? cid : null);
  const v = icon === undefined ? stored : icon;
  const glyph = Math.round(size * 0.8);
  const s = status || null;
  return (
    <span
      className={"v2-picon" + (className ? " " + className : "")}
      aria-hidden={title ? undefined : true}
      title={title}
      data-icon={v ? `${v.kind}:${v.value}` : "default"}
      style={{ position: "relative", display: "inline-grid", placeItems: "center", flex: "none", width: size, height: size, lineHeight: 1, ...style }}
    >
      {v?.kind === "emoji" ? (
        <span className="v2-picon-emoji" style={{ fontSize: Math.round(size * 0.86), lineHeight: 1, fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif' }}>{v.value}</span>
      ) : (
        <GlyphSvg
          name={v?.kind === "glyph" ? v.value : "box"} size={glyph}
          color={(v?.kind === "glyph" ? glyphColor(v.color) : undefined) ?? "var(--v2-text-2)"}
        />
      )}
      {s && !QUIET.has(s) ? (
        <span className="v2-picon-status" style={{ position: "absolute", right: -4, bottom: -4, padding: 1, borderRadius: "50%", background: "var(--v2-av-ring, var(--v2-sidebar))", lineHeight: 0 }}>
          <StatusGlyph status={s} size={8} />
        </span>
      ) : null}
      {badge ? (
        <span className="v2-picon-badge" data-count={badge} style={{ position: "absolute", top: -2, right: -2, width: 6, height: 6, borderRadius: "50%", background: "var(--v2-accent)", boxShadow: "0 0 0 2px var(--v2-av-ring, var(--v2-sidebar))", pointerEvents: "none" }} />
      ) : null}
    </span>
  );
}
