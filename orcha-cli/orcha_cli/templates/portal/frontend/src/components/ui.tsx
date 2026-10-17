/**
 * Shared UI primitives — React ports of the app.js helpers, emitting the SAME
 * markup/class names so the untouched styles.css styles them identically:
 * Icon (the I path map), Pill/glyph, Avatar, KindBadge, OrcaMark (the Embodent mark), Md/Linkified
 * (trusted-HTML renderers over lib/format), Modal, and the toast system.
 */
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { linkify, mdText } from "../lib/format";
import { statusMeta } from "../lib/status";
import type { Task } from "../types";
import { trapTab, useFocusReturn } from "./primitives/focus";
import { Avatar as V2Avatar, avatarPx } from "./primitives/Avatar";
import { StatusGlyph } from "./primitives/StatusIcon";

/* ---- icons (verbatim path set from app.js) ------------------------------ */
const I: Record<string, string> = {
  home: '<path d="M3 9.5 10 4l7 5.5V17a1 1 0 0 1-1 1h-3v-5H7v5H4a1 1 0 0 1-1-1z"/>',
  agents: '<circle cx="7" cy="7.5" r="2.6"/><circle cx="13.5" cy="8" r="2.1"/><path d="M2.6 16c.4-2.4 2.2-3.8 4.4-3.8s4 1.4 4.4 3.8M12 12.5c2 .1 3.4 1.4 3.8 3.5"/>',
  tasks: '<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3"/><path d="M6.6 10l2.2 2.2 4.6-4.8"/>',
  requests: '<path d="M5 7h9l-2.4-2.4M15 13H6l2.4 2.4"/>',
  live: '<path d="M2.5 10h3l2-5 3 10 2-7 1.5 2h3.5"/>',
  search: '<circle cx="8.5" cy="8.5" r="5"/><path d="m13 13 3.5 3.5"/>',
  mic: '<rect x="7.25" y="2.75" width="5.5" height="9.5" rx="2.75"/><path d="M4.75 9.5a5.25 5.25 0 0 0 10.5 0M10 14.75v2.5"/>',
  bell: '<path d="M6 9a4 4 0 0 1 8 0c0 3 1.2 4 1.8 4.6.3.3.1.9-.4.9H4.6c-.5 0-.7-.6-.4-.9C4.8 13 6 12 6 9z"/><path d="M8.4 17a1.8 1.8 0 0 0 3.2 0"/>',
  sun: '<circle cx="10" cy="10" r="3.6"/><path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4"/>',
  moon: '<path d="M15.5 11.5A6 6 0 0 1 8.5 4.5a6 6 0 1 0 7 7z"/>',
  chev: '<path d="M5 7.5 10 12l5-4.5"/>',
  copy: '<rect x="6.5" y="6.5" width="9" height="9" rx="2"/><path d="M4.5 12.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1"/>',
  check: '<path d="M4 10.5 8 14l8-8.5"/>',
  x: '<path d="M5 5l10 10M15 5 5 15"/>',
  arrow: '<path d="M4 10h11M11 6l4 4-4 4"/>',
  ext: '<path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7"/>',
  person: '<circle cx="10" cy="7" r="3"/><path d="M4.5 16c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/>',
  spark: '<path d="M10 2.6 11.7 8 17 9.7 11.7 11.4 10 16.8 8.3 11.4 3 9.7 8.3 8z"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l2.8 1.8"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  shield: '<path d="M10 2.6 16 5v4.5c0 4-2.6 6.6-6 7.9-3.4-1.3-6-3.9-6-7.9V5z"/>',
  link: '<path d="M8.5 11.5 11.5 8.5M7.5 12.5 6 14a2.5 2.5 0 0 1-3.5-3.5L4 9M12.5 7.5 14 6a2.5 2.5 0 0 0-3.5-3.5L9 4"/>',
  play: '<path d="M6 4.5 15 10l-9 5.5z"/>',
  flag: '<path d="M5 17V3M5 4h9l-2 3 2 3H5"/>',
  convert: '<path d="M4 7h8l-2-2M16 13H8l2 2"/><rect x="3" y="3" width="14" height="14" rx="3" opacity="0"/>',
  dot: '<circle cx="10" cy="10" r="3.5"/>',
  maximize: '<path d="M7 4H4v3M13 4h3v3M7 16H4v-3M13 16h3v-3"/>',
  minimize: '<path d="M4 7h3V4M16 7h-3V4M4 13h3v3M16 13h-3v3"/>',
  pencil: '<path d="M13.5 4.5l2 2M4 16l1-3.2 7.6-7.6 2 2L7 14.8z"/>',
  refresh: '<path d="M15.5 6.5A6 6 0 1 0 16 10M16 4v3h-3"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/>',
  sliders: '<path d="M4 6h7M14 6h2M4 14h2M9 14h7"/><circle cx="12.5" cy="6" r="1.8"/><circle cx="7.5" cy="14" r="1.8"/>',
  menu: '<path d="M3.5 6h13M3.5 10h13M3.5 14h13"/>',
  code: '<path d="M7 6.5 3.5 10 7 13.5M13 6.5 16.5 10 13 13.5M11 4.5l-2 11"/>',
  /* ---- V2 additions: one distinct glyph per destination / action ---- */
  grid: '<rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.3"/><rect x="11" y="3.5" width="5.5" height="5.5" rx="1.3"/><rect x="3.5" y="11" width="5.5" height="5.5" rx="1.3"/><rect x="11" y="11" width="5.5" height="5.5" rx="1.3"/>',
  inbox: '<path d="M3 11.5 5 4.8A1.2 1.2 0 0 1 6.1 4h7.8a1.2 1.2 0 0 1 1.1.8l2 6.7V15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 11.5h4l1 2h4l1-2h4"/>',
  chart: '<path d="M3.5 16.5h13M6 13.5V10M10 13.5V5.5M14 13.5V8"/>',
  git: '<circle cx="6" cy="4.8" r="1.8"/><circle cx="6" cy="15.2" r="1.8"/><circle cx="14" cy="7" r="1.8"/><path d="M6 6.6v6.8M14 8.8c0 3-2.6 3.8-6.3 5"/>',
  phone: '<rect x="6" y="2.5" width="8" height="15" rx="2"/><path d="M8.8 5h2.4M9.5 15.2h1"/>',
  alert: '<path d="M10 3 17 16H3z"/><path d="M10 7.8v3.6M10 13.8h.01"/>',
  info: '<circle cx="10" cy="10" r="7"/><path d="M10 9.2v4.3M10 6.6h.01"/>',
  help: '<circle cx="10" cy="10" r="7"/><path d="M7.9 7.8a2.2 2.2 0 0 1 4.2.8c0 1.5-2.1 1.9-2.1 3.3M10 14.2h.01"/>',
  "arrow-left": '<path d="M16 10H5M9 6l-4 4 4 4"/>',
  "arrow-up": '<path d="M10 16V5M6 9l4-4 4 4"/>',
  "arrow-down": '<path d="M10 4v11M6 11l4 4 4-4"/>',
  "chev-left": '<path d="M12.5 5 7.5 10l5 5"/>',
  "chev-right": '<path d="M7.5 5l5 5-5 5"/>',
  eye: '<path d="M2.5 10S5.2 4.8 10 4.8 17.5 10 17.5 10 14.8 15.2 10 15.2 2.5 10 2.5 10z"/><circle cx="10" cy="10" r="2.4"/>',
  "eye-off": '<path d="M4.2 7.3C3.1 8.6 2.5 10 2.5 10s2.7 5.2 7.5 5.2c1.3 0 2.4-.3 3.4-.9M8 5c.6-.1 1.3-.2 2-.2 4.8 0 7.5 5.2 7.5 5.2s-.6 1.2-1.7 2.4M3.5 3.5l13 13M8.3 8.4a2.4 2.4 0 0 0 3.3 3.3"/>',
  pin: '<path d="M7.5 3.5h5M8.5 3.5v4.2L6 10.5h8l-2.5-2.8V3.5M10 10.5V17"/>',
  more: '<circle cx="5" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="15" cy="10" r=".8"/>',
  sidebar: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8 4v12"/>',
  folder: '<path d="M3 6a1.5 1.5 0 0 1 1.5-1.5H8l1.6 2H15.5A1.5 1.5 0 0 1 17 8v6.5A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z"/>',
  trash: '<path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 10h7.4l.8-10M8.5 9v4.5M11.5 9v4.5"/>',
  /* ---- Linear-pop additions: distinct glyphs where two actions shared one ---- */
  gear: '<path d="M10 2.8l1.3.25.35 1.75 1.2.65 1.6-.95 1.8 1.8-.95 1.6.65 1.2 1.75.35v2.6l-1.75.35-.65 1.2.95 1.6-1.8 1.8-1.6-.95-1.2.65-.35 1.75H8.7l-.35-1.75-1.2-.65-1.6.95-1.8-1.8.95-1.6-.65-1.2L2.3 11.3V8.7l1.75-.35.65-1.2-.95-1.6 1.8-1.8 1.6.95 1.2-.65.35-1.75z"/><circle cx="10" cy="10" r="2.4"/>',
  power: '<path d="M10 3v6.5"/><path d="M6.1 5.6a6 6 0 1 0 7.8 0"/>',
  pr: '<circle cx="5.5" cy="5" r="1.8"/><circle cx="5.5" cy="15" r="1.8"/><circle cx="14.5" cy="15" r="1.8"/><path d="M5.5 6.8v6.4M14.5 13.2V8.4a2.2 2.2 0 0 0-2.2-2.2H9.6M11.4 4.4 9.6 6.2l1.8 1.8"/>',
  star: '<path d="M10 3.2l2 4.3 4.6.5-3.4 3.1 1 4.6L10 13.4l-4.2 2.3 1-4.6L3.4 8l4.6-.5z"/>',
  filter: '<path d="M3.5 5.5h13M6 10h8M8.5 14.5h3"/>',
  sort: '<path d="M6 4v12M3.5 13.5 6 16l2.5-2.5M14 16V4M11.5 6.5 14 4l2.5 2.5"/>',
  display: '<path d="M4 6h8M15 6h1M4 14h1M8 14h8"/><circle cx="13.5" cy="6" r="1.5"/><circle cx="6.5" cy="14" r="1.5"/>',
  /* Org chart: a manager node over two reports, joined by an elbow connector */
  org: '<rect x="7.5" y="2.8" width="5" height="4" rx="1.2"/><rect x="2.8" y="13.2" width="5" height="4" rx="1.2"/><rect x="12.2" y="13.2" width="5" height="4" rx="1.2"/><path d="M10 6.8v3.2M5.3 13.2V10h9.4v3.2"/>',
  /* Routines: a clock inside a repeat arc — recurring scheduled work */
  routines: '<path d="M16.4 8.2A6.8 6.8 0 1 0 16 13"/><path d="M16.8 4.6v3.8H13"/><path d="M10 6.6V10l2.2 1.4"/>',
  "circle-help": '<circle cx="10" cy="10" r="7"/><path d="M8 8a2 2 0 0 1 3.9.6c0 1.3-1.9 1.7-1.9 2.9M10 13.8h.01"/>',
  lock: '<rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.6a3 3 0 0 1 6 0V9"/>',
  "bell-off": '<path d="M6.3 6.6A4 4 0 0 0 6 9c0 3-1.2 4-1.8 4.6-.3.3-.1.9.4.9h9.9M14 9.6V9a4 4 0 0 0-6.2-3.4"/><path d="M8.4 17a1.8 1.8 0 0 0 3.2 0M3 3l14 14"/>',
  pause: '<path d="M7.5 5v10M12.5 5v10"/>',
};
/** Aliases so call sites can use the obvious name (GitHub → git branch mark, Activity → pulse). */
I.github = I.git;
I.activity = I.live;
I.pulse = I.live;
I.settings = I.gear; // Settings = gear; "sliders" stays for execution/configuration controls
I.execution = I.power;
I.back = I["arrow-left"];

/** Every glyph name the Icon component can draw (unit-tested: nav icons must resolve). */
export function hasIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(I, name);
}

export function Icon({ name, cls = "ico" }: { name: string; cls?: string }) {
  // vanilla parity: app.js icon() does `cls || "ico"` — an explicit "" still
  // gets the sized .ico class, so icons are never rendered unconstrained.
  return (
    <svg
      className={cls || "ico"}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: I[name] || "" }}
    />
  );
}

/* ---- status pill ---------------------------------------------------------- */
// D8: the legacy status pill now draws the ONE Linear glyph set
// (primitives/StatusIcon) + the exact STAT label in neutral text. Class names
// (`pill s-*`) are kept so existing selectors/tests still match.
export function Pill({ status, size }: { status: string | null | undefined; size?: string }) {
  const m = statusMeta(status);
  return (
    <span className={`pill ${m.c}${size ? " " + size : ""}`} data-status={status || "unknown"}>
      <StatusGlyph status={status} size={size === "lg" ? 14 : 13} className="gl" />
      {m.l}
    </span>
  );
}

/* ---- avatar -------------------------------------------------------------- */
// D7: thin legacy wrapper over primitives/Avatar (circles for every actor, AI
// sparkle badge, optional presence dot). Legacy size names map onto the D7
// scale: "sm" → 20, (none) → 24, "lg" → 32; numeric 16/20/24/32/48 also work.
// ghLogin (cloud backends enrich agents with github_login) upgrades the tile to
// the GitHub avatar image; open backends omit it and keep the letter tile.
export function Avatar({ alias, kind, size, ghLogin, status, showKind, decorative, label }: {
  alias: string | null | undefined; kind?: string | null; size?: string | number; ghLogin?: string | null;
  status?: string | null; showKind?: boolean; decorative?: boolean; label?: string;
}) {
  const px = typeof size === "number" ? avatarPx(size) : size === "sm" ? 20 : size === "lg" ? 32 : size === "xs" ? 16 : size === "xl" ? 48 : 24;
  return <V2Avatar alias={alias} kind={kind} size={px} ghLogin={ghLogin} status={status} showKind={showKind} decorative={decorative} label={label} />;
}

export function KindBadge({ kind }: { kind: string | null | undefined }) {
  if (kind === "human")
    return (
      <span className="kind human">
        <Icon name="person" cls="" />
        Human
      </span>
    );
  return (
    <span className="kind ai">
      <Icon name="spark" cls="" />
      AI
    </span>
  );
}

/* ---- the Embodent mark --------------------------------------------------- */
// The "Halo E": a solid E inside a 50% halo arc, one colour — light on dark, near-black
// on light (--v2-logo-ink, v2-tokens.css). Stroked paths, no ids, so many marks on one page
// never collide. Same geometry as static/logo-mark.svg (mark units, centred on -57,0).
export const EMBODENT_MARK_HALO = "M390 -504 L0 -504 A504 504 0 0 0 0 504 L390 504 M0 0 L330 0";
export const EMBODENT_MARK_CORE = "M390 -354 L0 -354 A354 354 0 0 0 0 354 L390 354 M0 0 L330 0";
export function OrcaMark() {
  // intrinsic size: downstream stylesheets may not carry .brand .mark rules
  return (
    <svg viewBox="-720 -663 1326 1326" width={34} height={34} style={{ maxWidth: "100%", maxHeight: "100%" }} role="img" aria-label="Embodent">
      <g fill="none" strokeWidth={204} strokeLinecap="round" strokeLinejoin="round" stroke="#ECEDF1" style={{ stroke: "var(--v2-logo-ink, #ECEDF1)" }}>
        <path d={EMBODENT_MARK_HALO} strokeOpacity={0.5} />
        <path d={EMBODENT_MARK_CORE} />
      </g>
    </svg>
  );
}

/* ---- trusted-HTML text renderers ----------------------------------------- */
// Both run esc() FIRST inside lib/format — the input can never inject HTML.
export function Md({ text, tasks, className }: { text: unknown; tasks?: Task[]; className?: string }) {
  return <div className={className ?? "tx"} dangerouslySetInnerHTML={{ __html: mdText(text, tasks ?? []) }} />;
}
export function Linkified({ text, tasks, className }: { text: unknown; tasks?: Task[]; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: linkify(text, tasks ?? []) }} />;
}

/* ---- toast --------------------------------------------------------------- */
export interface ToastOptions {
  /** stay until dismissed (failures the user must read and act on) */
  sticky?: boolean;
  /** one inline action (e.g. "Undo") — the toast stays clickable while shown */
  action?: { label: string; onClick: () => void };
  /** how long a non-sticky toast shows (ms, default 2600) */
  durationMs?: number;
}
type ToastFn = (msg: string, kind?: "ok" | "warn" | "danger" | "", opts?: ToastOptions) => void;
const ToastCtx = createContext<ToastFn>(() => {});
export function useToast(): ToastFn {
  return useContext(ToastCtx);
}
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: string; show: boolean; sticky: boolean; action: ToastOptions["action"] | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast: ToastFn = (msg, kind = "", opts) => {
    if (timer.current) clearTimeout(timer.current);
    const sticky = !!opts?.sticky;
    setT({ msg, kind, show: true, sticky, action: opts?.action ?? null });
    timer.current = sticky ? null : setTimeout(() => setT((v) => (v ? { ...v, show: false } : v)), opts?.durationMs ?? 2600);
  };
  const dismiss = () => setT((v) => (v ? { ...v, show: false } : v));
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      {/* persistent polite live region (V2 a11y): the toast text is announced once */}
      <div className="v2-toast-region" role="status" aria-live="polite">
        {t && (
          <div className={`toast ${t.kind}${t.show ? " show" : ""}${t.sticky ? " sticky" : ""}${t.action ? " has-action" : ""}`}>
            <span className="toast-msg">{t.msg}</span>
            {t.action && t.show ? (
              <button
                type="button"
                className="toast-act"
                onClick={() => { const a = t.action; dismiss(); a?.onClick(); }}
              >{t.action.label}</button>
            ) : null}
            {t.sticky && t.show ? (
              <button type="button" className="toast-x" aria-label="Dismiss" onClick={dismiss}>×</button>
            ) : null}
          </div>
        )}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---- modal (same .overlay/.modal/.mh/.mb/.mf markup as app.js) ----------- */
export interface ModalProps {
  title: string;
  desc?: ReactNode;
  danger?: boolean;
  approve?: boolean;
  primary?: string;
  cancel?: string;
  onPrimary?: () => void;
  onClose: () => void;
  children?: ReactNode;
}
export function Modal({ title, desc, danger, approve, primary, cancel, onPrimary, onClose, children }: ModalProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  // V2 (S-19): focus moves into the dialog (Cancel first for danger confirms,
  // so Enter never fires a destructive action by accident), Tab is trapped,
  // and focus returns to the opener on close.
  useFocusReturn(boxRef, danger ? cancelRef : undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Portal to <body>: an ancestor with backdrop-filter/transform (e.g. the
  // topbar) becomes the containing block for position:fixed, clipping the
  // overlay — any modal launched from topbar controls needs this.
  return createPortal(
    <div
      className="overlay show"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={boxRef} tabIndex={-1}
        onKeyDown={(e) => trapTab(e, boxRef.current)}>
        <div className="mh">
          <h3 id={titleId}>{title}</h3>
          {desc && <p>{desc}</p>}
        </div>
        <div className="mb">{children}</div>
        <div className="mf">
          {/* V2 Button classes (primitives/Button.tsx); approve = primary (no green slab), danger = subtle red */}
          <button ref={cancelRef} className="v2-btn v2-btn-ghost v2-btn-md" type="button" onClick={onClose}>
            {cancel || "Cancel"}
          </button>
          <button
            className={`v2-btn v2-btn-md ${danger ? "v2-btn-danger" : "v2-btn-primary"}`}
            data-approve={approve || undefined}
            type="button"
            onClick={onPrimary ?? onClose}
          >
            {primary || "Confirm"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
