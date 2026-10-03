/**
 * Live changes panel — a right-side inspector sheet (full screen on narrow widths)
 * showing what an agent's run is changing on disk: the changed-file list (status
 * letter + counts) and the selected file's diff, refreshed every ~1.5 s while the run
 * is live (the poller lives in the host — useRunChanges — so the header badge and this
 * panel share ONE request stream). When the run ends it switches to "Final changes"
 * (the reap-time captured diff). Every row and count is the server's git scan — the
 * panel never invents a diff.
 *
 * Reuse: the diff renders through the shared FilesChanged viewer (single-file mode),
 * status letters come from the Code tab's ChangesTab, and while the run is live its
 * streamed Edit/Write/MultiEdit tool events (the Code tab LivePanel's liveEdits
 * extraction) act as an IMMEDIATE signal: a new edit event triggers a re-scan right
 * away and marks that file as just edited, instead of waiting for the next poll.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, EmptyState, Inspector } from "../../components/primitives";
import { FilesChanged } from "../../components/FilesChanged";
import { BinaryDiffView, type BlobSource } from "../../components/filePreview/BinaryDiff";
import { runRawUrl } from "../../components/filePreview/sources";
import { statusLetter } from "../../cloud/codespace/ChangesTab";
import { extractLiveEdits, groupLiveEditsByFile } from "../../cloud/codespace/liveEdits";
import { useRunStream } from "../../hooks/useRunStream";
import { relTime } from "../../lib/format";
import type { WorkerRun } from "../activity/runModel";
import {
  fetchRunDiff, summaryText,
  type RunChangedFile, type RunChangesState, type RunDiffPayload,
} from "./liveChanges";
import "./liveChanges.css";

const STATUS_WORD: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", "??": "New file" };

function Counts({ f }: { f: RunChangedFile }) {
  if (f.binary) return <span className="lc-ct muted">binary</span>;
  if (f.additions == null && f.deletions == null) {
    return <span className="lc-ct muted">{f.status === "??" ? "new file" : f.status === "D" ? "deleted" : ""}</span>;
  }
  return (
    <span className="lc-ct">
      {f.additions ? <span className="a">+{f.additions}</span> : null}
      {f.deletions ? <span className="d">−{f.deletions}</span> : null}
    </span>
  );
}

/** "updated 2s ago", re-rendered every second while shown. */
function useAgo(at: number | null): string {
  const [, setN] = useState(0);
  useEffect(() => {
    if (at == null) return;
    const id = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [at]);
  if (at == null) return "";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? s + "s ago" : Math.round(s / 60) + "m ago";
}

/** The run's host checkout path, to turn a streamed absolute file_path into a repo path. */
function checkoutRoot(run: WorkerRun): string | null {
  return run.worktree || run.base_cwd || null;
}

function useStreamEdits(run: WorkerRun, live: boolean, onEdit: (path: string | null) => void) {
  // live only: a finished run's changes come from its captured diff
  const lines = useRunStream(live ? run : null);
  const cards = useMemo(() => groupLiveEditsByFile(extractLiveEdits(lines)), [lines]);
  const last = useRef(-1);
  const root = checkoutRoot(run);
  const top = cards[0];
  useEffect(() => {
    if (!top || top.lastSeq <= last.current) return;
    const first = last.current < 0;
    last.current = top.lastSeq;
    if (first) return; // edits that happened before the panel opened are already on disk
    const p = top.filePath;
    const rel = root && p.startsWith(root.replace(/\/+$/, "") + "/") ? p.slice(root.replace(/\/+$/, "").length + 1) : null;
    onEdit(rel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top?.lastSeq]);
}

export interface LiveChangesPanelProps {
  agentAlias: string;
  agentId: string;
  run: WorkerRun;
  live: boolean;
  state: RunChangesState;
  onClose: () => void;
}

export function LiveChangesPanel({ agentAlias, agentId, run, live, state, onClose }: LiveChangesPanelProps) {
  const rid = run.run_id || run.id || "";
  const { payload, error, checkedAt, fresh, refresh } = state;
  const files = payload && payload.available ? payload.files : [];
  const [pick, setPick] = useState<string | null>(null);
  const [edited, setEdited] = useState<string | null>(null);
  const selected = (pick && files.find((f) => f.path === pick)) || files[0] || null;
  const [diff, setDiff] = useState<{ key: string; data: RunDiffPayload } | null>(null);
  const diffToken = useRef(0);
  const ref = useRef<HTMLElement | null>(null);
  const ago = useAgo(checkedAt);

  useStreamEdits(run, live, (p) => {
    refresh();
    if (p) {
      setEdited(p);
      window.setTimeout(() => setEdited((cur) => (cur === p ? null : cur)), 4000);
    }
  });

  // one diff read per (file, its scan signature, version): unchanged polls never refetch,
  // and the previous diff stays on screen while a newer one loads (no flicker)
  const diffKey = selected ? rid + "|" + selected.path + "|" + selected.status + "|" + (selected.additions ?? "") + "|" + (selected.deletions ?? "") + "|" + (payload?.version || "") : "";
  useEffect(() => {
    if (!selected || !diffKey) return;
    const my = ++diffToken.current;
    fetchRunDiff(agentId, rid, selected.path)
      .then((data) => {
        if (my === diffToken.current) setDiff({ key: diffKey, data });
      })
      .catch(() => {
        if (my === diffToken.current) setDiff({ key: diffKey, data: { available: false, detail: "the diff could not be loaded" } });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffKey]);

  // Esc closes (unless an inner widget — e.g. the diff's full view — handled it)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const title = live ? "Live changes" : "Final changes";
  const statusLine = live ? (
    <span className="lc-status is-live">
      <span className="lc-dot" aria-hidden="true" />
      Live{ago ? " · updated " + ago : ""}
    </span>
  ) : (
    <span className="lc-status" title={run.ended_at ? new Date(run.ended_at).toLocaleString() : undefined}>
      {run.ended_at ? "Run ended " + relTime(run.ended_at) : "Run ended"}
    </span>
  );
  const meta = (
    <>
      {statusLine}
      {payload?.branch ? <span className="lc-branch mono" title={payload.branch}>{payload.branch}</span> : null}
      {payload && payload.available && payload.summary.files ? <span className="lc-sum">{summaryText(payload.summary)}</span> : null}
    </>
  );

  const version = payload?.version || "";
  const rawSource: BlobSource = (f, side) => runRawUrl(agentId, rid, f.path, side) + (version ? "&v=" + encodeURIComponent(version) : "");
  const selDiff = diff && selected && diff.key.startsWith(rid + "|" + selected.path + "|") ? diff.data : null;
  // a deleted file has nothing to open; an untracked one was never committed, so the
  // branch view Code opens would not have it — no link rather than a dead one
  const openInCode = selected && selected.status !== "D" && selected.status !== "??"
    ? "/code?path=" + encodeURIComponent(selected.path) + (payload?.root === "worktree" && payload.branch ? "&ref=" + encodeURIComponent(payload.branch) : "")
    : null;

  let body: React.ReactNode;
  if (!payload && !error) {
    body = <div className="lc-note" role="status">Loading changes…</div>;
  } else if (!payload && error) {
    body = <EmptyState compact icon="info" title="Changes unavailable" body="The changes endpoint did not respond. It retries on the next refresh." />;
  } else if (payload && !payload.available) {
    body = (
      <EmptyState
        compact
        icon="info"
        title={payload.reason === "not_captured" ? "No diff was recorded" : "Changes unavailable"}
        body={payload.detail || "This run's changes can't be read."}
      />
    );
  } else if (!files.length) {
    body = live ? (
      <EmptyState compact icon="git" title="No file changes yet" body={agentAlias + " is reading or running commands — edits show up here as they land."} />
    ) : (
      <EmptyState compact icon="check" title="No file changes" body="This run finished without changing any files." />
    );
  } else {
    body = (
      <>
        {payload?.shared_checkout ? (
          <div className="lc-note" title="Conversation runs with worktrees disabled work in the project's main checkout">
            Main checkout — may include edits not made by this run.
          </div>
        ) : null}
        {payload?.root === "worktree" && payload.base?.kind === "head" ? (
          <div className="lc-note">Compared with the branch's last commit (no origin/main to diff against).</div>
        ) : null}
        <ul className="lc-files" role="listbox" aria-label="Changed files">
          {files.map((f) => {
            const on = selected?.path === f.path;
            return (
              <li
                key={f.path}
                role="option"
                aria-selected={on}
                tabIndex={0}
                className={"lc-row" + (on ? " on" : "") + (fresh.has(f.path) ? " is-fresh" : "")}
                title={(STATUS_WORD[f.status] || f.status) + (f.orig_path ? " from " + f.orig_path : "")}
                onClick={() => setPick(f.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPick(f.path);
                  }
                }}
              >
                <span className={"lc-badge s-" + (f.status === "??" ? "u" : f.status)} aria-label={STATUS_WORD[f.status] || f.status}>
                  {statusLetter(f.status)}
                </span>
                <span className="lc-path mono">{f.path}</span>
                {edited === f.path ? <span className="lc-editing">editing</span> : null}
                <Counts f={f} />
              </li>
            );
          })}
        </ul>
        {payload?.truncated ? <div className="lc-note">Showing the first {files.length} files.</div> : null}
        {selected ? (
          <section className="lc-diff" aria-label={"Diff of " + selected.path}>
            {openInCode ? (
              <div className="lc-diff-h">
                <span className="grow" />
                <Link
                  className="v2-btn v2-btn-ghost v2-btn-sm lc-open-code"
                  to={openInCode}
                  title={payload?.root === "worktree" && payload.branch ? "Open the committed file on " + payload.branch + " in Code" : "Open this file in Code"}
                >
                  <span className="v2-btn-label">Open in Code</span>
                </Link>
              </div>
            ) : null}
            {!selDiff ? (
              <div className="lc-note" role="status">Loading diff…</div>
            ) : !selDiff.available ? (
              <div className="lc-note">{selDiff.detail || "This diff is unavailable."}</div>
            ) : selDiff.binary ? (
              // images compare before/after; other binaries get a sized card —
              // the version pins each fetch to this poll's state of the file
              <BinaryDiffView
                key={selected.path + "|" + (payload?.version || "")}
                file={{ path: selected.path, old: selected.orig_path || undefined, status: selected.status }}
                source={rawSource}
              />
            ) : (
              <>
                {selDiff.truncated ? <div className="lc-note">Diff truncated — showing a partial view.</div> : null}
                <FilesChanged diff={selDiff.diff} hideSummary blobSource={rawSource} />
              </>
            )}
          </section>
        ) : null}
      </>
    );
  }

  return (
    <aside className="lc-sheet" ref={ref} tabIndex={-1} aria-label={title + " — " + agentAlias} data-live={live ? "true" : "false"}>
      <Inspector
        title={title}
        meta={meta}
        onClose={onClose}
        label={title}
      >
        {body}
      </Inspector>
    </aside>
  );
}

/** The workspace / working-row / board entry point: "Live changes 3 files +42 −7". */
export function LiveChangesButton({ live, summary, open, onClick, size = "sm", className }: {
  live: boolean;
  summary?: { files: number; additions: number; deletions: number } | null;
  open?: boolean;
  onClick: () => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const label = live ? "Live changes" : "View changes";
  const counts = summary && summary.files ? summary : null;
  return (
    <Button
      size={size}
      variant="secondary"
      pill
      className={"lc-btn" + (live ? " is-live" : "") + (className ? " " + className : "")}
      aria-expanded={open}
      aria-label={label + (counts ? " — " + summaryText(counts) : "")}
      title={live ? "See the files this run is changing, as it works" : "See the files this run changed"}
      onClick={onClick}
    >
      {live ? <span className="lc-dot" aria-hidden="true" /> : null}
      {label}
      {counts ? (
        <span className="lc-btn-ct" aria-hidden="true">
          {counts.files} {counts.files === 1 ? "file" : "files"} <span className="a">+{counts.additions}</span> <span className="d">−{counts.deletions}</span>
        </span>
      ) : null}
    </Button>
  );
}
