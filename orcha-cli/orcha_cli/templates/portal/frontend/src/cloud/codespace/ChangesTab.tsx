/**
 * Changes tab — "what have agents changed that isn't committed yet" (the
 * flagship working-tree view, docs/orcha-cloud-local-run.md addendum). Lists
 * every dirty file (status-lettered rows + per-file +/- counts, summary
 * header); clicking a row asks the parent (CodeSpacePage) to open that
 * file's unified diff in the center pane. Polls
 * code_workingtree_routes.get_worktree_changes every ~5s while mounted (the
 * tab is only mounted while active — ThreadRail unmounts non-active tab
 * bodies — so "while the tab is active" falls out of normal React lifecycle,
 * no visibility bookkeeping needed). Reports the dirty count back to
 * ThreadRail (onDirtyCountChange) so the tab-strip badge can render it —
 * that badge is therefore only known once the Changes tab has been opened
 * at least once in this mount (no background poll from other tabs); an
 * acceptable v1 tradeoff given the endpoint is only cheap to poll while the
 * tab a human is actually looking at.
 *
 * Commit/push UI (editor build addendum): a checkbox per row (checked by
 * default), a single-line growing commit-message input, and a "Commit N
 * files" button that POSTs only the CHECKED paths — a successful commit
 * toasts and forces an immediate re-poll (rather than waiting up to 5s for
 * the interval) so the list reflects the now-clean tree right away. Below
 * the list, a branch bar (name, "N ahead", Push) — hidden entirely when
 * GET .../worktree/branch itself reports unavailable, same honest-degrade
 * contract as the rest of this file.
 */
import { useEffect, useRef, useState } from "react";
import { useToast } from "../../components/ui";
import {
  commitWorktree,
  fetchWorktreeBranch,
  fetchWorktreeChanges,
  pushWorktree,
  type WorktreeBranchPayload,
  type WorktreeChangedFile,
  type WorktreeChangesPayload,
} from "./worktreeApi";

// 15s, not 5s: each poll is a real `git status` + numstat on the server —
// seconds on a big repo over a Docker-for-Mac bind mount (the server also
// caches for 10s, so faster polling was already a no-op). Skipped entirely
// while the tab/page is hidden.
const POLL_MS = 15000;

export interface ChangesTabProps {
  cid: string;
  selectedPath?: string | null;
  onOpenChange: (path: string) => void;
  // Reports the current dirty-file count on every poll (including the very
  // first fetch) so the parent (ThreadRail) can render a tab-strip badge
  // without duplicating the fetch/poll itself. Optional — a caller that
  // doesn't care about the badge (e.g. a test mounting ChangesTab standalone)
  // simply omits it.
  onDirtyCountChange?: (count: number) => void;
}

function statusLabel(status: WorktreeChangedFile["status"]): string {
  switch (status) {
    case "M": return "Modified";
    case "A": return "Added";
    case "D": return "Deleted";
    case "R": return "Renamed";
    default: return "Untracked";
  }
}

function CountBadge({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions == null && deletions == null) return <span className="muted cs-wt-bin">binary</span>;
  return (
    <>
      {additions ? <span className="a">+{additions}</span> : null}
      {deletions ? <span className="d">−{deletions}</span> : null}
    </>
  );
}

function BranchBar({ cid }: { cid: string }) {
  const toast = useToast();
  const [branch, setBranch] = useState<WorktreeBranchPayload | null>(null);
  const [pushing, setPushing] = useState(false);
  const token = useRef(0);

  const load = () => {
    const myToken = ++token.current;
    fetchWorktreeBranch(cid).then((data) => {
      if (myToken !== token.current) return;
      setBranch(data);
    });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  if (!branch || !branch.available) return null;

  const onPush = () => {
    setPushing(true);
    pushWorktree(cid).then((res) => {
      setPushing(false);
      if (res.ok) {
        toast(res.detail || "Pushed", "ok");
        load();
      } else {
        toast(res.detail || "Push failed", "danger");
      }
    });
  };

  return (
    <div className="cs-branch-bar">
      <span className="cs-branch-name mono">{branch.branch}</span>
      {branch.ahead ? <span className="cs-branch-ahead">{branch.ahead} ahead</span> : null}
      <span className="grow" />
      <button type="button" className="cs-branch-push-btn" onClick={onPush} disabled={pushing || !branch.ahead}>
        {pushing ? "Pushing…" : "Push"}
      </button>
    </div>
  );
}

export function ChangesTab({ cid, selectedPath, onOpenChange, onDirtyCountChange }: ChangesTabProps) {
  const toast = useToast();
  const [payload, setPayload] = useState<WorktreeChangesPayload | null>(null);
  const payloadRef = useRef<WorktreeChangesPayload | null>(null);
  payloadRef.current = payload;
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const token = useRef(0);
  const onDirtyCountChangeRef = useRef(onDirtyCountChange);
  onDirtyCountChangeRef.current = onDirtyCountChange;

  const poll = () => {
    const myToken = token.current;
    fetchWorktreeChanges(cid).then((data) => {
      if (myToken !== token.current) return;
      setPayload(data);
      onDirtyCountChangeRef.current?.(data.available ? (data.files ?? []).length : 0);
      // Default every NEW file to checked; drop any that are no longer dirty
      // (committed/reverted elsewhere) so a stale checkbox never lingers.
      setChecked((prev) => {
        const files = data.files ?? [];
        const next = new Set<string>();
        files.forEach((f) => {
          if (!prev.size || prev.has(f.path)) next.add(f.path);
        });
        return next;
      });
    });
  };

  useEffect(() => {
    let cancelled = false;
    const myToken = ++token.current;
    const tick = () => {
      if (cancelled || myToken !== token.current) return;
      poll();
    };
    tick();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      tick();
    }, POLL_MS);
    // While the server's FIRST scan is still running (payload.scanning), the
    // 15s cadence would leave the tab in limbo — poll fast until it settles.
    const fastId = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (payloadRef.current?.scanning) tick();
    }, 1500);
    return () => {
      window.clearInterval(fastId);
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  if (!payload) {
    return <div className="none" style={{ padding: 10 }}>Loading working-tree changes…</div>;
  }

  if (!payload.available) {
    if (payload.reason === "github_source") {
      return (
        <div className="none" style={{ padding: 10 }}>
          Working-tree changes need a local repository — this project is using a
          connected GitHub repo as its code source.
        </div>
      );
    }
    return <div className="none" style={{ padding: 10 }}>{payload.detail || "Working-tree changes are unavailable."}</div>;
  }

  const files = payload.files ?? [];
  const summary = payload.summary ?? { files: 0, additions: 0, deletions: 0 };

  const toggleChecked = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const checkedPaths = files.map((f) => f.path).filter((p) => checked.has(p));

  const onCommit = () => {
    if (!checkedPaths.length || !message.trim()) return;
    setCommitting(true);
    commitWorktree(cid, checkedPaths, message.trim()).then((res) => {
      setCommitting(false);
      if (res.ok) {
        toast("Committed " + res.short, "ok");
        setMessage("");
        poll();
      } else {
        toast("Nothing to commit", "warn");
      }
    });
  };

  return (
    <div className="cs-changes">
      <BranchBar cid={cid} />
      {!files.length ? (
        payload.scanning ? (
          <div className="none" style={{ padding: 10 }}>Scanning the working tree…</div>
        ) : (
          <div className="none" style={{ padding: 10 }}>Working tree clean — everything is committed.</div>
        )
      ) : (
        <>
          <div className="cs-changes-summary">
            <span>{summary.files} file{summary.files === 1 ? "" : "s"} changed</span>
            <span className="a">+{summary.additions}</span>
            <span className="d">−{summary.deletions}</span>
          </div>
          <div className="cs-changes-list">
            {files.map((f) => (
              <div
                key={f.path}
                className={"cs-changes-row" + (f.path === selectedPath ? " on" : "")}
                onClick={() => onOpenChange(f.path)}
                title={statusLabel(f.status)}
              >
                <input
                  type="checkbox"
                  className="cs-changes-row-check"
                  checked={checked.has(f.path)}
                  onChange={() => toggleChecked(f.path)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={"Include " + f.path + " in the next commit"}
                />
                <span className={"cs-changes-badge " + f.status.replace("?", "u")}>{f.status}</span>
                <span className="cs-changes-path mono">{f.path}</span>
                <span className="grow" />
                <CountBadge additions={f.additions} deletions={f.deletions} />
              </div>
            ))}
          </div>
          <div className="cs-changes-commit">
            <textarea
              className="cs-commit-msg"
              rows={1}
              placeholder="Commit message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <div className="cs-commit-row">
              <span className="grow" />
              <button
                type="button"
                className="cs-commit-btn"
                onClick={onCommit}
                disabled={committing || !checkedPaths.length || !message.trim()}
              >
                {committing ? "Committing…" : "Commit " + checkedPaths.length + " file" + (checkedPaths.length === 1 ? "" : "s")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
