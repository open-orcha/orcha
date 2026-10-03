/**
 * D14 — the project-icon store. CANONICAL server store: the per-PROJECT
 * `containers.icon` column (mig 050), written through
 * PUT /api/containers/{cid}/icon {icon} and read from the `icon` field on
 * GET /api/containers (state/projects.ts) and the snapshot `container`
 * (state/SnapshotProvider.tsx) — everyone on a project sees the same icon, in
 * the portal and (once it reads that field) the desktop app.
 *
 * Shape = desktop/src/renderer/src/host/projectIcons.ts's `ProjectIcon`:
 *   {kind:"emoji", value:"🚀"} | {kind:"glyph", value:<GLYPH_NAMES>, color:0-9|null}
 * (`color` = a slot of the shared avatar palette, D13). Unset = the neutral
 * default glyph, never initials.
 *
 * localStorage mirrors the last known map so the first paint already shows the
 * icons; a server value always wins. A pick paints optimistically; a refused
 * write (403 viewer, 422, older portal) rolls back to the previous icon. Emoji
 * recents are a per-device picker convenience and stay local.
 */
import { registerTestReset } from "../../lib/testResets";

export const GLYPH_NAMES = [
  "box", "folder", "code", "terminal", "rocket", "globe", "smartphone", "server",
  "database", "cloud", "cpu", "bot", "zap", "flask", "shield", "book", "briefcase",
  "cart", "gamepad", "music", "camera", "palette", "heart", "star", "leaf", "wrench",
  "chart", "mail",
] as const;
export type GlyphName = (typeof GLYPH_NAMES)[number];
export type ProjectIconValue =
  | { kind: "emoji"; value: string }
  | { kind: "glyph"; value: GlyphName; color: number | null };

export const PROJECT_ICONS_KEY = "orcha:v2:projectIcons";
export const EMOJI_RECENTS_KEY = "orcha:v2:emojiRecents";
export const EMOJI_RECENTS_MAX = 16;
const EMOJI_MAX_LEN = 16;
export const ICON_COLORS = 10; // AVATAR_HUES.length

function lsGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}

export function isEmoji(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= EMOJI_MAX_LEN
    && /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(v)
    && !/[A-Za-z<>&"']/.test(v);
}

/** Validate one stored / incoming icon (never trust storage); null = malformed. */
export function parseProjectIcon(raw: unknown): ProjectIconValue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { kind?: unknown; value?: unknown; color?: unknown };
  if (r.kind === "emoji" && isEmoji(r.value)) return { kind: "emoji", value: r.value };
  if (r.kind === "glyph" && typeof r.value === "string" && (GLYPH_NAMES as readonly string[]).includes(r.value)) {
    const c = r.color;
    const color = typeof c === "number" && Number.isInteger(c) && c >= 0 && c < ICON_COLORS ? c : null;
    return { kind: "glyph", value: r.value as GlyphName, color };
  }
  return null;
}

function parseIconMap(raw: unknown): Record<string, ProjectIconValue> {
  const out: Record<string, ProjectIconValue> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const icon = parseProjectIcon(v);
    if (icon) out[k] = icon;
  }
  return out;
}

let _iconsCache: Record<string, ProjectIconValue> | null = null;
/** cid → in-flight writes; while > 0 a server read never overwrites the optimistic pick */
const _pending = new Map<string, number>();
const _iconListeners = new Set<() => void>();
function notifyIcons(): void { _iconListeners.forEach((f) => { try { f(); } catch { /* listener */ } }); }

/** The current icon map (server values mirrored locally). Stable identity between writes. */
export function projectIcons(): Record<string, ProjectIconValue> {
  if (_iconsCache) return _iconsCache;
  let raw: unknown = null;
  try { raw = JSON.parse(lsGet(PROJECT_ICONS_KEY) || "null"); } catch { raw = null; }
  _iconsCache = parseIconMap(raw);
  return _iconsCache;
}
function writeLocalIcons(map: Record<string, ProjectIconValue>): void {
  _iconsCache = map;
  lsSet(PROJECT_ICONS_KEY, JSON.stringify(map));
  notifyIcons();
}
export function subscribeProjectIcons(f: () => void): () => void {
  _iconListeners.add(f);
  return () => { _iconListeners.delete(f); };
}

function same(a: ProjectIconValue | undefined, b: ProjectIconValue | null): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.value === b.value
    && (a.kind === "glyph" ? a.color === (b as { color: number | null }).color : true);
}

/**
 * SERVER WINS: fold the `icon` field of container rows (the list or a snapshot
 * `container`) into the map. A row WITHOUT the key (an older portal) is
 * ignored, so a local pick stands; a cid with a write in flight is skipped.
 */
export function applyContainerIcons(rows: ReadonlyArray<{ id?: unknown; icon?: unknown } | null | undefined>): void {
  let next: Record<string, ProjectIconValue> | null = null;
  const cur = projectIcons();
  for (const row of rows) {
    if (!row || row.id == null || !("icon" in row)) continue;
    const cid = String(row.id);
    if (_pending.get(cid)) continue;
    const icon = row.icon == null ? null : parseProjectIcon(row.icon);
    if (same(cur[cid], icon)) continue;
    next = next || { ...cur };
    if (icon) next[cid] = icon; else delete next[cid];
  }
  if (next) writeLocalIcons(next);
}

function setLocal(cid: string, icon: ProjectIconValue | null): void {
  const next = { ...projectIcons() };
  if (icon) next[cid] = icon; else delete next[cid];
  writeLocalIcons(next);
}

/** Set (or with null, reset to the default glyph) one project's icon — fire and forget. */
export function setProjectIcon(cid: string, icon: ProjectIconValue | null): void {
  void saveProjectIcon(cid, icon);
}

/** Outcome of an icon write; `message` is user-facing when `ok` is false. */
export interface IconSaveResult { ok: boolean; message?: string }

function iconSaveMessage(status: number): string {
  if (status === 401 || status === 403) return "You don't have permission to change this project's icon.";
  if (status === 404 || status === 405) return "This project's Embodent doesn't support shared icons yet. Update it to change icons.";
  if (status === 422) return "That icon can't be used. Pick another one.";
  return "Couldn't save the icon. Try again.";
}

/**
 * setProjectIcon, awaitable with a reason: paints now, then PUTs. Any failure
 * (refused OR unreachable) restores the previous icon — a pick the project
 * doesn't have must never stay on screen — and reports why, so the picker can
 * say so instead of silently snapping back.
 */
export function saveProjectIconResult(cid: string, icon: ProjectIconValue | null, actorAgentId?: string | null): Promise<IconSaveResult> {
  const valid = icon ? parseProjectIcon(icon) : null;
  const prev = projectIcons()[cid] ?? null;
  setLocal(cid, valid);
  if (valid?.kind === "emoji") pushEmojiRecent(valid.value);
  if (typeof fetch !== "function") return Promise.resolve({ ok: false, message: iconSaveMessage(0) });
  _pending.set(cid, (_pending.get(cid) || 0) + 1);
  const body: Record<string, unknown> = { icon: valid };
  if (actorAgentId) body.actor_agent_id = actorAgentId;
  const rollback = () => { if (same(projectIcons()[cid], valid)) setLocal(cid, prev); };
  return fetch("/api/containers/" + encodeURIComponent(cid) + "/icon", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r): Promise<IconSaveResult> => {
    if (!r.ok) { rollback(); return { ok: false, message: iconSaveMessage(r.status) }; }
    const d = (await r.json().catch(() => null)) as { icon?: unknown } | null;
    if (d && "icon" in d && same(projectIcons()[cid], valid)) setLocal(cid, d.icon == null ? null : parseProjectIcon(d.icon));
    return { ok: true };
  }).catch((): IconSaveResult => {
    rollback();
    return { ok: false, message: "Couldn't reach Embodent. Check your connection and try again." };
  }).finally(() => {
    const n = (_pending.get(cid) || 1) - 1;
    if (n > 0) _pending.set(cid, n); else _pending.delete(cid);
  });
}

/** saveProjectIconResult reduced to stored / not stored. */
export function saveProjectIcon(cid: string, icon: ProjectIconValue | null, actorAgentId?: string | null): Promise<boolean> {
  return saveProjectIconResult(cid, icon, actorAgentId).then((r) => r.ok);
}

export function emojiRecents(): string[] {
  try {
    const v = JSON.parse(lsGet(EMOJI_RECENTS_KEY) || "[]");
    return Array.isArray(v) ? v.filter(isEmoji).slice(0, EMOJI_RECENTS_MAX) : [];
  } catch { return []; }
}
/** Most-recent-first, de-duplicated, capped (this browser only). */
export function pushEmojiRecent(emoji: string): void {
  if (!isEmoji(emoji)) return;
  const next = [emoji, ...emojiRecents().filter((e) => e !== emoji)].slice(0, EMOJI_RECENTS_MAX);
  lsSet(EMOJI_RECENTS_KEY, JSON.stringify(next));
}

/** test hook */
export function _resetProjectIconsForTests(): void {
  _iconsCache = null;
  _pending.clear();
}
registerTestReset(_resetProjectIconsForTests);
