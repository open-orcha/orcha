/**
 * The Verdikt auto-fix loop (mig 068): send to Verdikt → fail → back to the agent → … → pass.
 *
 *   <AutofixTimeline loop taskId />   "Attempt 1 ✗ 1/3 · Attempt 2 ✗ 2/3 · Attempt 3 ✓ 3/3",
 *                                     each attempt linking to its run evidence (the Verdikt
 *                                     report) and to that attempt's code changes
 *   <AutofixStatus state … />         "Auto-fix running: attempt 2 of 3" + Stop auto-fix, or why
 *                                     it stopped ("Verdikt passed on attempt 3 of 3 — ready for
 *                                     your review"); the timeline under it
 *   <AutofixOverride state … />       per-task Inherit / On / Off — disabled, with the reason,
 *                                     while Verdikt doesn't run automatically
 *   <AutofixSection taskId … />       self-fetching (GET /api/tasks/{tid}/verdikt/autofix) for the
 *                                     task page: shown only while a loop of the current review
 *                                     cycle exists (incl. while the task is back with the agent)
 *
 * A loop never completes a task: a pass leaves it for a person to verify.
 */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../../components/ui";
import { Button, Segmented } from "../../../components/primitives";
import { relTime } from "../../../lib/format";
import { detailText, postJSON } from "./useEvidence";
import { evidenceCss } from "./evidenceCss";
import type { AutofixAttempt, AutofixLoop, AutofixState } from "./evidenceTypes";

export const AUTOFIX_GRANT_REASON = "Changing it requires the owner role or the Repository permission (manage_repo)";

function attemptGlyph(a: AutofixAttempt) {
  if (a.outcome === "pass") return <span className="ev-glyph ev-ok" aria-label="passed"><Icon name="check" cls="" /></span>;
  if (a.outcome === "fail") return <span className="ev-glyph ev-bad" aria-label="failed"><Icon name="x" cls="" /></span>;
  return <span className="ev-glyph ev-warn" aria-label={a.outcome}><Icon name="alert" cls="" /></span>;
}

function attemptTitle(a: AutofixAttempt): string {
  const head = a.outcome === "pass" ? "Verdikt passed" : a.outcome === "fail" ? "Verdikt failed" : "Verdikt: " + a.outcome;
  const failed = a.failed.map((f) => "✗ " + f.text + (f.actual ? " — " + f.actual : "")).join("\n");
  const ch = a.changes.summary ? "\nChanges: " + a.changes.summary : "";
  return head + (a.action === "reworked" ? " → sent back to the agent" : "") + (failed ? "\n" + failed : "") + ch;
}

/** "Attempt 1 ✗ 1/3 · Attempt 2 ✗ 2/3 · Attempt 3 ✓ 3/3" — plus the attempt in flight. */
export function AutofixTimeline({ loop }: { loop: AutofixLoop }) {
  const max = loop.max_attempts;
  const pending = loop.status === "running" ? loop.current_attempt : null;
  return (
    <ol className="af-tl" aria-label="Auto-fix attempts" data-testid="autofix-timeline">
      {loop.attempts.map((a) => (
        <li key={a.verdikt_run} className="af-att" data-attempt={a.attempt} data-outcome={a.outcome} title={attemptTitle(a)}>
          {attemptGlyph(a)}
          <a className="af-att-k" href={a.report_url} target="_blank" rel="noreferrer" aria-label={`Attempt ${a.attempt}: ${a.outcome} — open its Verdikt report`}>
            Attempt {a.attempt}
          </a>
          <span className="af-frac">{a.attempt}/{max}</span>
          {a.changes.href ? (
            <a className="af-ch" href={a.changes.href} aria-label={`Attempt ${a.attempt} code changes`}>changes</a>
          ) : null}
        </li>
      ))}
      {pending && !loop.attempts.some((a) => a.attempt === pending) ? (
        <li className="af-att af-pending" data-attempt={pending} data-outcome="pending">
          <span className="ev-glyph ev-mut" aria-hidden="true"><Icon name="dot" cls="" /></span>
          <span className="af-att-k ev-shimmer">Attempt {pending}</span>
          <span className="af-frac">{pending}/{max}</span>
        </li>
      ) : null}
    </ol>
  );
}

/** One line: running (+ Stop) or why it stopped, then the timeline. */
export function AutofixStatus({ state, taskId, actorId, noActorReason, onChanged }: {
  state: AutofixState;
  taskId: string;
  actorId: string | null;
  noActorReason?: string;
  onChanged?: (s: AutofixState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const loop = state.loop;
  if (!loop || loop.current === false) return null;
  const running = loop.status === "running";
  const stop = async () => {
    if (!actorId) return;
    setBusy(true);
    setErr(null);
    const r = await postJSON<AutofixState>("/api/tasks/" + encodeURIComponent(taskId) + "/verdikt/autofix/stop", { actor_agent_id: actorId });
    setBusy(false);
    if (r.ok) onChanged?.(r.d);
    else setErr((r.status ? "HTTP " + r.status : "Not sent") + (detailText(r.d) ? " — " + detailText(r.d) : ""));
  };
  const passed = loop.stop_kind === "pass";
  return (
    <div className="af" data-testid="autofix-status" data-status={loop.status} data-stop={loop.stop_kind || undefined}>
      <div className="ev-vk-line">
        {running ? (
          <span className="ev-part" role="status">
            <span className="ev-glyph ev-mut" aria-hidden="true"><Icon name="refresh" cls="" /></span>
            <span>Auto-fix running: attempt {loop.current_attempt} of {loop.max_attempts}</span>
          </span>
        ) : (
          <span className={"ev-part af-stopped" + (passed ? " ev-ok" : "")} role={passed ? "status" : "note"}>
            <span className={"ev-glyph " + (passed ? "ev-ok" : "ev-warn")} aria-hidden="true"><Icon name={passed ? "check" : "alert"} cls="" /></span>
            <span className="af-why">{loop.stop_reason || loop.stop_label || "Auto-fix stopped"}</span>
          </span>
        )}
        {!running && loop.stopped_at ? <span className="ev-part ev-mut">{relTime(loop.stopped_at)}</span> : null}
        <span className="ev-vk-actions">
          {running ? (
            <Button size="sm" variant="secondary" icon="stop" data-act="autofix-stop" disabled={!actorId || busy} busy={busy}
              title={!actorId ? noActorReason : "Stop sending it back automatically — the task stays where it is for a person"}
              onClick={() => void stop()}>
              Stop auto-fix
            </Button>
          ) : null}
        </span>
      </div>
      <AutofixTimeline loop={loop} />
      {err ? <div className="ev-err" role="alert">{err}</div> : null}
    </div>
  );
}

const OVERRIDE_ITEMS: { key: AutofixState["override"]; label: string }[] = [
  { key: "inherit", label: "Project default" },
  { key: "on", label: "On" },
  { key: "off", label: "Off" },
];

/** Per-task override — Project default / On / Off. */
export function AutofixOverride({ state, taskId, actorId, onChanged }: {
  state: AutofixState;
  taskId: string;
  actorId: string | null;
  onChanged?: (s: AutofixState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const applies = state.project.applies;
  const locked = !actorId || !applies || busy;
  const set = async (mode: string) => {
    if (locked || mode === state.override) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/tasks/" + encodeURIComponent(taskId) + "/verdikt/autofix", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor_agent_id: actorId, mode }),
      });
      let d: unknown = {};
      try { d = await r.json(); } catch { /* empty */ }
      if (r.ok) onChanged?.(d as AutofixState);
      else setErr(r.status === 403 ? AUTOFIX_GRANT_REASON : "HTTP " + r.status + (detailText(d as { detail?: unknown }) ? " — " + detailText(d as { detail?: unknown }) : ""));
    } catch {
      setErr("the portal could not be reached");
    }
    setBusy(false);
  };
  const def = state.project.enabled ? "on" : "off";
  const items = OVERRIDE_ITEMS.map((i) => ({
    key: i.key,
    label: i.key === "inherit" ? `${i.label} (${def})` : i.label,
    disabled: locked && i.key !== state.override,
  }));
  return (
    <div className="af-ov" data-testid="autofix-override">
      <div className="ev-vk-line">
        <span className="ev-part" id={"af-ov-" + taskId}>Auto-fix</span>
        <Segmented size="sm" label="Auto-fix for this task" value={state.override} items={items} onChange={(k) => void set(k)} />
        <span className="ev-part ev-mut af-hint" data-testid="autofix-why">
          {!applies
            ? "Only works when Verdikt runs automatically — change When in Settings › Verdikt"
            : state.effective
              ? `On: a Verdikt fail goes back to the agent, up to ${state.project.max_attempts} attempts`
              : state.why}
        </span>
      </div>
      {err ? <div className="ev-err" role="alert">{err}</div> : null}
    </div>
  );
}

/** Task page: the loop's status + timeline + Stop, while a current-cycle loop exists. */
export function AutofixSection({ taskId, status, actorId, noActorReason }: {
  taskId: string;
  /** the task's status — a change reloads (the loop moves the task) */
  status: string;
  actorId: string | null;
  noActorReason?: string;
}) {
  const [state, setState] = useState<AutofixState | null>(null);
  const load = useCallback(() => {
    let live = true;
    fetch("/api/tasks/" + encodeURIComponent(taskId) + "/verdikt/autofix")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: AutofixState) => { if (live && d && typeof d === "object" && "override" in d) setState(d); })
      .catch(() => { /* an older backend (404) or a blip: show nothing */ });
    return () => { live = false; };
  }, [taskId]);
  useEffect(load, [load, status]);
  const running = state?.loop?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(load, 15000);
    return () => window.clearInterval(t);
  }, [running, load]);
  if (!state || !state.loop || state.loop.current === false) return null;
  return (
    <section className="af-sec" aria-label="Verdikt auto-fix" data-testid="autofix-section">
      <style>{evidenceCss + AUTOFIX_CSS}</style>
      <div className="ev-sec-h"><span>Verdikt auto-fix</span></div>
      <AutofixStatus state={state} taskId={taskId} actorId={actorId} noActorReason={noActorReason} onChanged={setState} />
    </section>
  );
}

/** The parts of the attempts line as plain text — for titles / tests. */
export function timelineText(loop: AutofixLoop): string {
  return loop.attempts
    .map((a) => `Attempt ${a.attempt} ${a.outcome === "pass" ? "✓" : a.outcome === "fail" ? "✗" : "!"} ${a.attempt}/${loop.max_attempts}`)
    .join(" · ");
}

export const AUTOFIX_CSS = String.raw`
  .af { margin-top: 2px; }
  .af-sec { margin: 12px 0 4px; padding: 10px 12px; border: 1px solid var(--v2-border); border-radius: var(--v2-radius-card, 8px); background: var(--v2-surface); }
  .af-sec .ev-sec-h { margin-bottom: 4px; }
  .af-why { white-space: normal; overflow-wrap: anywhere; color: var(--v2-text-2); }
  .af-stopped { white-space: normal; align-items: flex-start; }
  .af-tl { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 14px; font-size: 12.5px; clip-path: inset(-8px -8px -8px 0); }
  .af-att { display: inline-flex; align-items: center; gap: 4px; color: var(--v2-text-2); white-space: nowrap; font-variant-numeric: tabular-nums; position: relative; }
  .af-att + .af-att::before { content: "·"; position: absolute; left: -9px; color: var(--v2-text-3); }
  .af-att .ev-glyph { width: 14px; height: 18px; }
  .af-att .ev-glyph svg { width: 12px; height: 12px; }
  .af-att-k { color: var(--v2-text); text-decoration: none; }
  a.af-att-k:hover { text-decoration: underline; }
  .af-frac { color: var(--v2-text-3); }
  .af-ch { color: var(--v2-accent); text-decoration: none; font-size: 12px; }
  .af-ch:hover { text-decoration: underline; }
  .af-ov { margin-top: 8px; }
  .af-ov .ev-part:first-child { color: var(--v2-text-2); }
  .af-hint { white-space: normal; font-size: 12px; }
`;
