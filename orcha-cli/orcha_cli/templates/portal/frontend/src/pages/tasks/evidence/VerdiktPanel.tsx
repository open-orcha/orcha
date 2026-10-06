/**
 * Verdikt section of the evidence pack: the latest Verdikt run for the task
 * (status, verdict per criterion, screenshots, recording, report link) and the
 * actions — Run in Verdikt / Retry / Cancel / Check now.
 *
 * Honest states: queued (and whether a Verdikt worker is online), running,
 * completed + verdict, failed / unavailable / timeout / cancelled with the
 * reason and Retry. A Verdikt verdict is evidence only — it never accepts or
 * rejects the task (the gate's Accept/Reject stay the human's).
 *
 * Settings come from GET /api/tasks/{tid}/verdikt/runs (settings + history);
 * the latest run is also carried by the evidence pack (`latest`).
 *
 * Preview environments (mig 064): with a project preview command, the host
 * notifier builds + serves the task's worktree first and Verdikt tests that.
 * Honest states: "Starting preview…", "Preview ready at …" (+ a Preview link),
 * "Preview failed: <reason>" + the last log lines, and — with no command —
 * "No preview command set: Verdikt will test <configured URL>".
 *
 * "Open in Verdikt" (header, and on every earlier run) goes through
 * GET /api/tasks/{tid}/verdikt/open, a redirect to the run's page in Verdikt
 * (or the project before any run) at a host the browser can reach.
 *
 * Auto-fix loop (mig 068, `autofix` on the runs response): "Auto-fix running:
 * attempt 2 of 3" + Stop auto-fix, or why it stopped; the attempts timeline;
 * the per-task override (Project default / On / Off).
 */
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../../components/ui";
import { Button, ButtonLink } from "../../../components/primitives";
import { relTime, clockTime } from "../../../lib/format";
import { detailText, postJSON } from "./useEvidence";
import { VERDIKT_OPEN, type AutofixState, type VerdiktPreview, type VerdiktRun, type VerdiktSettings, type VerdiktShot } from "./evidenceTypes";
import { AUTOFIX_CSS, AutofixOverride, AutofixStatus } from "./AutofixPanel";

export const VERDIKT_SETUP_HREF = "/settings#tab=github-access";

const STATUS_TEXT: Record<string, string> = {
  queued: "Queued in Verdikt",
  running: "Verdikt is testing…",
  completed: "Verdikt finished",
  failed: "Verdikt run failed",
  unavailable: "Verdikt unavailable",
  timeout: "Verdikt timed out",
  cancelled: "Verdikt run cancelled",
};

/** "Open in Verdikt": the run's page (or, before any run, the project) in Verdikt's own UI. */
export function verdiktOpenHref(taskId: string, runId?: string | null): string {
  return "/api/tasks/" + encodeURIComponent(taskId) + "/verdikt/open" + (runId ? "?run=" + encodeURIComponent(runId) : "");
}

function OpenInVerdikt({ href, label = "Open in Verdikt", testId }: { href: string; label?: string; testId?: string }) {
  return (
    <ButtonLink size="sm" variant="ghost" icon="ext" href={href} target="_blank" rel="noreferrer" data-testid={testId}
      title="Opens Verdikt's own page for this in a new tab">
      {label}
    </ButtonLink>
  );
}

/** The preview behind a run: starting / ready (+ link) / failed (+ log lines) / stopped. */
export function VerdiktPreviewLine({ preview }: { preview: VerdiktPreview }) {
  const [log, setLog] = useState<string[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    if (!showLog) return;
    let live = true;
    fetch(preview.log_url)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { lines?: string[] }) => { if (live) setLog(Array.isArray(d.lines) ? d.lines : []); })
      .catch(() => { if (live) setLog(null); });
    return () => { live = false; };
  }, [showLog, preview.log_url, preview.status]);
  const tail = preview.log_tail ? preview.log_tail.split("\n") : [];
  const lines = showLog && log ? log : tail;
  const of = preview.branch ? <> of <span className="ev-code">{preview.branch}</span></> : null;
  let text;
  if (preview.status === "requested" || preview.status === "starting") {
    text = <span className="ev-shimmer">Starting preview…</span>;
  } else if (preview.status === "ready") {
    text = <span>Preview ready at <span className="ev-code">{preview.verdikt_url}</span></span>;
  } else if (preview.status === "failed") {
    text = (
      <>
        <span className="ev-glyph ev-bad" aria-hidden="true"><Icon name="alert" cls="" /></span>
        <span>Preview failed: {preview.error || "unknown error"}</span>
      </>
    );
  } else {
    text = <span className="ev-mut">Preview stopped{preview.stop_reason ? ": " + preview.stop_reason : ""}</span>;
  }
  return (
    <div className="ev-pv" data-testid="verdikt-preview" data-status={preview.status}>
      <div className="ev-vk-line">
        <span className="ev-part" role={preview.status === "failed" ? "alert" : undefined}>
          {text}
        </span>
        {of && preview.status !== "failed" ? <span className="ev-part ev-mut">{of}</span> : null}
        <span className="ev-vk-actions">
          {preview.open_url ? (
            <ButtonLink size="sm" variant="secondary" icon="ext" href={preview.open_url} target="_blank" rel="noreferrer" data-act="verdikt-preview-open"
              title="Open the running preview in a new tab">Preview</ButtonLink>
          ) : null}
          {tail.length ? (
            <Button size="sm" variant="ghost" aria-expanded={showLog} data-act="verdikt-preview-log" onClick={() => setShowLog((v) => !v)}>
              {showLog ? "Hide log" : "Log"}
            </Button>
          ) : null}
        </span>
      </div>
      {lines.length && (showLog || preview.status === "failed") ? (
        <pre className="ev-pv-log" aria-label="Preview log">{(showLog ? lines : lines.slice(-6)).join("\n")}</pre>
      ) : null}
    </div>
  );
}

function outcomeGlyph(o: string | null | undefined) {
  if (o === "pass") return <span className="ev-glyph ev-ok" title="pass"><Icon name="check" cls="" /></span>;
  if (o === "fail") return <span className="ev-glyph ev-bad" title="fail"><Icon name="x" cls="" /></span>;
  if (o === "warning") return <span className="ev-glyph ev-warn" title="warning"><Icon name="alert" cls="" /></span>;
  return <span className="ev-glyph ev-mut" title={o || "no verdict"}><Icon name="dot" cls="" /></span>;
}

/**
 * One screenshot. Its `url` is the portal's artifact proxy (same origin, so the session
 * applies and a Docker-only Verdikt host never reaches the browser). If the proxy can't
 * produce the image (Verdikt stopped, the run folder was cleaned up) the tile says so
 * instead of showing a broken image.
 */
export function VerdiktShotTile({ shot }: { shot: VerdiktShot }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="ev-shot ev-shot-miss" title={shot.label} data-testid="verdikt-shot-missing">
        <span className="ev-shot-ph">Screenshot unavailable — Verdikt didn't return it</span>
        <span>{shot.label}</span>
      </span>
    );
  }
  return (
    <a className="ev-shot" href={shot.url} target="_blank" rel="noreferrer" title={shot.label}>
      <img src={shot.url} alt={shot.label} loading="lazy" onError={() => setFailed(true)} />
      <span>{shot.label}</span>
    </a>
  );
}

export interface VerdiktPanelProps {
  taskId: string;
  latest: VerdiktRun | null;
  /** the acting human (null → actions disabled with `noActorReason`) */
  actorId: string | null;
  noActorReason?: string;
  /** called with the run the server returned after an action (to refresh the pack) */
  onChanged?: (run: VerdiktRun | null) => void;
  /** list the per-criterion verdicts (off inside the evidence pack, whose DoD checklist
   *  already shows each verdict against its line — D12: one fact, one place) */
  showCriteria?: boolean;
  /** preview URLs the agent reported (a web run falls back to the first one when the
   *  project has no target URL) — with neither, the URL field is shown up front */
  previewUrls?: string[];
}

export function VerdiktPanel({ taskId, latest, actorId, noActorReason, onChanged, showCriteria = true, previewUrls }: VerdiktPanelProps) {
  const [settings, setSettings] = useState<VerdiktSettings | null>(null);
  const [history, setHistory] = useState<VerdiktRun[]>([]);
  const [autofix, setAutofix] = useState<AutofixState | null>(null);
  const [settingsErr, setSettingsErr] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [askUrl, setAskUrl] = useState(false);

  const load = useCallback(() => {
    fetch("/api/tasks/" + encodeURIComponent(taskId) + "/verdikt/runs")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { settings: VerdiktSettings; runs?: VerdiktRun[]; autofix?: AutofixState }) => {
        setSettings(d.settings);
        setHistory(Array.isArray(d.runs) ? d.runs : []);
        setAutofix(d.autofix && typeof d.autofix === "object" && "override" in d.autofix ? d.autofix : null);
        setSettingsErr(false);
      })
      .catch(() => setSettingsErr(true));
  }, [taskId]);
  // reload the history when the latest run changes (a new run, or it finished)
  useEffect(load, [load, latest?.id, latest?.status]);

  const run = latest;
  const open = !!run && VERDIKT_OPEN.indexOf(run.status) >= 0;
  const enabled = !!settings?.enabled && !!settings?.configured;
  // a web project with no target URL and no preview URL from the agent: ask for one up front
  // instead of letting the first press fail with "no target"
  const needsUrl = enabled && settings?.target_kind === "web" && !settings?.target_locator && !(previewUrls && previewUrls.length);
  const showUrl = askUrl || needsUrl;

  const trigger = async (locator?: string) => {
    if (!actorId) return;
    setBusy("run");
    setErr(null);
    const r = await postJSON<VerdiktRun>("/api/tasks/" + encodeURIComponent(taskId) + "/verdikt/runs", {
      actor_agent_id: actorId,
      ...(locator ? { locator } : {}),
    });
    setBusy(null);
    if (r.ok) {
      setAskUrl(false);
      onChanged?.(r.d);
    } else {
      const det = detailText(r.d);
      if (r.status === 400 && /no target/.test(det)) setAskUrl(true);
      setErr((r.status ? "HTTP " + r.status : "Not sent") + (det ? " — " + det : ""));
    }
  };
  const act = async (what: "cancel" | "refresh") => {
    if (!run) return;
    setBusy(what);
    setErr(null);
    const r = await postJSON<VerdiktRun>(
      "/api/tasks/" + encodeURIComponent(taskId) + "/verdikt/runs/" + encodeURIComponent(run.id) + "/" + what,
      what === "cancel" ? { actor_agent_id: actorId } : {},
    );
    setBusy(null);
    if (r.ok) onChanged?.(r.d);
    else setErr((r.status ? "HTTP " + r.status : "Not sent") + (detailText(r.d) ? " — " + detailText(r.d) : ""));
  };

  const canOpen = !!run || !!settings?.base_url;
  const header = (
    <div className="ev-sec-h">
      <span>Verdikt</span>
      <span className="v2-grow" />
      {canOpen ? <OpenInVerdikt href={verdiktOpenHref(taskId, run?.id)} testId="verdikt-open" /> : null}
    </div>
  );
  const pv = run?.preview || null;
  const previewPhase = !!pv && !!run && run.status === "queued" && !run.verdikt_request_id;
  const hasPreviewField = !!settings && "preview_command" in settings;
  const earlier = history.filter((h) => h.id !== run?.id);

  // ---- not set up (and nothing ran before) → one quiet line + link
  if (!run && settings && !enabled) {
    return (
      <section aria-label="Verdikt" data-testid="verdikt-panel">
        {header}
        <div className="ev-vk-line ev-mut">
          <span>Verdikt isn't set up for this project.</span>
          <ButtonLink variant="link" size="sm" href={VERDIKT_SETUP_HREF}>Set up</ButtonLink>
        </div>
      </section>
    );
  }

  const runBtn = (label: string) => (
    <Button
      size="sm"
      variant="secondary"
      icon={label === "Retry" ? "refresh" : "play"}
      data-act="verdikt-run"
      disabled={!actorId || !!busy || !enabled}
      busy={busy === "run"}
      title={!actorId ? noActorReason : !enabled ? "Verdikt isn't enabled for this project" : "Hand this task's definition of done to Verdikt"}
      onClick={() => void trigger(showUrl && url.trim() ? url.trim() : undefined)}
    >
      {label}
    </Button>
  );

  return (
    <section aria-label="Verdikt" data-testid="verdikt-panel">
      {header}
      <div className="ev-vk-line">
        {!run ? (
          <span className="ev-mut">{settingsErr ? "Verdikt settings could not be loaded." : settings ? "Not run for this task yet." : "Loading…"}</span>
        ) : (
          <>
            <span className={"ev-part" + (run.status === "running" ? "" : "")} data-status={run.status}>
              {run.status === "completed" ? outcomeGlyph(run.verdict) : null}
              <span className={run.status === "running" ? "ev-shimmer" : undefined}>
                {run.status === "completed" && run.verdict
                  ? `Verdict: ${run.verdict}`
                  : previewPhase ? "Waiting for the preview" : STATUS_TEXT[run.status] || run.status}
              </span>
            </span>
            <span className="ev-part ev-mut" title={run.created_at ? clockTime(run.created_at) : undefined}>
              {run.trigger === "auto" ? "auto" : "manual"} · {relTime(run.finished_at || run.created_at)}
            </span>
            <span className="ev-part ev-mut ev-code" title="What Verdikt tested">{run.target_kind}:{run.locator || "preview"}</span>
          </>
        )}
        <span className="ev-vk-actions">
          {open ? (
            <>
              <Button size="sm" variant="ghost" icon="refresh" data-act="verdikt-refresh" disabled={!!busy} busy={busy === "refresh"} onClick={() => void act("refresh")}>Check now</Button>
              <Button size="sm" variant="ghost" icon="stop" data-act="verdikt-cancel" disabled={!actorId || !!busy} busy={busy === "cancel"} title={!actorId ? noActorReason : "Stop waiting for this Verdikt run"} onClick={() => void act("cancel")}>Cancel</Button>
            </>
          ) : run ? (
            runBtn(run.status === "completed" ? "Run again" : "Retry")
          ) : (
            runBtn("Run in Verdikt")
          )}
        </span>
      </div>
      {run?.previous_round ? (
        <div className="ev-m" data-testid="verdikt-previous-round">From before the last rejection — it doesn't count for the rework. Run it again to check the new work.</div>
      ) : null}
      {autofix ? <AutofixStatus state={autofix} taskId={taskId} actorId={actorId} noActorReason={noActorReason} onChanged={(s) => { setAutofix(s); load(); }} /> : null}
      {pv ? <VerdiktPreviewLine preview={pv} /> : null}
      {!open && hasPreviewField && enabled && settings?.target_kind === "web" && (!pv || !settings?.preview_command) ? (
        settings?.preview_command ? (
          <div className="ev-m" data-testid="verdikt-preview-note">Verdikt will test a preview of this task's branch, built and served by the notifier.</div>
        ) : (
          <div className="ev-m" data-testid="verdikt-preview-note">
            No preview command set: Verdikt will test {settings?.target_locator ? <span className="ev-code">{settings.target_locator}</span> : "the URL you enter"}.
          </div>
        )
      ) : null}
      {run?.error && !(pv?.status === "failed" && run.error.startsWith("Preview failed")) ? (
        <div className="ev-err" role={run.status === "unavailable" || run.status === "failed" ? "alert" : undefined}>{run.error}</div>
      ) : null}
      {run?.reason && run.status === "completed" ? <div className="ev-m">{run.reason}</div> : null}
      {showCriteria && run && run.criteria && run.criteria.length ? (
        <ul className="ev-list" style={{ marginTop: 6 }} aria-label="Verdikt verdicts">
          {run.criteria.map((c) => (
            <li className="ev-item" key={c.dod_index}>
              {outcomeGlyph(c.outcome)}
              <div>
                <div className="ev-t">{c.text}</div>
                {c.outcome === "fail" || c.outcome === "warning" ? (
                  <div className="ev-m">
                    {c.expected ? "Expected " + c.expected : ""}
                    {c.expected && c.actual ? " · " : ""}
                    {c.actual ? "Actual " + c.actual : ""}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {run && run.handoff?.skipped_items && run.handoff.skipped_items.length ? (
        <div className="ev-m" style={{ marginTop: 4 }} title={run.handoff.skipped_items.map((s) => s.text).join("\n")}>
          {run.handoff.skipped_items.length} code-level DoD item{run.handoff.skipped_items.length === 1 ? "" : "s"} not sent — proven from the run itself.
        </div>
      ) : null}
      {run && run.screenshots && run.screenshots.length ? (
        <div className="ev-shots" aria-label="Verdikt screenshots">
          {run.screenshots.slice(0, 6).map((s) => (
            <VerdiktShotTile key={s.url} shot={s} />
          ))}
        </div>
      ) : null}
      {run && (run.report_url || run.video_url) ? (
        <div className="ev-links">
          {run.report_url ? (
            <a href={run.report_url} target="_blank" rel="noreferrer" title={"Opens Verdikt's report for run " + (run.verdikt_run_id || "").slice(0, 8)}>
              <Icon name="ext" cls="v2-ico" />Open Verdikt report
            </a>
          ) : null}
          {run.video_url ? (
            <a href={run.video_url} target="_blank" rel="noreferrer"><Icon name="play" cls="v2-ico" />Recording</a>
          ) : null}
        </div>
      ) : null}
      {showUrl && !open ? (
        <div className="ev-vk-line" style={{ marginTop: 6 }}>
          <label className="ev-m" htmlFor={"vk-url-" + taskId}>URL to test</label>
          <input
            id={"vk-url-" + taskId}
            className="ev-inp"
            style={{ flex: 1, minWidth: 180, height: 26, fontSize: 13 }}
            placeholder="http://localhost:3000"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
      ) : null}
      {err ? <div className="ev-err" role="alert">{err}</div> : null}
      {autofix && enabled ? <AutofixOverride state={autofix} taskId={taskId} actorId={actorId} onChanged={setAutofix} /> : null}
      {autofix ? <style>{AUTOFIX_CSS}</style> : null}
      {earlier.length ? (
        <details className="ev-vk-hist" data-testid="verdikt-history">
          <summary>Earlier runs ({earlier.length})</summary>
          <ul className="ev-list" aria-label="Earlier Verdikt runs">
            {earlier.map((h) => (
              <li className="ev-vk-row" key={h.id} data-run={h.id}>
                {h.status === "completed" ? outcomeGlyph(h.verdict) : <span className="ev-glyph ev-mut"><Icon name="dot" cls="" /></span>}
                <span className="ev-t">{h.status === "completed" && h.verdict ? `Verdict: ${h.verdict}` : STATUS_TEXT[h.status] || h.status}</span>
                <span className="ev-m">{h.trigger === "auto" ? "auto" : "manual"} · {relTime(h.finished_at || h.created_at)}</span>
                <span className="ev-m ev-code">{h.locator || "preview"}</span>
                <OpenInVerdikt href={verdiktOpenHref(taskId, h.id)} testId={"verdikt-open-" + h.id} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
