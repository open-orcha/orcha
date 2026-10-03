/**
 * Settings — small shared building blocks (Orcha V2, Linear-style).
 *
 *  - StatusLine: a flat, 32 px status row (status glyph + one sentence + the
 *    masked secret + an optional trailing action). Colour lives ONLY in the
 *    glyph — no filled green/amber/red banners, no coloured stripes (D3).
 *  - SecretInput: a password field + an eye / eye-off reveal toggle
 *    (aria-label + aria-pressed; never the magnifier "search" glyph).
 *  - TestResult: the inline verdict under a key/token Test.
 *  - providerEnvVar: the provider-conventional env var a key can also come
 *    from (llm_catalog.resolve_api_key fallback map).
 *
 *  - SettingsGroup: one Linear-style settings group — a section title and a
 *    one-line description ABOVE a calm bordered box (`.set-card > .card-h`
 *    + `.card-b`); `flush` drops the box padding for row lists.
 *  - SettingRow: one row inside a group box — label (+ muted description) on
 *    the left, the control or value right-aligned; hairlines between rows.
 *
 * Class names keep the pre-V2 `.sc-*` hooks so behavior tests stay stable;
 * styles live in cloud/settings/settings-cards.css.
 */
import type { ReactNode } from "react";
import { Icon } from "../../components/ui";
import { HelpTip as SharedHelpTip, IconButton } from "../../components/primitives";

/**
 * A small "?" next to a group title (D12): the explanation that used to be a
 * 2–3 line paragraph lives here, as a real tooltip (hover + keyboard focus),
 * so each group shows at most one short line.
 */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  return <SharedHelpTip tip={children} label={"About " + label} className="set-help" />;
}

/** A group header: title (+ optional ? tooltip), one short line, optional trailing action. */
export function GroupHead({ title, lead, help, action }: { title?: ReactNode; lead?: ReactNode; help?: ReactNode; action?: ReactNode }) {
  if (!title && !lead && !action) return null;
  return (
    <div className={"card-h" + (action ? " has-act" : "")}>
      <div className="card-h-t">
        {title ? (
          <h2>
            {title}
            {help ? <HelpTip label={typeof title === "string" ? title : "this setting"}>{help}</HelpTip> : null}
          </h2>
        ) : null}
        {lead ? <div className="lead">{lead}</div> : null}
      </div>
      {action ? <div className="card-h-act">{action}</div> : null}
    </div>
  );
}

export function SettingsGroup({
  title, lead, help, action, children, flush, id, settab, className,
}: {
  title?: ReactNode;
  /** ONE short line under the title (D12) — longer explanations go in `help`. */
  lead?: ReactNode;
  /** tooltip text behind a "?" beside the title */
  help?: ReactNode;
  /** a compact control on the right of the group header */
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  id?: string;
  settab?: string;
  className?: string;
}) {
  return (
    <section className={"card set-card" + (className ? " " + className : "")} id={id} data-settab={settab}>
      <GroupHead title={title} lead={lead} help={help} action={action} />
      <div className={"card-b" + (flush ? " is-flush" : "")}>{children}</div>
    </section>
  );
}

/** A list of SettingRows (a <dl>: each row is a term + its value/control). */
export function SettingRows({ children, id, label }: { children: ReactNode; id?: string; label?: string }) {
  return <dl className="set-rows" id={id} aria-label={label}>{children}</dl>;
}

export function SettingRow({
  label, desc, children, id, className, stack,
}: {
  label: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  id?: string;
  className?: string;
  /** Put the control under the label (long values, e.g. a description). */
  stack?: boolean;
}) {
  return (
    <div className={"set-rowi" + (stack ? " is-stack" : "") + (className ? " " + className : "")}>
      <dt>
        <span className="set-rowi-l" id={id}>{label}</span>
        {desc ? <span className="set-rowi-d">{desc}</span> : null}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

export type StatusTone = "ok" | "env" | "warn" | "err" | "muted";

const TONE_ICON: Record<StatusTone, string> = {
  ok: "check",
  env: "shield",
  warn: "alert",
  err: "alert",
  muted: "clock",
};

export function StatusLine({
  tone, icon, children, masked, action, id,
}: {
  tone: StatusTone;
  icon?: string;
  children: ReactNode;
  masked?: string | null;
  action?: ReactNode;
  id?: string;
}) {
  // ok/env share the calm "configured" look; the class keeps .ok for env too
  // (tests and older selectors key off .sc-banner.ok for a configured key).
  const cls = tone === "env" ? "ok env" : tone;
  return (
    <div className={"sc-banner " + cls} id={id} role={tone === "err" ? "alert" : undefined}>
      <div className="bt">
        <Icon name={icon || TONE_ICON[tone]} cls="" />
        <span>{children}</span>
      </div>
      {masked ? <code className="masked">{masked}</code> : null}
      {action ? <span className="sc-banner-act">{action}</span> : null}
    </div>
  );
}

export function SecretInput({
  id, revealId, value, onChange, placeholder, reveal, onToggleReveal, label,
}: {
  id?: string;
  revealId?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  reveal: boolean;
  onToggleReveal: () => void;
  label: string;
}) {
  return (
    <div className="sc-row">
      <input
        id={id}
        className="sc-inp"
        type={reveal ? "text" : "password"}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <IconButton
        id={revealId}
        variant="secondary"
        icon={reveal ? "eye-off" : "eye"}
        label={reveal ? "Hide key" : "Show key"}
        pressed={reveal}
        onClick={onToggleReveal}
      />
    </div>
  );
}

export function TestResult({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className={"sc-result " + (ok ? "ok" : "err")} role="status">
      <Icon name={ok ? "check" : "alert"} cls="" />
      <span>{children}</span>
    </div>
  );
}

/** Provider-conventional env var (read by the universal client when no Orcha key is set). */
export const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  google: "GEMINI_API_KEY",
};
export function providerEnvVar(provider: string): string | null {
  return PROVIDER_ENV[provider] || null;
}

/**
 * The (i) beside an env-managed key's actions (D12): how to change the key
 * lives in the tooltip, not as a sentence under the status line.
 */
export function EnvKeyHint({ provider }: { provider?: string }) {
  const fallback = provider ? providerEnvVar(provider) : null;
  return (
    <HelpTip label="changing the environment key">
      To change it, update ORCHA_LLM_API_KEY and run orcha up.
      {fallback ? " Without ORCHA_LLM_API_KEY, the client falls back to " + fallback + "." : null}
    </HelpTip>
  );
}

/**
 * A settings mutation's failure as a short clause (pure, tested): the
 * server's own detail when it sent one (sendJSON puts it after "→ <status>:"),
 * else plain words for the status — never the request URL, the container id
 * or a bare "(403)". Non-string details (FastAPI 422 arrays, {message}
 * objects) are unwrapped; anything else falls back to the status words.
 */
export function settingsErrText(e: unknown): string {
  const err = e as { status?: unknown; message?: unknown } | null;
  const msg = err && typeof err.message === "string" ? err.message : "";
  const m = /→\s*(\d{3})(?::\s*([\s\S]*))?$/.exec(msg);
  const status = m ? Number(m[1]) : err && typeof err.status === "number" ? err.status : 0;
  let detail = m && m[2] ? m[2].trim() : "";
  if (detail && (detail[0] === "{" || detail[0] === "[")) {
    try {
      const d = JSON.parse(detail) as unknown;
      if (Array.isArray(d)) {
        detail = d.map((x) => (x && typeof x === "object" && typeof (x as { msg?: unknown }).msg === "string" ? (x as { msg: string }).msg : ""))
          .filter(Boolean).join("; ");
      } else if (d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string") {
        detail = (d as { message: string }).message;
      } else detail = "";
    } catch { detail = ""; }
  }
  if (detail) return detail;
  if (!status) return "couldn't reach Embodent";
  if (status === 401 || status === 403) return "you don't have permission to change this";
  if (status === 404) return "this project couldn't be found";
  if (status >= 500) return "Embodent hit an error — try again";
  return "the server refused the change";
}
