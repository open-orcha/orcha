/** Small shared pieces for the QA views: a loader hook, the status glyph + word, links. */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, StatusIcon, Tooltip } from "../../components/primitives";
import { Icon } from "../../components/ui";
import { agentById, taskById, useSnapshot } from "../../state/SnapshotProvider";

export function errText(e: unknown): string {
  const x = e as { detail?: string; message?: string; status?: number };
  if (x?.status === 404) return "The QA service isn't available on this server yet — update Embodent (orcha up) and try again.";
  return x?.detail || x?.message || "Something went wrong";
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  /** HTTP status of the last failure (404 = the route doesn't exist / nothing there) */
  status: number | null;
}

/**
 * Fetch `load` whenever an identity dep changes or `nonce` bumps. A refresh (same deps,
 * new nonce) keeps showing the last good data while it reloads; new deps (another
 * platform, another scenario) never show the previous one's data.
 */
export function useLoad<T>(load: ((signal: AbortSignal) => Promise<T>) | null, deps: unknown[], nonce = 0): Loaded<T> {
  const [state, setState] = useState<Loaded<T> & { key: string }>({ data: null, error: null, status: null, key: "" });
  const key = JSON.stringify(deps);
  useEffect(() => {
    if (!load) return;
    const ctl = new AbortController();
    load(ctl.signal).then(
      (data) => { if (!ctl.signal.aborted) setState({ data, error: null, status: null, key }); },
      (e) => {
        if (ctl.signal.aborted) return;
        const status = (e as { status?: number })?.status ?? null;
        setState((s) => ({ data: s.key === key ? s.data : null, error: errText(e), status, key }));
      },
    );
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, !!load]);
  const sameKey = state.key === key;
  return { data: sameKey ? state.data : null, error: sameKey ? state.error : null, status: sameKey ? state.status : null };
}

/** A StatusIcon glyph with a QA word as its label. */
export function QaStatus({ glyph, word, show = false, size = 14 }: { glyph: string; word: string; show?: boolean; size?: number }) {
  return <StatusIcon status={glyph} label={word} showLabel={show} size={size} />;
}

/** "kedar" for an agent id, else null. */
export function useAgentAlias(id: string | null | undefined, fallback?: string | null): string | null {
  const { snap } = useSnapshot();
  if (fallback) return fallback;
  return id ? agentById(snap, id)?.alias ?? null : null;
}

/** A link to a task by id, titled from the snapshot when it's known. */
export function TaskLink({ id, title, className }: { id: string; title?: string | null; className?: string }) {
  const { snap } = useSnapshot();
  const t = taskById(snap, id);
  const text = title || t?.title || "Open task";
  return <Link className={"qa-tasklink" + (className ? " " + className : "")} to={"/tasks?task=" + encodeURIComponent(id)} title={text}>{text}</Link>;
}

export function Kv({ items }: { items: [string, ReactNode][] }) {
  const shown = items.filter(([, v]) => v != null && v !== "" && v !== false);
  if (!shown.length) return null;
  return (
    <dl className="qa-kv">
      {shown.map(([k, v]) => (
        <div key={k} className="qa-kv-row"><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

export function QaSection({ title, count, actions, children, label }: { title: string; count?: number | null; actions?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section className="qa-sec" aria-label={label ?? title}>
      <div className="qa-sec-h">
        <h3 className="qa-sec-t">{title}{count != null ? <span className="qa-sec-n">{count}</span> : null}</h3>
        {actions ? <div className="qa-sec-a">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Href inside Quality: keep cid-less SPA paths like the other tabs. */
export function qaHref(params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return "/qa" + (s ? "?" + s : "");
}

/** The platform's glyph: a phone for iOS / Android, a globe for the web (same stroke as Icon). */
export function PlatformIcon({ platform, cls = "v2-ico" }: { platform: string; cls?: string }) {
  if (platform !== "web") return <Icon name="phone" cls={cls} />;
  return (
    <svg className={cls} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2 2.2 2.9 4.5 2.9 7s-.9 4.8-2.9 7c-2-2.2-2.9-4.5-2.9-7S8 5.2 10 3z" />
    </svg>
  );
}

/** An empty state's "Run check" preset (Map / Draft / Explore) — disabled with the reason for non-humans. */
export function RunQaButton({ can, reason, onRun, label }: { can: boolean; reason: string | null; onRun: () => void; label: string }) {
  const btn = <Button size="sm" variant="primary" icon="play" disabled={!can} onClick={onRun}>{label}</Button>;
  return can ? btn : <Tooltip label={reason || "Only a person can start QA work"} placement="bottom">{btn}</Tooltip>;
}
