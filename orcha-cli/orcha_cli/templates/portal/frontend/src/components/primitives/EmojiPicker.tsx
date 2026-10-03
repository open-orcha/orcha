/**
 * D14 — the project-icon picker (Linear/Notion style popover):
 *   Emoji tab: search (name words, prefix match) · Recent · grouped grid; any
 *     emoji typed / pasted / picked with the OS picker (⌃⌘Space, Win+.) into
 *     the search field is offered as the first result.
 *   Icons tab: the app glyph set (same names as the desktop) + an optional
 *     colour from the shared avatar palette (D13). A glyph pick saves but keeps
 *     the picker open so a colour can follow (glyph → colour in one visit).
 *   Reset → back to the neutral default glyph.
 * Keyboard: search is focused on open, ↓ enters the grid, arrows move by
 * cell / row, Enter picks, Escape closes (focus returns to the anchor).
 *
 * `ProjectIconPicker` wires it to the per-project store (projectIcons.saveProjectIconResult) —
 * the sidebar ⋯ menu and the project Settings entry point both use it. It is
 * gated like the backend (owner / manage_autonomy; trust off open — see
 * ./projectIconAuthority): someone who can't change the icon is told why
 * instead of being offered a grid whose every pick would be refused.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Popover } from "./Menu";
import { AVATAR_HUES } from "./Avatar";
import { GlyphSvg, GLYPH_WORDS, glyphColor, useProjectIcon } from "./ProjectIcon";
import { emojiGroups, searchEmoji, type EmojiEntry } from "./EmojiPickerData";
import { useProjectIconAuthority } from "./projectIconAuthority";
import {
  GLYPH_NAMES, emojiRecents, isEmoji, saveProjectIconResult,
  type GlyphName, type ProjectIconValue,
} from "../../cloud/projects/projectIcons";

type Tab = "emoji" | "glyph";

export const EMOJI_PICKER_CSS = `
.v2-popover.v2-epick-pop { padding: 0; border: 0; background: transparent; box-shadow: none; overflow: visible; max-width: calc(100vw - 16px); }
.v2-epick { width: 320px; max-width: calc(100vw - 16px); padding: 8px; display: flex; flex-direction: column; gap: 8px;
  background: var(--v2-raised, #1c1d21); border: 1px solid var(--v2-border-strong); border-radius: 10px; box-shadow: var(--v2-shadow-pop); }
.v2-epick-top { display: flex; align-items: center; gap: 4px; }
.v2-epick-tab { height: 24px; padding: 0 10px; border: 0; border-radius: 999px; background: transparent; color: var(--v2-text-3);
  font: 500 12px var(--v2-font-sans); cursor: pointer; }
.v2-epick-tab:hover { background: var(--v2-hover); color: var(--v2-text); }
.v2-epick-tab[aria-selected="true"] { background: var(--v2-selected); color: var(--v2-text); }
.v2-epick-reset { margin-left: auto; height: 24px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent;
  color: var(--v2-text-3); font: 500 12px var(--v2-font-sans); cursor: pointer; }
.v2-epick-reset:hover { background: var(--v2-hover); color: var(--v2-text); }
.v2-epick-search { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; border: 1px solid var(--v2-border);
  border-radius: 7px; background: var(--v2-surface); }
.v2-epick-search:focus-within { border-color: var(--v2-border-strong); }
.v2-epick-search svg { width: 14px; height: 14px; color: var(--v2-text-3); flex: none; }
.v2-epick-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--v2-text); font: 13px var(--v2-font-sans); }
.v2-epick-search input:focus, .v2-epick-search input:focus-visible { outline: none; box-shadow: none; border: 0; }
.v2-epick-search input::placeholder { color: var(--v2-text-3); }
.v2-epick-body { max-height: 244px; min-height: 120px; overflow-y: auto; overscroll-behavior: contain; margin: 0 -2px; padding: 0 2px; }
.v2-epick-sec + .v2-epick-sec { margin-top: 4px; }
.v2-epick-h { padding: 6px 2px 4px; font-size: 11px; font-weight: 500; color: var(--v2-text-3); }
.v2-epick-grid { display: grid; grid-template-columns: repeat(auto-fill, 32px); justify-content: space-between; row-gap: 2px; }
.v2-epick-cell { width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent;
  cursor: pointer; font-size: 19px; line-height: 1; padding: 0; color: var(--v2-text-2);
  font-family: "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif; }
.v2-epick-cell:hover, .v2-epick-cell:focus-visible { background: var(--v2-hover); outline: none; }
.v2-epick-cell:focus-visible { box-shadow: inset 0 0 0 1px var(--v2-accent); }
.v2-epick-cell[aria-pressed="true"] { background: var(--v2-selected); }
.v2-epick-note { padding: 14px 2px; font-size: 12px; color: var(--v2-text-3); }
.v2-epick-colors { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-top: 8px; border-top: 1px solid var(--v2-border); }
.v2-epick-color { width: 22px; height: 22px; display: grid; place-items: center; border: 0; border-radius: 50%; background: transparent; cursor: pointer; padding: 0; }
.v2-epick-color:hover { background: var(--v2-hover); }
.v2-epick-color[aria-checked="true"] { box-shadow: 0 0 0 1px var(--v2-text-2); }
.v2-epick-color:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--v2-accent); }
.v2-epick-color span { width: 12px; height: 12px; border-radius: 50%; }
.v2-epick-color span.is-none { border: 1px solid var(--v2-text-3); }
.v2-epick-hint { font-size: 11px; color: var(--v2-text-3); padding: 0 2px; }
.v2-epick-err { margin: 0; font-size: 12px; line-height: 1.4; color: var(--v2-danger-text, #f2a3a3); padding: 6px 8px; border-radius: 6px; background: var(--v2-danger-soft, rgba(229,72,77,.12)); }
.v2-epick[aria-busy="true"] .v2-epick-cell { cursor: progress; }
.v2-epick-ro { margin: 0; padding: 6px 4px; font-size: 13px; line-height: 1.45; color: var(--v2-text); }
.v2-epick-ro strong { font-weight: 500; }
.v2-epick-ro-why { font-size: 12px; color: var(--v2-text-3); }
@media (pointer: coarse) { .v2-epick-cell { width: 40px; height: 40px; } .v2-epick-grid { grid-template-columns: repeat(auto-fill, 40px); } }
`;

const CELL = 32;

export interface EmojiPickerProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** accessible name, e.g. "Change icon for orcha-web" */
  label: string;
  value: ProjectIconValue | null;
  /** done=false keeps the picker open (glyph picks and colour changes) */
  onPick: (icon: ProjectIconValue, done: boolean) => void;
  onReset: () => void;
  placement?: "bottom-start" | "bottom-end" | "right-start";
  /** user-facing reason the last pick wasn't saved (shown inline, role=alert) */
  error?: string | null;
  /** a pick is being saved */
  busy?: boolean;
  /** set when this person may not change the icon: the picker shows why instead of a grid it can't save */
  readOnlyReason?: string | null;
}

/** Colour-slot names, in AVATAR_HUES order (hues 4 … 318). */
export const HUE_NAMES = ["Red", "Orange", "Amber", "Lime", "Green", "Teal", "Sky", "Blue", "Violet", "Pink"] as const;

function SearchGlyph() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5" /><path d="m13 13 3.5 3.5" />
    </svg>
  );
}

export function EmojiPicker({ anchor, open, onClose, label, value, onPick, onReset, placement = "bottom-start", error = null, busy = false, readOnlyReason = null }: EmojiPickerProps) {
  const close = () => { onClose(); anchor.current?.focus(); };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} role="dialog" label={label} placement={placement} className="v2-epick-pop" trap autoFocus={!!readOnlyReason}>
      {open ? (readOnlyReason
        ? <ReadOnlyBody reason={readOnlyReason} onClose={close} />
        : <PickerBody label={label} value={value} onPick={onPick} onReset={onReset} error={error} busy={busy} onClose={close} />) : null}
    </Popover>
  );
}

function ReadOnlyBody({ reason, onClose }: { reason: string; onClose: () => void }) {
  return (
    <div className="v2-epick" tabIndex={-1}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <style>{EMOJI_PICKER_CSS}</style>
      <p className="v2-epick-ro" role="note"><strong>You can't change this project's icon.</strong><br /><span className="v2-epick-ro-why">{reason}</span></p>
    </div>
  );
}

function PickerBody({ label, value, onPick, onReset, onClose, error, busy }: {
  label: string; value: ProjectIconValue | null; onPick: EmojiPickerProps["onPick"]; onReset: () => void; onClose: () => void;
  error: string | null; busy: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<Tab>(value?.kind === "glyph" ? "glyph" : "emoji");
  const [query, setQuery] = useState("");
  const [color, setColor] = useState<number | null>(value?.kind === "glyph" ? value.color : null);
  const recents = useMemo(() => emojiRecents(), []);
  useEffect(() => { searchRef.current?.focus(); }, []);

  const q = query.trim();
  const typed = isEmoji(q) ? q : null; // a pasted / OS-picker emoji is always usable
  const hits = useMemo(() => (tab === "emoji" && q && !typed ? searchEmoji(q) : []), [q, tab, typed]);
  const glyphs = useMemo(() => GLYPH_NAMES.filter((n) => {
    if (!q) return true;
    const hay = `${n} ${GLYPH_WORDS[n] ?? ""}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }), [q]);

  const cells = (): HTMLElement[] => Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-cell]") ?? []);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    const t = e.target as HTMLElement;
    if (t === searchRef.current) {
      if (e.key === "ArrowDown") { e.preventDefault(); cells()[0]?.focus(); }
      else if (e.key === "Enter") { e.preventDefault(); cells()[0]?.click(); }
      return;
    }
    if (!t.hasAttribute("data-cell") || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const all = cells();
    const i = all.indexOf(t);
    const grid = t.parentElement;
    const cols = Math.max(1, Math.floor(((grid?.clientWidth || CELL * 9) + 1) / CELL));
    const next = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : e.key === "ArrowUp" ? i - cols : i + cols;
    if (next < 0) searchRef.current?.focus();
    else all[Math.min(all.length - 1, next)]?.focus();
  };

  const pickEmoji = (emoji: string) => onPick({ kind: "emoji", value: emoji }, true);
  const emojiCell = (e: EmojiEntry, key: string) => {
    const on = value?.kind === "emoji" && value.value === e.emoji;
    return (
      <button key={key} type="button" data-cell="" className="v2-epick-cell" title={e.name} aria-label={e.name}
        aria-pressed={on} onClick={() => pickEmoji(e.emoji)}>{e.emoji}</button>
    );
  };

  return (
    <div ref={ref} className="v2-epick" onKeyDown={onKeyDown} aria-busy={busy || undefined}>
      {error ? <p className="v2-epick-err" role="alert">{error}</p> : null}
      <style>{EMOJI_PICKER_CSS}</style>
      <div className="v2-epick-top">
        <div role="tablist" aria-label="Icon type" style={{ display: "flex", gap: 4 }}>
          {([["emoji", "Emoji"], ["glyph", "Icons"]] as const).map(([k, text]) => (
            <button key={k} type="button" role="tab" className="v2-epick-tab" aria-selected={tab === k}
              onClick={() => { setTab(k); searchRef.current?.focus(); }}>{text}</button>
          ))}
        </div>
        {value ? <button type="button" className="v2-epick-reset" onClick={onReset}>Reset to default</button> : null}
      </div>
      <label className="v2-epick-search">
        <SearchGlyph />
        <input ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === "emoji" ? "Search or paste an emoji" : "Search icons"}
          aria-label={tab === "emoji" ? "Search emoji" : "Search icons"} autoComplete="off" spellCheck={false} />
      </label>
      <div className="v2-epick-body" aria-label={label}>
        {tab === "emoji" ? (
          typed ? (
            <div className="v2-epick-grid" role="group" aria-label="Typed emoji">{emojiCell({ emoji: typed, name: `Use ${typed}` }, "typed")}</div>
          ) : q ? (
            hits.length ? <div className="v2-epick-grid" role="group" aria-label="Results">{hits.map((e) => emojiCell(e, e.emoji))}</div>
              : <p className="v2-epick-note">No emoji match “{q}”. Paste any emoji here to use it.</p>
          ) : (
            <>
              {recents.length ? (
                <section className="v2-epick-sec" aria-label="Recent">
                  <div className="v2-epick-h">Recent</div>
                  <div className="v2-epick-grid">{recents.map((e) => emojiCell({ emoji: e, name: `Recent: ${e}` }, "r-" + e))}</div>
                </section>
              ) : null}
              {emojiGroups().map((g) => (
                <section key={g.slug} className="v2-epick-sec" aria-label={g.label}>
                  <div className="v2-epick-h">{g.label}</div>
                  <div className="v2-epick-grid">{g.emojis.map((e) => emojiCell(e, g.slug + e.emoji))}</div>
                </section>
              ))}
            </>
          )
        ) : glyphs.length ? (
          <div className="v2-epick-grid" role="group" aria-label="Icons" style={{ paddingTop: 4 }}>
            {glyphs.map((name: GlyphName) => {
              const on = value?.kind === "glyph" && value.value === name;
              return (
                <button key={name} type="button" data-cell="" className="v2-epick-cell" title={name} aria-label={name} aria-pressed={on}
                  onClick={() => onPick({ kind: "glyph", value: name, color }, false)}>
                  <GlyphSvg name={name} size={17} color={glyphColor(color) ?? "var(--v2-text-2)"} />
                </button>
              );
            })}
          </div>
        ) : <p className="v2-epick-note">No icon matches “{q}”.</p>}
      </div>
      {tab === "glyph" ? (
        <div className="v2-epick-colors" role="radiogroup" aria-label="Icon colour">
          {[null, ...AVATAR_HUES.map((_, i) => i)].map((slot) => (
            <button key={slot ?? "none"} type="button" role="radio" className="v2-epick-color" aria-checked={color === slot}
              aria-label={slot === null ? "No colour" : HUE_NAMES[slot] ?? `Colour ${slot + 1}`}
              title={slot === null ? "No colour" : HUE_NAMES[slot] ?? undefined}
              onClick={() => {
                setColor(slot);
                if (value?.kind === "glyph") onPick({ kind: "glyph", value: value.value, color: slot }, false);
              }}>
              <span className={slot === null ? "is-none" : undefined} style={slot === null ? undefined : { background: glyphColor(slot) }} />
            </button>
          ))}
          {value?.kind !== "glyph" ? <span className="v2-epick-hint" style={{ flexBasis: "100%" }}>Pick an icon to apply this colour.</span> : null}
        </div>
      ) : (
        <div className="v2-epick-hint">Tip: paste any emoji, or use your system emoji picker in the search field.</div>
      )}
    </div>
  );
}

/** The picker wired to the per-project icon store (`containers.icon`; portal + desktop share it).
 *  A pick paints at once; the picker closes once the server has stored it and
 *  stays open with the reason when it was refused or unreachable (the icon
 *  snaps back — never a silent revert). */
export function ProjectIconPicker(props: {
  cid: string; name: string; anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void;
  placement?: EmojiPickerProps["placement"];
}) {
  // mounted only while open: a closed row's picker costs nothing and asks nobody
  return props.open ? <OpenProjectIconPicker {...props} /> : null;
}

function OpenProjectIconPicker({ cid, name, anchor, open, onClose, placement }: {
  cid: string; name: string; anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void;
  placement?: EmojiPickerProps["placement"];
}) {
  const value = useProjectIcon(cid);
  const auth = useProjectIconAuthority(cid, open);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const save = (icon: ProjectIconValue | null, closeOnSuccess: boolean) => {
    if (!auth.pending && !auth.canEdit) return; // never fire a write the gate would refuse (pending: the server decides, a refusal is shown)
    const n = ++seq.current;
    setError(null); setBusy(true);
    void saveProjectIconResult(cid, icon, auth.actorId).then((r) => {
      if (n !== seq.current) return; // a newer pick superseded this one
      setBusy(false);
      if (!r.ok) { setError(r.message ?? "Couldn't save the icon. Try again."); return; }
      if (closeOnSuccess) { onClose(); anchor.current?.focus(); }
    });
  };
  return (
    <EmojiPicker
      anchor={anchor} open={open} onClose={onClose} placement={placement}
      label={`Change icon for ${name}`} value={value} error={error} busy={busy}
      readOnlyReason={!auth.pending && !auth.canEdit ? auth.reason || "View-only" : null}
      onPick={(icon, done) => save(icon, done)}
      onReset={() => save(null, true)}
    />
  );
}
