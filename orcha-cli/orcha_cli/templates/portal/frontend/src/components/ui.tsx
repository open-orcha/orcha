/**
 * Shared UI primitives — React ports of the app.js helpers, emitting the SAME
 * markup/class names so the untouched styles.css styles them identically:
 * Icon (the I path map), Pill/glyph, Avatar, KindBadge, OrcaMark, Md/Linkified
 * (trusted-HTML renderers over lib/format), Modal, and the toast system.
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { esc, hue, linkify, mdText } from "../lib/format";
import { statusMeta } from "../lib/status";
import type { Task } from "../types";

/* ---- icons (verbatim path set from app.js) ------------------------------ */
const I: Record<string, string> = {
  home: '<path d="M3 9.5 10 4l7 5.5V17a1 1 0 0 1-1 1h-3v-5H7v5H4a1 1 0 0 1-1-1z"/>',
  agents: '<circle cx="7" cy="7.5" r="2.6"/><circle cx="13.5" cy="8" r="2.1"/><path d="M2.6 16c.4-2.4 2.2-3.8 4.4-3.8s4 1.4 4.4 3.8M12 12.5c2 .1 3.4 1.4 3.8 3.5"/>',
  tasks: '<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3"/><path d="M6.6 10l2.2 2.2 4.6-4.8"/>',
  requests: '<path d="M5 7h9l-2.4-2.4M15 13H6l2.4 2.4"/>',
  live: '<path d="M2.5 10h3l2-5 3 10 2-7 1.5 2h3.5"/>',
  search: '<circle cx="8.5" cy="8.5" r="5"/><path d="m13 13 3.5 3.5"/>',
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
  code: '<path d="M7 6.5 3.5 10 7 13.5M13 6.5 16.5 10 13 13.5M11 4.5l-2 11"/>',
};

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

/* ---- status pill (glyph markup verbatim from app.js) --------------------- */
function glyphHtml(cls: string): string {
  const v = (b: string) =>
    `<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`;
  switch (cls) {
    case "s-working":
      return '<svg class="gl" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="1.3"/><circle class="core" cx="6" cy="6" r="2.3" fill="currentColor"/></svg>';
    case "s-ok":
    case "s-done":
      return v('<path d="M2.6 6.4 5 8.7 9.4 3.6"/>');
    case "s-ready":
      return '<svg class="gl" viewBox="0 0 12 12" fill="currentColor"><path d="M3.6 2.6 9.6 6l-6 3.4z"/></svg>';
    case "s-attn":
    case "s-warn":
      return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M6 2 11 10.6H1z"/><path d="M6 5v2.2"/><circle cx="6" cy="9" r=".55" fill="currentColor" stroke="none"/></svg>';
    case "s-bad":
      return v('<path d="M3.3 3.3 8.7 8.7M8.7 3.3 3.3 8.7"/>');
    case "s-acc":
      return v('<path d="M2.6 6h6.8M6.4 3 9.4 6 6.4 9"/>');
    default:
      return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="3.6" stroke-opacity=".55"/><path d="M4.3 6h3.4" stroke-linecap="round"/></svg>';
  }
}

export function Pill({ status, size }: { status: string | null | undefined; size?: string }) {
  const m = statusMeta(status);
  return (
    <span
      className={`pill ${m.c}${size ? " " + size : ""}`}
      dangerouslySetInnerHTML={{ __html: glyphHtml(m.c) + esc(m.l) }}
    />
  );
}

/* ---- avatar -------------------------------------------------------------- */
// ghLogin (cloud backends enrich agents with github_login) upgrades the tile to
// the GitHub avatar image; open backends omit it and keep the letter tile.
export function Avatar({ alias, kind, size, ghLogin }: { alias: string | null | undefined; kind?: string | null; size?: string; ghLogin?: string | null }) {
  const [imgFailed, setImgFailed] = useState(false);
  const h = hue(alias || "");
  const grad = `linear-gradient(140deg, hsl(${h} 70% 62%), hsl(${(h + 38) % 360} 72% 54%))`;
  const cls = "av" + (size ? " " + size : "") + (kind === "human" ? " human" : "");
  const init = (alias || "?").trim().charAt(0).toUpperCase();
  const login = (ghLogin || "").trim();
  if (login && !imgFailed && /^[A-Za-z0-9-]+$/.test(login)) {
    return (
      <span className={cls} style={{ background: grad, overflow: "hidden" }}>
        <img
          src={`https://github.com/${login}.png?size=64`}
          alt={alias || login}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: "inherit" }}
          onError={() => setImgFailed(true)}
        />
      </span>
    );
  }
  return (
    <span className={cls} style={{ background: grad }}>
      {init}
    </span>
  );
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

/* ---- the Orcha mark ------------------------------------------------------ */
export function OrcaMark() {
  // intrinsic size: downstream stylesheets may not carry .brand .mark rules
  return (
    <svg viewBox="0 0 100 100" width={34} height={34} style={{ maxWidth: "100%", maxHeight: "100%" }} fill="none" aria-label="Orcha">
      <path d="M27,83 C28,55 33,32 45.5,22.5 C51.5,18 57.5,19.5 60,27 C64.5,46 70.5,67 73,83 Z" fill="#f3fbfb" />
      <g stroke="#06171c" strokeWidth={2.4} strokeLinecap="round">
        <line x1="49" y1="38" x2="40" y2="62" />
        <line x1="49" y1="38" x2="56" y2="62" />
        <line x1="49" y1="38" x2="50" y2="74" />
      </g>
      <g fill="#06171c">
        <circle cx="39" cy="64" r="4" />
        <circle cx="57" cy="64" r="4" />
        <circle cx="50" cy="76" r="4" />
      </g>
      <circle cx="49" cy="35" r="6" fill="#1fc7cd" />
      <path d="M13,86 C28,82 38,82 50,82.5 C62,82 72,82 87,86" stroke="#1fc7cd" strokeWidth={5} strokeLinecap="round" fill="none" />
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
type ToastFn = (msg: string, kind?: "ok" | "warn" | "danger" | "") => void;
const ToastCtx = createContext<ToastFn>(() => {});
export function useToast(): ToastFn {
  return useContext(ToastCtx);
}
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: string; show: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast: ToastFn = (msg, kind = "") => {
    if (timer.current) clearTimeout(timer.current);
    setT({ msg, kind, show: true });
    timer.current = setTimeout(() => setT((v) => (v ? { ...v, show: false } : v)), 2600);
  };
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      {t && <div className={`toast ${t.kind}${t.show ? " show" : ""}`}>{t.msg}</div>}
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
      <div className="modal" role="dialog" aria-modal="true">
        <div className="mh">
          <h3>{title}</h3>
          {desc && <p>{desc}</p>}
        </div>
        <div className="mb">{children}</div>
        <div className="mf">
          <button className="btn ghost" type="button" onClick={onClose}>
            {cancel || "Cancel"}
          </button>
          <button
            className={`btn ${danger ? "danger" : approve ? "approve" : ""}`}
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
