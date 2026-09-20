/**
 * Task Code Space — a read-only, full-window verification surface.
 *
 * It deliberately reuses the existing repository browse state/components and
 * the run's captured diff. The task/run association already lives in
 * GET /api/tasks/{id}/runs, so no second source of truth or filesystem-path API
 * is introduced. The run's immutable snapshot drives the file tree/viewer;
 * its captured net diff drives the verifier-facing Changes mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FilesChanged } from "../../components/FilesChanged";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { Run } from "../../types";
import {
  BrowseErrorBody,
  BrowseSkeletonPane,
  BrowseTree,
  CodeLines,
  ContentPaneChrome,
} from "../shared/browseTree";
import { useBrowseTree } from "../shared/useBrowseTree";
import { readTaskCodeSpaceOrigin } from "./taskCodeSpace";

type ReviewMode = "file" | "diff";

interface RunsPayload {
  runs?: Run[];
}

function shortRun(run: Run | null): string {
  const id = run?.run_id || run?.id || "";
  return id ? id.slice(0, 8) : "";
}

export function TaskCodeSpacePage() {
  const { snap, cid } = useSnapshot();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const taskId = params.get("task") || "";
  const requestedRunId = params.get("run");
  const path = params.get("path") || "";
  const mode: ReviewMode = params.get("view") === "file" ? "file" : "diff";
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);
  const tokenRef = useRef(0);

  const task = snap?.tasks.find((candidate) => candidate.id === taskId) || null;

  useEffect(() => {
    if (!taskId) return;
    const token = ++tokenRef.current;
    setRuns(null);
    setRunsFailed(false);
    fetch("/api/tasks/" + encodeURIComponent(taskId) + "/runs")
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((payload: Run[] | RunsPayload) => {
        if (token !== tokenRef.current) return;
        setRuns(Array.isArray(payload) ? payload : payload.runs || []);
      })
      .catch(() => {
        if (token !== tokenRef.current) return;
        setRunsFailed(true);
        setRuns([]);
      });
  }, [taskId]);

  const run = useMemo(() => {
    if (!runs) return null;
    if (requestedRunId) {
      return runs.find((candidate) => (candidate.run_id || candidate.id) === requestedRunId) || null;
    }
    return runs.find((candidate) => candidate.branch || candidate.diff) || runs[0] || null;
  }, [requestedRunId, runs]);

  const runId = run?.run_id || run?.id || "";
  const gitRef = run?.snapshot_ref || "";
  const browseCid = runId && gitRef ? (cid || "") : "";
  const { dirCache, expanded, rows, toggleDir, retryDir, filePayload, fileError, fileLoading } =
    useBrowseTree(browseCid, gitRef, path, runId || undefined);

  const changeParams = useCallback((changes: Record<string, string | null>) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      Object.entries(changes).forEach(([key, value]) => {
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
      });
      return next;
    });
  }, [setParams]);

  const close = useCallback(() => {
    const origin = readTaskCodeSpaceOrigin(taskId);
    navigate(origin.href);
    // The Tasks page remounts after navigate. Two animation frames let its
    // detail/thread DOM settle before restoring the exact reading position.
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: origin.scrollY })));
  }, [navigate, taskId]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // FilesChanged owns its own expanded overlay. First Escape collapses
      // that overlay; a second Escape closes Code Space.
      if (document.querySelector(".dfv-full")) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [close]);

  useEffect(() => {
    document.title = task?.title ? task.title + " · Code Space · Orcha" : "Code Space · Orcha";
    return () => { document.title = "Orcha"; };
  }, [task?.title]);

  if (!cid) return null;

  const branchLabel = run?.branch || "repository HEAD";
  const snapshotAvailable = Boolean(runId && gitRef);
  const sourceLabel = gitRef ? `snapshot ${gitRef.slice(0, 7)}` : "snapshot unavailable";
  const diffCaptured = run?.diff != null;
  const runActive = run?.status === "running";

  return (
    <div className="tcs-shell" data-task-code-space="true">
      <header className="tcs-ribbon">
        <div className="tcs-title-block">
          <div className="tcs-kicker">Reviewing agent code</div>
          <h1>{task?.title || "Task code"}</h1>
        </div>
        <div className="tcs-source" aria-label="Code source">
          <span className="tcs-branch mono" title={gitRef || branchLabel}>{sourceLabel}</span>
          {run ? <span>{run.status}{shortRun(run) ? " run" : ""}</span> : <span>Finding the latest run…</span>}
        </div>
        <div className="tcs-mode" role="tablist" aria-label="Code review mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "file"}
            className={mode === "file" ? "on" : ""}
            onClick={() => changeParams({ view: "file" })}
          >
            Files
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "diff"}
            className={mode === "diff" ? "on" : ""}
            onClick={() => changeParams({ view: "diff" })}
          >
            Changes vs main
          </button>
        </div>
        <button type="button" className="tcs-close" onClick={close} aria-label="Close code space">
          <span aria-hidden="true">×</span> Close
        </button>
      </header>

      <div className="tcs-workspace">
        <aside className="tcs-tree" aria-label="Run snapshot files">
          <div className="tcs-tree-head">
            <span>Run snapshot</span>
            <span className="mono" title={gitRef || branchLabel}>
              {gitRef ? gitRef.slice(0, 7) : "unavailable"}
            </span>
          </div>
          <div className="tcs-tree-scroll">
            {snapshotAvailable ? (
              <BrowseTree
                rows={rows}
                dirCache={dirCache}
                expanded={expanded}
                selectedPath={path}
                onToggleDir={toggleDir}
                onRetryDir={retryDir}
                onSelectFile={(selectedPath) => changeParams({ path: selectedPath, view: "file" })}
              />
            ) : null}
          </div>
        </aside>

        <main className="tcs-main">
          {runsFailed ? (
            <div className="tcs-empty">
              <strong>Run details are unavailable.</strong>
              <span>Return to the task and retry when the run feed is available.</span>
            </div>
          ) : runs && !run ? (
            <div className="tcs-empty">
              <strong>No agent run is attached to this task yet.</strong>
              <span>Code Space becomes available after an agent starts work.</span>
            </div>
          ) : mode === "diff" ? (
            <section className="tcs-diff" aria-label="Task changes compared with main">
              <div className="tcs-pane-head">
                <div>
                  <strong>Changes vs main</strong>
                  <span>The verifier view captured from this agent run.</span>
                </div>
                {runId ? <span className="tag mono" title={runId}>run {shortRun(run)}</span> : null}
              </div>
              <div className="tcs-diff-scroll">
                {!runs ? (
                  <BrowseSkeletonPane />
                ) : !diffCaptured ? (
                  <div className="tcs-empty">
                    <strong>{runActive ? "Run capture is still pending." : "A captured diff is unavailable for this run."}</strong>
                    <span>{runActive ? "Changes will appear after the agent run finishes." : "This run finished without a reviewable diff capture."}</span>
                  </div>
                ) : (
                  <FilesChanged diff={run.diff || ""} />
                )}
              </div>
            </section>
          ) : !snapshotAvailable ? (
            <div className="tcs-empty">
              <strong>An immutable file snapshot is unavailable for this run.</strong>
              <span>The captured diff is still available. Files are hidden so later branch changes cannot be mistaken for reviewed code.</span>
            </div>
          ) : !path ? (
            <div className="tcs-empty">
              <strong>Choose a file from the run snapshot.</strong>
              <span>The viewer is read-only and keeps syntax highlighting on.</span>
            </div>
          ) : fileLoading || (filePayload && filePayload.path !== path) ? (
            <BrowseSkeletonPane />
          ) : fileError ? (
            <BrowseErrorBody err={fileError} what="File" />
          ) : filePayload ? (
            <div className="tcs-file-scroll">
              <ContentPaneChrome gitRef={gitRef} payload={filePayload}>
                <CodeLines content={filePayload.content || ""} path={filePayload.path} />
              </ContentPaneChrome>
            </div>
          ) : (
            <BrowseSkeletonPane />
          )}
        </main>
      </div>
      <div className="tcs-mobile-note">Code review needs a larger screen. Open this task on desktop or web.</div>
    </div>
  );
}
