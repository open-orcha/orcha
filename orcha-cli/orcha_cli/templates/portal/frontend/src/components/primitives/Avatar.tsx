/**
 * D7 avatars (Linear). Every agent and human avatar is a CIRCLE; sizes are
 * 16 / 20 / 24 / 32 (48 for a rare hero). Identity colour is a flat, muted
 * hue hashed from the alias (never a gradient). Badges carry a ring in the
 * host surface colour (`--v2-av-ring`, default the panel surface), and each
 * corner means ONE thing on every surface (r3):
 *   - bottom-right = `status` → a presence dot (working / waiting / error /
 *     idle …), for humans and agents alike
 *   - top-right    = AI kind  → a tiny sparkle glyph (a badge, NOT a shape
 *     change); shown at ≥ 20 px, dropped at 16 px (too small to read) unless
 *     `showKind` forces it
 *   - `kind="system"` (or alias "system" with no kind) → a neutral circle with
 *     a gear glyph (never an empty 4 px dot).
 * Status is never colour-only: the exact STAT label is in the accessible name
 * and the tooltip.
 *
 * `AvatarStack` overlaps avatars by 4 px (+N overflow, full list in tooltip).
 * `kind="project"` is round too (desktop parity) and shows TWO initials
 * ("billing-service" → "BS").
 *
 * D13 colour parity with the desktop app: the identity colour comes from the
 * SAME fixed 10-hue palette and FNV-1a slot hash as
 * desktop/src/renderer/src/ui/Avatar.tsx (AVATAR_HUES / paletteIndex /
 * assignPalette), so one agent or project has one colour in both apps. Lists
 * that show several actors together pass `palette` slots from
 * `assignPalette()` so no two neighbours collide.
 */
import { useState } from "react";
import { useSnapshot } from "../../state/SnapshotProvider";
import { statusMeta } from "../../lib/status";

export type AvatarKind = "ai" | "human" | "project" | "system";
export type AvatarSize = 16 | 20 | 24 | 32 | 48;
/** Named aliases kept for legacy call sites: xs 16 · sm 20 · md 24 · lg 32 · xl 48. */
export type AvatarSizeName = "xs" | "sm" | "md" | "lg" | "xl";

const NAMED: Record<AvatarSizeName, AvatarSize> = { xs: 16, sm: 20, md: 24, lg: 32, xl: 48 };
export function avatarPx(size: number | AvatarSizeName | string | undefined | null): AvatarSize {
  if (typeof size === "number") return ([16, 20, 24, 32, 48] as number[]).includes(size) ? (size as AvatarSize) : 24;
  return NAMED[(size || "md") as AvatarSizeName] ?? 24;
}

/** Presence tone for the status badge dot (shape/label carry the meaning; hue supports it). */
export type PresenceTone = "live" | "wait" | "bad" | "idle" | "done";
export function presenceTone(status: string | null | undefined): PresenceTone {
  switch (status) {
    case "working": case "in_progress": case "active": case "live": case "running":
      return "live";
    case "awaiting_request": case "awaiting_human": case "needs_verification": case "open": case "escalated":
      return "wait";
    case "blocked": case "failed": case "terminated": case "error": case "rejected":
      return "bad";
    case "completed": case "answered": case "verified":
      return "done";
    default:
      return "idle";
  }
}

/* ---- D13 palette (identical to the desktop renderer's ui/Avatar.tsx) ---- */
/** Ten well-separated hues (≥ 20° apart, most ≥ 30°), one lightness. */
export const AVATAR_HUES = [4, 30, 50, 95, 145, 178, 208, 238, 272, 318] as const;

export interface AvatarColors { background: string; color: string }

/** Palette slot → flat fill + tinted initial (≥ 4.5:1 for every slot, both themes).
 *  The hue is the slot's; saturation/lightness come from theme tokens
 *  (--v2-av-fill-* / --v2-av-ink-*, v2-tokens.css) so avatars re-tone live on a
 *  theme switch without a re-render. Fallbacks = the dark values. */
export function paletteColor(index: number): AvatarColors {
  const n = AVATAR_HUES.length;
  const h = AVATAR_HUES[((index % n) + n) % n];
  return {
    background: `hsl(${h} var(--v2-av-fill-s, 34%) var(--v2-av-fill-l, 28%))`,
    color: `hsl(${h} var(--v2-av-ink-s, 72%) var(--v2-av-ink-l, 86%))`,
  };
}

/** Stable slot for a key (FNV-1a, same offset basis as the desktop). */
export function paletteIndex(key: string): number {
  let h = 0x1f54177e;
  for (const c of key) {
    h ^= c.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % AVATAR_HUES.length;
}

/** Collision-free slots for everything shown together: each key takes its
 *  hashed slot, or the next free one (wraps only once the palette is used up). */
export function assignPalette(keys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const key of keys) {
    if (out.has(key)) continue;
    let slot = paletteIndex(key);
    if (used.size < AVATAR_HUES.length) {
      while (used.has(slot)) slot = (slot + 1) % AVATAR_HUES.length;
    }
    used.add(slot);
    out.set(key, slot);
  }
  return out;
}

/** Palette key for an actor (alias without a leading "@"). */
export function actorKey(alias: string | null | undefined): string {
  return (alias || "").trim().replace(/^@/, "");
}
/** Palette key for a project (name + container id), same as the desktop. */
export function projectAvatarKey(name: string, seed?: string | null): string {
  return `${name}\u0000${seed ?? ""}`;
}

/** An actor's identity colours (its palette slot, or the hashed one). */
export function avatarColors(alias: string | null | undefined, index?: number): AvatarColors {
  return paletteColor(index ?? paletteIndex(actorKey(alias)));
}
/** Identity fill colour (legacy string form). */
export function avatarColor(alias: string | null | undefined, index?: number): string {
  return avatarColors(alias, index).background;
}
export function avatarInitial(alias: string | null | undefined): string {
  const s = (alias || "?").trim().replace(/^@/, "");
  return (s.charAt(0) || "?").toUpperCase();
}
/** Up to two initials ("billing-service" → "BS", "orcha" → "OR"). */
export function projectInitials(name: string | null | undefined): string {
  const words = (name || "").trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/* ---- D13 one roster palette per project ------------------------------------
 * Surfaces used to call assignPalette() over THEIR OWN list (board: all agents,
 * sidebar: live agents only, popovers: none), so one agent could get a
 * different colour per surface. Every actor Avatar now takes its slot from ONE
 * assignment over the current project's full roster (snap.agents, snapshot
 * order — the same map as shell/nav.ts agentPaletteSlots). That slot WINS over
 * a local `palette` prop: a collision-free assignment over the full roster is
 * also collision-free on any subset, so lists stay unique AND consistent.
 * Aliases outside the roster fall back to the prop, then to the hash. */
const rosterCache = new WeakMap<readonly unknown[], Map<string, number>>();
/** Slot map for a roster (memoised per snapshot agents array). */
export function rosterPaletteSlots(agents: readonly { alias?: string | null; github_login?: string | null }[] | null | undefined): Map<string, number> | null {
  if (!agents || !agents.length) return null;
  let m = rosterCache.get(agents);
  if (!m) {
    m = assignPalette(agents.map((a) => actorKey(a.alias)));
    // A human is sometimes named by GitHub login (Members, GitHub) and
    // sometimes by alias (sidebar "Acting as", rails): the login resolves to
    // the SAME slot, so one person has one colour everywhere (D13). A login
    // that is also someone else's alias never overrides that alias.
    for (const a of agents) {
      const login = actorKey(a.github_login);
      const slot = m.get(actorKey(a.alias));
      if (login && slot !== undefined && !m.has(login)) m.set(login, slot);
    }
    rosterCache.set(agents, m);
  }
  return m;
}
function useRosterSlots(): Map<string, number> | null {
  return rosterPaletteSlots(useSnapshot().snap?.agents);
}
/** The project roster's slot for an alias (undefined when not in the roster). */
export function useActorPalette(alias: string | null | undefined): number | undefined {
  return useRosterSlots()?.get(actorKey(alias));
}

export interface AvatarActor {
  alias: string | null | undefined;
  kind?: AvatarKind | string | null;
  ghLogin?: string | null;
  status?: string | null;
  /** Page-level palette slot (assignPalette); stacks keep it so a card's
   *  avatar matches the same actor's column header. */
  palette?: number;
}

export interface AvatarProps extends AvatarActor {
  size?: AvatarSize | AvatarSizeName;
  /** Show the AI sparkle badge, top-right (default: AI actors at ≥ 20 px). */
  showKind?: boolean;
  /** Tooltip / accessible-name override (default "alias · AI agent · Working"). */
  label?: string;
  /** Hide from assistive tech when the name is already printed right next to it. */
  decorative?: boolean;
  /** Palette slot from `assignPalette()` (lists: no two neighbours share a colour). */
  palette?: number;
  /** Projects: extra hash input (the container id), as on the desktop. */
  seed?: string | null;
  className?: string;
}

function kindWord(kind: string | null | undefined): string | null {
  if (kind === "human") return "Human";
  if (kind === "ai") return "AI agent";
  if (kind === "project") return "Project";
  return null;
}

function Sparkle() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M5 .9 6.05 3.95 9.1 5 6.05 6.05 5 9.1 3.95 6.05.9 5 3.95 3.95z" fill="currentColor" />
    </svg>
  );
}

/** System actor glyph: a small gear (neutral; the system is not a person or an agent). */
function Gear() {
  return (
    <svg className="v2-av-sys" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 1.9l1.1.2.3 1.5 1 .5 1.3-.8 1.5 1.5-.8 1.3.5 1 1.5.3v2.2l-1.5.3-.5 1 .8 1.3-1.5 1.5-1.3-.8-1 .5-.3 1.5H6.9l-.3-1.5-1-.5-1.3.8-1.5-1.5.8-1.3-.5-1-1.5-.3V6.9l1.5-.3.5-1-.8-1.3 1.5-1.5 1.3.8 1-.5.3-1.5z"
        fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round"
      />
      <circle cx={8} cy={8} r={2} fill="none" stroke="currentColor" strokeWidth={1.3} />
    </svg>
  );
}

/** Resolve the effective kind: explicit kinds win; a bare "system" alias is the system actor. */
export function avatarKind(kind: string | null | undefined, alias: string | null | undefined): AvatarKind | null {
  if (kind === "human" || kind === "project" || kind === "system" || kind === "ai") return kind;
  if (kind == null && (alias || "").trim().toLowerCase() === "system") return "system";
  return null;
}

const GH_LOGIN = /^[A-Za-z0-9-]+$/;

export function Avatar({ alias, kind, ghLogin, status, size, showKind, label, decorative, palette, seed, className }: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const roster = useRosterSlots();
  const px = avatarPx(size);
  const k = avatarKind(kind, alias);
  const name = (alias || "").trim() || (ghLogin || "").trim() || "Unknown";
  const statusLabel = status ? statusMeta(status).l : null;
  const text = label ?? [name, kindWord(k), statusLabel].filter(Boolean).join(" · ");
  const hasStatus = !!status && k !== "project" && k !== "system";
  const tone = hasStatus ? presenceTone(status) : null;
  // AI kind badge: its own corner (top-right) at ≥ 20 px; the status dot
  // always owns bottom-right, so a corner never changes meaning between pages.
  const sparkle = k === "ai" && showKind !== false && (showKind ?? px >= 20);
  const login = (ghLogin || "").trim();
  const useImg = !!login && !imgFailed && GH_LOGIN.test(login) && k !== "project" && k !== "system";

  const cls = [
    "av", "v2-av", `v2-av-${px}`,
    k === "human" ? "human" : "",
    k === "project" ? "v2-av-project" : "",
    k === "system" ? "v2-av-system" : "",
    className || "",
  ].filter(Boolean).join(" ");

  return (
    <span
      className={cls}
      style={k === "system"
        ? undefined
        : k === "project"
        ? paletteColor(palette ?? paletteIndex(projectAvatarKey(name, seed)))
        : avatarColors(alias || login, roster?.get(actorKey(alias || login)) ?? palette)}
      title={text}
      data-kind={k || undefined}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": text })}
    >
      {useImg ? (
        <img className="v2-av-img" src={`https://github.com/${login}.png?size=64`} alt="" onError={() => setImgFailed(true)} />
      ) : k === "system" ? (
        <Gear />
      ) : (
        <span className="v2-av-init" aria-hidden="true">{k === "project" ? projectInitials(name) : avatarInitial(alias || login)}</span>
      )}
      {hasStatus ? <span className={`v2-av-badge v2-av-dot is-${tone}`} aria-hidden="true" /> : null}
      {sparkle ? <span className="v2-av-badge v2-av-spark" aria-hidden="true"><Sparkle /></span> : null}
    </span>
  );
}

export interface AvatarStackProps {
  actors: AvatarActor[];
  size?: AvatarSize | AvatarSizeName;
  /** Avatars shown before collapsing into "+N" (default 3). */
  max?: number;
  /** Prefix for the accessible name, e.g. "Assignees" → "Assignees: lead, qa-bot". */
  label?: string;
  className?: string;
}

/** Overlapping (-4 px) circles; overflow collapses to "+N"; full list in the tooltip. */
export function AvatarStack({ actors, size = 20, max = 3, label, className }: AvatarStackProps) {
  const list = actors.filter((a) => (a.alias || a.ghLogin || "").trim());
  if (!list.length) return null;
  const px = avatarPx(size);
  const shown = list.slice(0, Math.max(1, max));
  const extra = list.length - shown.length;
  const names = list.map((a) => (a.alias || a.ghLogin || "").trim()).join(", ");
  const slots = assignPalette(list.map((a) => actorKey(a.alias || a.ghLogin)));
  const text = label ? `${label}: ${names}` : names;
  return (
    <span className={`v2-avstack v2-avstack-${px}${className ? " " + className : ""}`} role="img" aria-label={text} title={text}>
      {shown.map((a, i) => (
        <Avatar key={(a.alias || a.ghLogin || "") + i} {...a} status={null} size={px} showKind={false} decorative palette={a.palette ?? slots.get(actorKey(a.alias || a.ghLogin))} />
      ))}
      {extra > 0 ? <span className="v2-avstack-more" aria-hidden="true">+{extra}</span> : null}
    </span>
  );
}
