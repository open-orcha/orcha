/**
 * GitHub-aware avatar faces — React ports of app-ui.js ghAvatar()/face(),
 * emitting the SAME markup/class names the shared styles.css already styles.
 * Local to the cloud pages (the open ui.tsx only ships the letter Avatar).
 */
import { Avatar } from "../../components/ui";
import { avatarColors, paletteColor, projectInitials as sharedInitials } from "../../components/primitives/Avatar";
import { projectPaletteSlot, useProjectPalette } from "./palette";

export function GhAvatar({ login, size }: { login: string | null | undefined; size?: string }) {
  const colors = avatarColors(login || ""); // D13: desktop palette (flat, no gradients)
  const cls = "av gh" + (size ? " " + size : "") + " human";
  const init = (login || "?").trim().charAt(0).toUpperCase();
  return (
    <span className={cls} style={colors}>
      {init}
      <img
        className="gh-face"
        src={`https://github.com/${encodeURIComponent(login || "")}.png?size=96`}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => e.currentTarget.remove()}
      />
    </span>
  );
}

/* Portal-wide face convention: a HUMAN with a mapped GitHub identity gets their
 * real GitHub profile picture; every AI agent, and any unmapped human, keeps
 * the plain deterministic letter avatar. */
export function Face({ rec, size }: { rec: { kind?: string | null; alias?: string | null; github_login?: string | null }; size?: string }) {
  return rec.kind === "human" && rec.github_login
    ? <GhAvatar login={rec.github_login} size={size} />
    : <Avatar alias={rec.alias} kind={rec.kind} size={size} />;
}

/** Up to two initials from a project name ("billing-service" → "BS", "orcha" → "OR").
 *  One rule for the sidebar, the header and the Avatar primitive. */
export const projectInitials = sharedInitials;

/** Round project avatar (header crumb, ⌘K palette, legacy callers) — a CIRCLE
 *  (D7). D13: the colour is the project's slot in the ONE shared assignment
 *  (palette.ts — the same map the sidebar and All projects use), so a project
 *  has one colour on every surface; pass `palette` to override, `seed` (the
 *  container id) to identify the project. */
export function ProjectAvatar({ name, seed, palette, className }: { name: string; seed?: string | null; palette?: number; className?: string }) {
  const slots = useProjectPalette();
  const slot = palette ?? projectPaletteSlot(slots, name, seed);
  return (
    <span className={"proj-av" + (className ? " " + className : "")} aria-hidden="true" data-palette={slot}
      style={paletteColor(slot)}>
      {projectInitials(name || "?")}
    </span>
  );
}
