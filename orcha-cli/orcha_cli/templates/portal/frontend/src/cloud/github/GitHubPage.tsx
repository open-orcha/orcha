/**
 * GitHub hub page — React + TypeScript port of the vanilla cloud page
 * (static/github.html + pages/github-{state,render,boot}.js), emitting the
 * SAME class names so the carried github.css + shared styles apply as-is.
 *
 * One SPA route (/github) hosts the Issues/PRs list AND every item's detail
 * view via ?pr=N / ?issue=N (react-router search params replace the vanilla
 * pushState/popstate wiring). The shared 3s snapshot poll rides context
 * (SnapshotProvider); issues/pulls are a heavier GitHub-backed fetch that
 * refreshes on load, on tab switch, and on a 60s timer — never the 3s tick.
 * Volatile UI (search text, sub-tab, dropdowns, <details> expansion) lives in
 * useState so the poll never clobbers typing.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getJSON } from "../../api/client";
import { DiffFile, FilesChanged } from "../../components/FilesChanged";
import { Icon, useToast } from "../../components/ui";
import { hue, mdText, relTime } from "../../lib/format";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import { Shell } from "../../shell/Shell";
import type { Agent, Task } from "../../types";
import { CloudIcon } from "../projects/icons";
import { useDebouncedValue } from "./browse/useDebounce";
import { RepoBrowser } from "./browse/RepoBrowser";
import { ConnectRepoModal } from "./ConnectRepoModal";
import { isLocalRepo } from "./connectRepo";
import "./connectRepo.css";
import { RepoBadge } from "./RepoBadge";
import {
  authorsFromRows,
  buildPullsQuery,
  CHECKS_BATCH_CAP,
  CLEAN_STATES,
  classifyDetailError,
  classifyError,
  dispatchLabel,
  EMPTY_PULLS_FILTER,
  fixOutstandingItems,
  hasActivePullsFilter,
  isLocalSourcePayload,
  labelColors,
  matchesFilter,
  matchesSearch,
  suggestAgents,
  topSuggestions,
  type ChecksRollup,
  type GhComment,
  type GhError,
  type GhFiles,
  type GhIssueDetail,
  type GhIssueRow,
  type GhItem,
  type GhKind,
  type GhLabel,
  type GhListPayload,
  type GhPullDetail,
  type GhPullRow,
  type GhRun,
  type Involvement,
  type PullsFilter,
  type TaskState,
} from "./ghlib";
import "./github.css";

/* ---- page-local icons (app-ui.js glyphs absent from the shared Icon map) -- */
const GH_ICONS: Record<string, string> = {
  issueDot: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.6" fill="currentColor" stroke="none"/>',
  pullArrow: '<circle cx="6" cy="5" r="2" fill="currentColor" stroke="none"/><circle cx="6" cy="15" r="2" fill="currentColor" stroke="none"/><circle cx="14" cy="8" r="2" fill="currentColor" stroke="none"/><path d="M6 7v6M14 10v3a2 2 0 0 1-2 2h-2M14 6V5"/><path d="M11.5 3.5 14 6l2.5-2.5"/>',
  ring: '<circle cx="10" cy="10" r="6"/>',
  info: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="6.6" r="0.9" fill="currentColor" stroke="none"/><path d="M10 9.6v4.4"/>',
};
function GhIcon({ name, cls = "gl" }: { name: string; cls?: string }) {
  const body = GH_ICONS[name];
  if (!body) return <Icon name={name} cls={cls} />;
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
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

/* ---- GitHub-login avatar (app-ui.js ghAvatar port) ------------------------ */
function GhAvatar({ login, size = "sm" }: { login: string | null | undefined; size?: string }) {
  const h = hue(login || "");
  const grad = `linear-gradient(140deg, hsl(${h} 70% 62%), hsl(${(h + 38) % 360} 72% 54%))`;
  const cls = "av gh" + (size ? " " + size : "") + " human";
  const init = (login || "?").trim().charAt(0).toUpperCase();
  return (
    <span className={cls} style={{ background: grad }}>
      {init}
      <img
        className="gh-face"
        src={`https://github.com/${encodeURIComponent(login || "")}.png?size=96`}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => e.currentTarget.remove()}
      />
    </span>
  );
}

/* ---- resolved theme (github-render.js ghResolvedTheme) -------------------- */
function ghResolvedTheme(): string {
  try {
    const t = localStorage.getItem("orcha:theme") || "auto";
    if (t === "dark" || t === "light") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/* ---- chips (github-state.js builders, same class names) ------------------- */
function ChecksChip({ rollup }: { rollup: ChecksRollup | null | undefined }) {
  if (rollup === null || rollup === undefined) {
    return <span className="tag gh-checks loading">checks…</span>;
  }
  const passed = rollup.passed || 0;
  const failing = rollup.failing || 0;
  const pending = rollup.pending || 0;
  const total = rollup.total != null ? rollup.total : passed + failing + pending;
  if (!total) return <span className="tag gh-checks zero">No checks</span>;
  if (failing > 0) return <span className="tag gh-checks fail"><Icon name="x" cls="gl" />{failing} failing</span>;
  if (pending > 0) return <span className="tag gh-checks pend"><GhIcon name="ring" cls="gl" />{pending} pending</span>;
  return <span className="tag gh-checks pass"><Icon name="check" cls="gl" />{passed} passed</span>;
}

function MergeChip({ pr }: { pr: GhPullRow }) {
  if (pr.draft) return <span className="tag gh-merge draft">Draft</span>;
  const st = pr.mergeable_state || "unknown";
  if (CLEAN_STATES[st]) return <span className="tag gh-merge ok"><Icon name="check" cls="gl" />Checks passed</span>;
  return <span className="tag gh-merge">Merge</span>;
}

// `.gh-reviewers.empty` (never `.none`) — see github.css's collision note.
function Reviewers({ logins }: { logins: string[] | undefined }) {
  const l = Array.isArray(logins) ? logins : [];
  if (!l.length) return <span className="gh-reviewers empty">—</span>;
  return (
    <span className="gh-reviewers">
      {l.slice(0, 3).map((r) => <GhAvatar key={r} login={r} />)}
      {l.length > 3 ? <span className="gh-more">+{l.length - 3}</span> : null}
    </span>
  );
}

function LabelChip({ label, theme }: { label: GhLabel | string; theme: string }) {
  const c = labelColors(label, theme);
  return (
    <span className="tag gh-label" style={{ background: c.bg, color: c.fg, borderColor: c.border }}>
      {c.name}
    </span>
  );
}

function StatePill({ kind, item }: { kind: GhKind; item: { draft?: boolean; state?: string | null } }) {
  if (kind === "pull") {
    if (item.draft) return <span className="pill s-idle gh-state-pill">Draft</span>;
    if (item.state === "closed") return <span className="pill s-bad gh-state-pill">Closed</span>;
    return <span className="pill s-ok gh-state-pill">Open</span>;
  }
  return item.state === "closed"
    ? <span className="pill s-acc gh-state-pill">Closed</span>
    : <span className="pill s-ok gh-state-pill">Open</span>;
}

function BranchChips({ base, head }: { base: string | null | undefined; head: string | null | undefined }) {
  return (
    <span className="gh-branch-chips">
      <span className="tag gh-branch-tag mono">{base || "?"}</span>
      <span className="gh-branch-arrow"><Icon name="arrow" cls="gl" /></span>
      <span className="tag gh-branch-tag mono">{head || "?"}</span>
    </span>
  );
}

/* ---- empty / error states ------------------------------------------------- */
function EmptyRepo({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">No repo connected</div>
      <p>Connect this project to a repository — this machine&#39;s own git repo, or GitHub — to see issues and pull requests here.</p>
      <button className="btn subtle sm" type="button" onClick={onConnect}>Connect repo</button>
    </div>
  );
}
// Orcha Cloud local run, Addendum 2 (hub degradation): the bound repo is the
// local git working tree, not GitHub — browse/Code Space keep working, only
// issues/PRs/checks are affected. Honest callout + a way to connect GitHub
// on top, reusing the settings sc-* banner idiom.
//
// Local-binding + GitHub-origin fall-through: this only renders when the
// fall-through DIDN'T happen (no origin, or an origin with no usable token —
// available:true payloads render the list normally instead). Two wordings:
// an `originDetected` repo names it specifically ("this clone comes from
// <owner/name> — add GitHub access"); no origin at all keeps the generic
// "connect GitHub repo" wording.
function LocalSourceCallout({ onConnect, originDetected }: { onConnect: () => void; originDetected?: string | null }) {
  const message = originDetected
    ? `This clone comes from ${originDetected} on GitHub — add GitHub access in Settings to see its issues & PRs.`
    : "Browsing the local repository. Connect a GitHub repo for issues, PRs, and checks.";
  return (
    <div className="gh-empty card-empty gh-local-callout">
      <div className="sc-banner muted">
        <div className="bt">
          <CloudIcon name="folder" cls="" />
          <span>{message}</span>
        </div>
      </div>
      <div className="sc-acts">
        {originDetected ? (
          <Link className="btn sm" to="/settings">
            <Icon name="link" cls="" />Add GitHub access
          </Link>
        ) : (
          <button className="btn sm" type="button" onClick={onConnect}>
            <Icon name="link" cls="" />Connect GitHub repo
          </button>
        )}
      </div>
    </div>
  );
}
function RateLimit({ detail }: { detail?: string | null }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">GitHub rate limit hit</div>
      <p>Backing off — this quietly retries on the next refresh.{detail ? " (" + detail + ")" : ""}</p>
    </div>
  );
}
function GenericError({ status, detail }: { status?: number; detail?: string | null }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">Couldn&#39;t load {status ? "(" + String(status) + ")" : ""}</div>
      <p>{detail ? detail : "Something went wrong talking to GitHub."}</p>
    </div>
  );
}
function DetailNotFound({ kind }: { kind: GhKind }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">{kind === "pull" ? "Pull request" : "Issue"} not found</div>
      <p>It may have been deleted, or the number doesn&#39;t exist in this repo.</p>
    </div>
  );
}
function GhErrorBody({ err, notFoundKind, onConnect }: { err: GhError; notFoundKind?: GhKind; onConnect: () => void }) {
  if (err.kind === "not_found" && notFoundKind) return <DetailNotFound kind={notFoundKind} />;
  if (err.kind === "local_source") return <LocalSourceCallout onConnect={onConnect} originDetected={err.originDetected} />;
  if (err.kind === "not_connected") return <EmptyRepo onConnect={onConnect} />;
  if (err.kind === "rate_limited") return <RateLimit detail={err.detail} />;
  return <GenericError status={err.status} detail={err.detail} />;
}

/* ---- skeleton loading states (modules/app-skeleton.js markup, verbatim) ----
   The vanilla page filled its first-load gap with OrchaSkeleton's shimmer
   ("list-rows" for the list, "detail-pane" for ?pr=/?issue=), styled by the
   shared skeleton.css that already ships in /assets/styles.css — same class
   contract here so the shimmer reads identically. The 120ms show delay
   (OrchaSkeleton.SHOW_DELAY_MS) is mirrored by the caller (useSkeletonReady)
   so a fast local response never flashes a skeleton at all. */
function GhSkeleton({ kind }: { kind: "list-rows" | "detail-pane" }) {
  if (kind === "detail-pane") {
    return (
      <div className="ork-sk-wrap" aria-hidden="true">
        <div className="ork-sk-line w50 lg"></div>
        <div className="ork-sk-line w80"></div>
        <div className="ork-sk-line w70"></div>
        <div className="ork-sk-block"></div>
        <div className="ork-sk-line w60"></div>
        <div className="ork-sk-line w40"></div>
      </div>
    );
  }
  return (
    <div className="ork-sk-wrap" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="ork-sk-row">
          <div className="ork-sk ork-sk-pill"></div>
          <div className="ork-sk-col">
            <div className="ork-sk-line w80"></div>
            <div className="ork-sk-line w30 sm"></div>
          </div>
        </div>
      ))}
    </div>
  );
}
// true once `resetKey`'s view has been unsettled for 120ms (OrchaSkeleton's
// SHOW_DELAY_MS) — the loading branch renders nothing until then, exactly like
// the vanilla show() timer, so warm loads never flash a skeleton.
function useSkeletonReady(resetKey: string): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const t = setTimeout(() => setReady(true), 120);
    return () => clearTimeout(t);
  }, [resetKey]);
  return ready;
}

/* ---- column header (wide viewports; CSS-hidden below the wrap breakpoint) - */
function ColumnHeader({ tab }: { tab: GhKind }) {
  return (
    <div className="ghhead-row" aria-hidden="true">
      <span className="ghh-ico"></span>
      <span className="ghh-num">ID</span>
      <span className="grow ghh-main">TITLE{tab === "pull" ? " / CONTEXT" : ""}</span>
      <span className="ghh-reviewers">REVIEWERS</span>
      <span className="ghh-checks">CHECKS</span>
      <span className="ghh-merge">MERGE</span>
      <span className="ghh-updated">UPDATED</span>
      <span className="ghh-actions"></span>
    </div>
  );
}

/* ---- Start / Fix split button + already-tracked chip ---------------------- */
interface StartCellProps {
  kind: GhKind;
  item: GhItem;
  taskState: TaskState | null;
  busy: boolean;
  ddOpen: boolean;
  onStart: (kind: GhKind, number: number) => void;
  onToggleDd: (anchor: HTMLElement, kind: GhKind, number: number) => void;
}
function StartCell({ kind, item, taskState, busy, ddOpen, onStart, onToggleDd }: StartCellProps) {
  if (taskState && taskState.task_id) {
    return (
      <Link
        className="dlink gh-task-chip"
        to={"/tasks?task=" + encodeURIComponent(taskState.task_id)}
        onClick={(e) => e.stopPropagation()}
      >
        <Icon name="tasks" cls="gl" />{taskState.task_id}
        {taskState.existing ? <span className="gh-already">already tracked</span> : null}
      </Link>
    );
  }
  const d = dispatchLabel(kind);
  return (
    <div className="gh-start-split">
      <button
        className="btn approve sm gh-start"
        type="button"
        disabled={busy}
        data-gh-start={kind}
        data-gh-number={item.number}
        title={d.tooltip}
        aria-label={d.tooltip}
        onClick={(e) => { e.stopPropagation(); onStart(kind, item.number); }}
      >
        {d.label} <Icon name="arrow" cls="gl" />
      </button>
      <button
        className="btn approve sm gh-start-dd"
        type="button"
        data-gh-start-dd={kind}
        data-gh-number={item.number}
        aria-haspopup="true"
        aria-expanded={ddOpen}
        title="Assign to an agent"
        onClick={(e) => { e.stopPropagation(); onToggleDd(e.currentTarget, kind, item.number); }}
      >
        <Icon name="chev" cls="gl" />
      </button>
    </div>
  );
}

/* ---- assignee dropdown roster (agentRosterHtml port) ---------------------- */
function AgentRoster({ kind, number, item, agents, onPick }: {
  kind: GhKind;
  number: number;
  item: GhItem | null;
  agents: Agent[];
  onPick: (agentId: string) => void;
}) {
  const list = (agents || []).filter((a) => a.kind === "ai");
  if (!list.length) return <div className="pm-row muted">No AI agents on this project</div>;
  const row = (a: Agent, reason?: string) => (
    <button
      key={a.id}
      className={"pm-row" + (reason !== undefined ? " gh-suggested-row" : "")}
      type="button"
      data-gh-assign={a.id}
      data-gh-kind={kind}
      data-gh-number={number}
      onClick={() => onPick(a.id)}
    >
      <span className="b">
        <span className="t1">{a.alias}</span>
        {reason ? <span className="t2">{reason}</span> : null}
      </span>
    </button>
  );
  const ranked = item ? suggestAgents(item, agents) : [];
  if (!ranked.length) return <>{list.map((a) => row(a))}</>;
  const suggested = topSuggestions(ranked);
  const suggestedIds = new Set(suggested.map((r) => r.agent.id));
  const rest = list.filter((a) => !suggestedIds.has(a.id));
  return (
    <>
      <div className="pm-head plain gh-suggest-head">Suggested</div>
      {suggested.map((r) => row(r.agent, r.tokens.join(" · ")))}
      {rest.length ? (
        <>
          <div className="pm-head plain gh-suggest-head">All agents</div>
          {rest.map((a) => row(a))}
        </>
      ) : null}
    </>
  );
}

// GitHub API status -> the viewer's M/A/D/R badge letters
const GH_STATUS: Record<string, "M" | "A" | "D" | "R"> = {
  modified: "M", changed: "M", added: "A", copied: "A", removed: "D", renamed: "R",
};

function FilesSection({ files, htmlUrl }: { files: GhFiles | undefined; htmlUrl: string | null | undefined }) {
  const f = files || {};
  const items = f.items || [];
  if (!items.length) return <div className="none" style={{ padding: 14 }}>No files changed.</div>;
  // The shared hierarchy viewer (FilesChanged): tree + filter + badges over the
  // per-file GitHub patches — same widget the run diffs use.
  const preparsed: DiffFile[] = items
    .filter((it) => !!it.filename)
    .map((it) => ({
      path: it.filename as string,
      old: it.filename as string,
      status: GH_STATUS[it.status || "modified"] || "M",
      add: it.additions || 0,
      del: it.deletions || 0,
      lines: it.patch_omitted
        ? ["(diff too large to show here — view it on GitHub)"]
        : (it.patch || "(no textual diff)").split("\n"),
    }));
  return (
    <div className="gh-files">
      <FilesChanged preparsed={preparsed} />
      {f.truncated ? <div className="gh-files-more muted">Showing the first {items.length} of {f.count} files.</div> : null}
      {f.patches_truncated ? (
        <div className="gh-files-more muted">
          Some diffs were too large to show here —{" "}
          <a href={htmlUrl || "#"} target="_blank" rel="noopener noreferrer">view the full diff on GitHub <Icon name="ext" cls="gl" /></a>.
        </div>
      ) : null}
    </div>
  );
}

/* ---- PR Checks tab -------------------------------------------------------- */
function RunRow({ run }: { run: GhRun }) {
  const completed = run.status === "completed";
  const conclusion = run.conclusion;
  let glyph = "ring";
  let cls = "pend";
  if (completed) {
    if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") { glyph = "check"; cls = "pass"; }
    else if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "action_required"
      || conclusion === "cancelled" || conclusion === "stale" || conclusion === "startup_failure") { glyph = "x"; cls = "fail"; }
    else { glyph = "ring"; cls = "pend"; }
  }
  const name = run.name || "check";
  return (
    <div className={`gh-run-row ${cls}`}>
      <span className={`gh-run-glyph ${cls}`}><GhIcon name={glyph} cls="gl" /></span>
      <span className="grow gh-run-name">{name}</span>
      <span className="gh-run-state">{completed ? (conclusion || "done") : (run.status || "queued")}</span>
      {run.html_url ? (
        <a className="gh-run-link" href={run.html_url} target="_blank" rel="noopener noreferrer"><Icon name="ext" cls="gl" /></a>
      ) : null}
    </div>
  );
}
function ChecksSection({ checks }: { checks: ChecksRollup | null | undefined }) {
  const runs = (checks && checks.runs) || [];
  if (!runs.length) return <div className="none" style={{ padding: 14 }}>No checks reported.</div>;
  return <div className="gh-runs">{runs.map((r, i) => <RunRow key={i} run={r} />)}</div>;
}

/* ---- right rail ------------------------------------------------------------ */
function PersonList({ logins }: { logins: string[] | undefined }) {
  const l = Array.isArray(logins) ? logins : [];
  if (!l.length) return <div className="none" style={{ padding: "10px 0" }}>None</div>;
  return (
    <div className="gh-people">
      {l.map((login) => (
        <span key={login} className="gh-person"><GhAvatar login={login} /><span>{login}</span></span>
      ))}
    </div>
  );
}
function ChecksSummary({ checks }: { checks: ChecksRollup | null | undefined }) {
  const r = checks || {};
  const total = r.total != null ? r.total : (r.passed || 0) + (r.failing || 0) + (r.pending || 0);
  if (!total) return <div className="none" style={{ padding: "10px 0" }}>No checks</div>;
  return (
    <div className="gh-checks-summary">
      {r.passed ? <span className="gh-cs-row pass"><Icon name="check" cls="gl" />{r.passed} passed</span> : null}
      {r.failing ? <span className="gh-cs-row fail"><Icon name="x" cls="gl" />{r.failing} failing</span> : null}
      {r.pending ? <span className="gh-cs-row pend"><GhIcon name="ring" cls="gl" />{r.pending} pending</span> : null}
    </div>
  );
}
function PullRail({ pull }: { pull: GhPullDetail }) {
  return (
    <aside className="gh-rail">
      <div className="card gh-rail-card">
        <div className="gh-rail-h">Status</div>
        <StatePill kind="pull" item={pull} />
      </div>
      <div className="card gh-rail-card">
        <div className="gh-rail-h">Assignees</div>
        <PersonList logins={pull.assignees} />
      </div>
      <div className="card gh-rail-card">
        <div className="gh-rail-h">Reviewers</div>
        <PersonList logins={pull.requested_reviewers} />
      </div>
      <div className="card gh-rail-card">
        <div className="gh-rail-h">Checks</div>
        <ChecksSummary checks={pull.checks} />
      </div>
    </aside>
  );
}

/* ---- issue comments -------------------------------------------------------- */
function CommentRow({ c, tasks }: { c: GhComment; tasks: Task[] }) {
  return (
    <div className="gh-comment">
      <GhAvatar login={c.author_login} />
      <div className="gh-comment-body">
        <div className="gh-comment-head">
          <span className="gh-comment-author">{c.author_login || "unknown"}</span>
          <span className="gh-comment-when">{relTime(c.created_at)}</span>
        </div>
        <div className="md gh-comment-text" dangerouslySetInnerHTML={{ __html: mdText(c.body_markdown || "", tasks) }} />
      </div>
    </div>
  );
}

/* ---- route shape ----------------------------------------------------------- */
interface GhRoute { kind: GhKind | null; number: number | null }
type ListKey = "issues" | "pulls";
// ?browse=1&ref=&path= — the Files sub-view (browse/RepoBrowser.tsx), mutually
// exclusive with ?pr=/?issue= the same way those two are mutually exclusive.
interface BrowseRoute { on: boolean; ref: string; path: string }
type DetailPayload = { __number: number; repo?: string | null; pull?: GhPullDetail; issue?: GhIssueDetail };
type NumberedError = GhError & { __number: number };

/* ============================================================================
   The page
   ============================================================================ */
export function GitHubPage() {
  const { snap, cid } = useSnapshot();
  const toast = useToast();
  const nav = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ---- route (?pr=N / ?issue=N), derived from the URL like readRouteFromUrl
  const route: GhRoute = useMemo(() => {
    const pr = searchParams.get("pr");
    if (pr && /^\d+$/.test(pr)) return { kind: "pull", number: Number(pr) };
    const issue = searchParams.get("issue");
    if (issue && /^\d+$/.test(issue)) return { kind: "issue", number: Number(issue) };
    return { kind: null, number: null };
  }, [searchParams]);
  const routeKey = route.kind ? route.kind + ":" + route.number : "list";

  // ---- browse route (?browse=1&ref=&path=) — the Files sub-view, checked
  // independently of ?pr=/?issue= (browse takes the mount over both, same as
  // a deep link to either of those takes it over the list).
  const browseRoute: BrowseRoute = useMemo(() => {
    const on = searchParams.get("browse") === "1";
    return { on, ref: searchParams.get("ref") || "HEAD", path: searchParams.get("path") || "" };
  }, [searchParams]);
  const gotoBrowse = useCallback((next: { ref?: string; path?: string } = {}, replace = false) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.delete("pr");
      p.delete("issue");
      p.set("browse", "1");
      const ref = next.ref !== undefined ? next.ref : p.get("ref") || "HEAD";
      const path = next.path !== undefined ? next.path : p.get("path") || "";
      if (ref) p.set("ref", ref); else p.delete("ref");
      if (path) p.set("path", path); else p.delete("path");
      return p;
    }, { replace });
  }, [setSearchParams]);
  const exitBrowse = useCallback(() => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.delete("browse");
      p.delete("ref");
      p.delete("path");
      return p;
    });
  }, [setSearchParams]);

  // ---- volatile UI state (never clobbered by the 3s snapshot re-render)
  const [tab, setTab] = useState<ListKey>(() => {
    // deep link seeds the tab (github-boot.js boot block): ?pr -> pulls,
    // ?issue -> issues, else the breadcrumb fallback ?tab= param.
    if (searchParams.get("pr") && /^\d+$/.test(searchParams.get("pr") || "")) return "pulls";
    if (searchParams.get("issue") && /^\d+$/.test(searchParams.get("issue") || "")) return "issues";
    const t = searchParams.get("tab");
    return t === "pulls" ? "pulls" : "issues";
  });
  const [filter, setFilter] = useState("open");
  const [query, setQuery] = useState("");
  const [detailSubTab, setDetailSubTab] = useState("conversation");

  // ---- PR-list server-backed filter bar (monorepo-scale repos): author input +
  // Assigned-to-me/My-reviews chips + free-text search. Only meaningful on the
  // pulls tab; the issues tab keeps its plain client-side "Mine"/free-text-title
  // behavior untouched. `query` above still drives client-side title filtering for
  // the NO-filter path (matchesSearch); pullsFilter.q takes over as the server
  // -backed search text once any filter is active (see the input's onChange below).
  const [pullsFilter, setPullsFilter] = useState<PullsFilter>(EMPTY_PULLS_FILTER);
  const debouncedPullsQ = useDebouncedValue(pullsFilter.q, 300);
  const pullsFilterActive = hasActivePullsFilter({ ...pullsFilter, q: debouncedPullsQ });
  // accumulated filtered pages (append on "Load more") — separate from `payload`,
  // which stays the single cached no-filter list.
  const [filteredPulls, setFilteredPulls] = useState<GhPullRow[]>([]);
  const [filteredMeta, setFilteredMeta] = useState<{ page: number; totalCount: number | null; hasMore: boolean } | null>(null);
  const [filteredLoading, setFilteredLoading] = useState(false);
  const [filteredError, setFilteredError] = useState<GhError | null>(null);
  const filteredReqToken = useRef(0);

  // ---- list payload/error slots (per tab, like github-render.js module state)
  const [payload, setPayload] = useState<Record<ListKey, GhListPayload | null>>({ issues: null, pulls: null });
  const [loadError, setLoadError] = useState<Record<ListKey, GhError | null>>({ issues: null, pulls: null });
  const loadingRef = useRef<Record<ListKey, boolean>>({ issues: false, pulls: false });
  const payloadRef = useRef(payload);
  payloadRef.current = payload;

  // progressive checks fill: number -> rollup, kept OUTSIDE payload so a
  // list refetch doesn't need to re-carry checks (vanilla checksByNumber).
  const [checksByNumber, setChecksByNumber] = useState<Record<number, ChecksRollup>>({});
  const checksRequested = useRef<Record<number, boolean>>({});

  // ---- detail slots (one per kind, __number-scoped like the vanilla)
  const [detailPayload, setDetailPayload] = useState<Record<GhKind, DetailPayload | null>>({ pull: null, issue: null });
  const [detailError, setDetailError] = useState<Record<GhKind, NumberedError | null>>({ pull: null, issue: null });
  const detailToken = useRef(0);
  const detailPayloadRef = useRef(detailPayload);
  detailPayloadRef.current = detailPayload;

  // ---- Start-click session cache (started tasks) + per-button busy flags
  const [started, setStarted] = useState<Record<GhKind, Record<number, TaskState>>>({ issue: {}, pull: {} });
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // ---- floating menus (assignee dropdown / Fix-info popover)
  const [dd, setDd] = useState<{ key: string; kind: GhKind; number: number; top: number; left: number } | null>(null);
  const [fixInfo, setFixInfo] = useState<{ number: number; top: number; left: number } | null>(null);
  const ddRef = useRef<HTMLDivElement | null>(null);
  const fixInfoRef = useRef<HTMLDivElement | null>(null);

  // ---- acting identity (GET /api/me?cid=… once per page load, data.js style)
  const [me, setMe] = useState<{ github_login?: string | null } | null>(null);
  useEffect(() => {
    if (!cid) return;
    let alive = true;
    getJSON<{ identity?: { github_login?: string | null } | null }>("/api/me?cid=" + encodeURIComponent(cid))
      .then((d) => { if (alive) setMe((d && d.identity) || null); })
      .catch(() => { if (alive) setMe(null); });
    return () => { alive = false; };
  }, [cid]);
  const myLogin = (me && me.github_login) || null;

  // ---- repo binding + Connect-repo picker (Orcha Cloud local run, Addendum 2)
  // GET /api/containers/{cid}/github -> {repo}; refetched whenever a list
  // payload lands too (payload.repo mirrors the same binding once it loads),
  // so the header badge is correct even before the first list response.
  const [binding, setBinding] = useState<string | null | undefined>(undefined);
  const [connectOpen, setConnectOpen] = useState(false);
  useEffect(() => {
    if (!cid) return;
    let alive = true;
    getJSON<{ repo?: string | null }>("/api/containers/" + encodeURIComponent(cid) + "/github")
      .then((d) => { if (alive) setBinding((d && d.repo) ?? null); })
      .catch(() => { if (alive) setBinding(null); });
    return () => { alive = false; };
  }, [cid]);
  // local-binding + GitHub-origin fall-through: the CONTAINER binding (`binding`,
  // straight off GET .../github) stays "local" even when the fall-through served
  // GitHub data — a hub payload's own `repo` field echoes the ORIGIN in that case
  // (see github_hub_routes' repo reassignment), never the "local" sentinel. `binding`
  // therefore wins whenever it's local, so the badge always renders the Local branch
  // for a local-bound container instead of being fooled into the plain-GitHub
  // branch by a fall-through payload's origin `repo`; the origin is surfaced
  // separately as a muted suffix (`fallthroughOriginRepo`) so BOTH truths show at
  // once rather than one silently overwriting the other.
  const hubPayloadRepo = (payload.issues && payload.issues.repo) || (payload.pulls && payload.pulls.repo) || null;
  const boundRepo = isLocalRepo(binding) ? binding : (hubPayloadRepo || binding || null);
  const fallthroughOriginRepo =
    isLocalRepo(binding) && hubPayloadRepo && !isLocalRepo(hubPayloadRepo) ? hubPayloadRepo : null;

  const theme = ghResolvedTheme();
  const agents = snap?.agents ?? [];
  const tasks = snap?.tasks ?? [];

  // vanilla ghSkeletonShow(): a fresh route/tab gets its own 120ms-delayed
  // skeleton window; a warm response settles before it and never flashes one.
  const skeletonReady = useSkeletonReady(routeKey + ":" + tab);

  /* ---- navigation (github-boot.js navigate()/data-gh-back) ---------------- */
  const goto = useCallback((next: GhRoute, replace = false) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.delete("pr");
      p.delete("issue");
      if (next.kind === "pull") p.set("pr", String(next.number));
      else if (next.kind === "issue") p.set("issue", String(next.number));
      return p;
    }, { replace });
  }, [setSearchParams]);

  // sub-tab resets on every route change, never persisted across items
  useEffect(() => { setDetailSubTab("conversation"); }, [routeKey]);

  /* ---- list load (github-render.js load()) -------------------------------- */
  const loadList = useCallback((key: ListKey, force: boolean) => {
    if (!cid || loadingRef.current[key]) return;
    if (!force && payloadRef.current[key]) return; // already have this tab's data
    loadingRef.current[key] = true;
    if (key === "pulls" && force) checksRequested.current = {}; // fresh list -> fresh fill pass
    fetch("/api/containers/" + encodeURIComponent(cid) + "/github/" + key)
      .then((r) => r.json().then((body) => ({ ok: r.ok, status: r.status, body })).catch(() => ({ ok: r.ok, status: r.status, body: null })))
      .then(({ ok, status, body }) => {
        if (!ok) { setLoadError((e) => ({ ...e, [key]: classifyError(status, body) })); return; }
        setPayload((p) => ({ ...p, [key]: body as GhListPayload }));
        setLoadError((e) => ({ ...e, [key]: null }));
      })
      .catch((e: Error) => { setLoadError((er) => ({ ...er, [key]: { kind: "error", status: 0, detail: e.message } })); })
      .then(() => { loadingRef.current[key] = false; });
  }, [cid]);

  /* ---- filtered pulls load (server-backed author=/involvement=/q=/page=) --
     A distinct fetch path from loadList("pulls", …): active filters go through
     GET .../github/pulls?…, appending pages into `filteredPulls` rather than
     replacing the single cached no-filter payload. */
  const loadFilteredPulls = useCallback((f: PullsFilter, page: number, append: boolean) => {
    if (!cid) return;
    const myToken = ++filteredReqToken.current;
    setFilteredLoading(true);
    fetch("/api/containers/" + encodeURIComponent(cid) + "/github/pulls" + buildPullsQuery(f, page))
      .then((r) => r.json().then((body) => ({ ok: r.ok, status: r.status, body })).catch(() => ({ ok: r.ok, status: r.status, body: null })))
      .then(({ ok, status, body }) => {
        if (myToken !== filteredReqToken.current) return; // superseded by a newer filter/page change
        if (!ok) {
          setFilteredError(classifyError(status, body));
          setFilteredLoading(false);
          return;
        }
        const b = body as GhListPayload;
        if (b && b.available === false) {
          setFilteredError(classifyError(status, body));
          setFilteredPulls(append ? (prev) => prev : []);
          setFilteredLoading(false);
          return;
        }
        const rows = (b && b.pulls) || [];
        setFilteredPulls((prev) => (append ? [...prev, ...rows] : rows));
        setFilteredMeta({ page: (b && b.page) || page, totalCount: (b && b.total_count) ?? null, hasMore: !!(b && b.has_more) });
        setFilteredError(null);
        setFilteredLoading(false);
      })
      .catch((e: Error) => {
        if (myToken !== filteredReqToken.current) return;
        setFilteredError({ kind: "error", status: 0, detail: e.message });
        setFilteredLoading(false);
      });
  }, [cid]);

  // filter (debounced q included) or tab change -> fresh fetch from page 1
  useEffect(() => {
    if (tab !== "pulls" || browseRoute.on) return;
    const f: PullsFilter = { ...pullsFilter, q: debouncedPullsQ };
    if (!hasActivePullsFilter(f)) { setFilteredPulls([]); setFilteredMeta(null); setFilteredError(null); return; }
    loadFilteredPulls(f, 1, false);
  }, [tab, pullsFilter.author, pullsFilter.involvement, debouncedPullsQ, browseRoute.on, loadFilteredPulls]);

  const loadMoreFilteredPulls = useCallback(() => {
    if (!filteredMeta || !filteredMeta.hasMore || filteredLoading) return;
    loadFilteredPulls({ ...pullsFilter, q: debouncedPullsQ }, filteredMeta.page + 1, true);
  }, [filteredMeta, filteredLoading, pullsFilter, debouncedPullsQ, loadFilteredPulls]);

  /* ---- detail load (github-render.js loadDetail(), token-guarded) --------- */
  const loadDetail = useCallback((kind: GhKind, number: number, force: boolean) => {
    if (!cid || !number) return;
    const cur = detailPayloadRef.current[kind];
    if (!force && cur && cur.__number === number) return; // already have it
    const myToken = ++detailToken.current;
    const path = kind === "pull" ? "pulls" : "issues";
    fetch("/api/containers/" + encodeURIComponent(cid) + "/github/" + path + "/" + encodeURIComponent(number))
      .then((r) => r.json().then((body) => ({ ok: r.ok, status: r.status, body })).catch(() => ({ ok: r.ok, status: r.status, body: null })))
      .then(({ ok, status, body }) => {
        if (myToken !== detailToken.current) return; // superseded by a newer route change
        if (!ok || !body || body.available === false) {
          setDetailError((e) => ({ ...e, [kind]: { __number: number, ...classifyDetailError(status, body) } }));
          setDetailPayload((p) => ({ ...p, [kind]: null }));
          return;
        }
        setDetailPayload((p) => ({ ...p, [kind]: { __number: number, ...body } as DetailPayload }));
        setDetailError((e) => ({ ...e, [kind]: null }));
      })
      .catch((e: Error) => {
        if (myToken !== detailToken.current) return;
        setDetailError((er) => ({ ...er, [kind]: { __number: number, kind: "error", status: 0, detail: e.message } }));
      });
  }, [cid]);

  // load the active route's data (boot + route/tab changes) — the browse
  // route owns its own data fetching (RepoBrowser talks to browse/* directly)
  // so the issues/pulls/detail loaders skip entirely while it's mounted.
  useEffect(() => {
    if (!cid || browseRoute.on) return;
    if (route.kind) loadDetail(route.kind, route.number as number, false);
    else loadList(tab, false);
  }, [cid, routeKey, tab, route.kind, route.number, loadDetail, loadList, browseRoute.on]);

  // 60s refresh cadence — heavier GitHub-backed fetches never ride the 3s tick
  const tickRef = useRef({ route, tab, loadList, loadDetail, browseOn: browseRoute.on });
  tickRef.current = { route, tab, loadList, loadDetail, browseOn: browseRoute.on };
  useEffect(() => {
    const iv = setInterval(() => {
      const t = tickRef.current;
      if (t.browseOn) return; // RepoBrowser owns its own fetch cadence
      if (t.route.kind) t.loadDetail(t.route.kind, t.route.number as number, true);
      else t.loadList(t.tab, true);
    }, 60000);
    return () => clearInterval(iv);
  }, []);

  /* ---- progressive checks fill (github-render.js maybeLoadChecks()) ------- */
  useEffect(() => {
    if (!cid || route.kind || tab !== "pulls") return;
    const items = payload.pulls ? payload.pulls.pulls || [] : null;
    if (!items) return;
    const wanted = items
      .filter((p) => (p.checks == null && checksByNumber[p.number] == null) && !checksRequested.current[p.number])
      .slice(0, CHECKS_BATCH_CAP)
      .map((p) => p.number);
    if (!wanted.length) return;
    wanted.forEach((n) => { checksRequested.current[n] = true; });
    fetch("/api/containers/" + encodeURIComponent(cid) + "/github/checks?numbers=" + wanted.join(","))
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { available?: boolean; checks?: Record<string, ChecksRollup> } | null) => {
        if (!body || body.available === false || !body.checks) return; // degrade quietly
        const incoming = body.checks;
        setChecksByNumber((prev) => {
          const next = { ...prev };
          Object.keys(incoming).forEach((numStr) => { next[Number(numStr)] = incoming[numStr]; });
          return next;
        });
      })
      .catch(() => { /* quiet degrade — chips stay on the "checks…" placeholder */ });
  }, [cid, route.kind, tab, payload.pulls, checksByNumber]);

  /* ---- started-task lookup (github-render.js startedOf()) ----------------- */
  const startedOf = useCallback((kind: GhKind, number: number): TaskState | null => {
    const m = started[kind][number];
    if (m) return m;
    // server-computed tracked_task_id: a task started via ANY path (another
    // session, Slack /orcha start) shows tracked on first load.
    const listKey: ListKey = kind === "pull" ? "pulls" : "issues";
    const lp = payload[listKey];
    const listItems = lp ? lp.issues || lp.pulls || [] : null;
    if (listItems) {
      const rowItem = (listItems as GhItem[]).find((it) => it.number === number);
      if (rowItem && rowItem.tracked_task_id) return { task_id: rowItem.tracked_task_id, existing: true };
    }
    const dp = detailPayload[kind];
    if (dp && dp.__number === number) {
      const item = kind === "pull" ? dp.pull : dp.issue;
      if (item && item.tracked_task_id) return { task_id: item.tracked_task_id, existing: true };
    }
    return null;
  }, [started, payload, detailPayload]);

  /* ---- Start flow (github-render.js postStart()) --------------------------
     Human-gated: the Start/Fix dispatch is a task-creating mutation, so it
     requires an acting human and carries their id as created_by_agent_id
     (the trust-off attribution convention task creation uses; the trusted
     proxy ignores it server-side). */
  const postStart = useCallback((kind: GhKind, number: number, assigneeAgentId: string | null) => {
    if (!cid) return;
    const who = actingHuman(snap);
    if (!who) { toast("Pick an acting human first", "warn"); return; }
    const busyKey = kind + ":" + number;
    setBusy((b) => ({ ...b, [busyKey]: true }));
    fetch("/api/containers/" + encodeURIComponent(cid) + "/github/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, number, assignee_agent_id: assigneeAgentId || undefined, created_by_agent_id: who.id }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, d })).catch(() => ({ ok: r.ok, status: r.status, d: {} as { task_id?: string; existing?: boolean; detail?: string } })))
      .then(({ ok, status, d }) => {
        if (!ok) {
          toast("Start failed (" + status + ")" + (d && d.detail ? ": " + d.detail : ""), "danger");
          setBusy((b) => ({ ...b, [busyKey]: false }));
          return;
        }
        setStarted((s) => ({ ...s, [kind]: { ...s[kind], [number]: { task_id: d.task_id as string, existing: !!d.existing } } }));
        toast(d.existing ? "Already tracked — " + d.task_id : "Task created", "ok");
        setBusy((b) => ({ ...b, [busyKey]: false }));
      })
      .catch((e: Error) => {
        toast("Start failed: " + e.message, "danger");
        setBusy((b) => ({ ...b, [busyKey]: false }));
      });
  }, [cid, snap, toast]);

  /* ---- floating menus wiring (outside click / Escape close) --------------- */
  useEffect(() => {
    if (!dd && !fixInfo) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (dd && !(ddRef.current && t && ddRef.current.contains(t)) && !(t && t.closest && t.closest("[data-gh-start-dd]"))) setDd(null);
      if (fixInfo && !(fixInfoRef.current && t && fixInfoRef.current.contains(t)) && !(t && t.closest && t.closest("[data-gh-fix-info]"))) setFixInfo(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setDd(null); setFixInfo(null); } };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [dd, fixInfo]);

  const toggleDd = useCallback((anchor: HTMLElement, kind: GhKind, number: number) => {
    const key = kind + ":" + number;
    setDd((cur) => {
      if (cur && cur.key === key) return null;
      const r = anchor.getBoundingClientRect();
      return { key, kind, number, top: Math.round(r.bottom + 6), left: Math.round(Math.max(8, r.right - 200)) };
    });
  }, []);
  const toggleFixInfo = useCallback((anchor: HTMLElement, number: number) => {
    setFixInfo((cur) => {
      if (cur && cur.number === number) return null;
      const r = anchor.getBoundingClientRect();
      return { number, top: Math.round(r.bottom + 6), left: Math.round(Math.max(8, r.right - 260)) };
    });
  }, []);

  // resolve the issue/PR object for the dropdown's suggestion scoring
  // (github-boot.js ghFindItem — list payload first, then detail payload)
  const findItem = useCallback((kind: GhKind, number: number): GhItem | null => {
    const listKey: ListKey = kind === "pull" ? "pulls" : "issues";
    const lp = payload[listKey];
    const list = lp ? lp.issues || lp.pulls : null;
    if (list) {
      const found = (list as GhItem[]).find((it) => it.number === number);
      if (found) return found;
    }
    const dp = detailPayload[kind];
    if (dp && dp.__number === number) return (kind === "pull" ? dp.pull : dp.issue) || null;
    return null;
  }, [payload, detailPayload]);

  /* ---- tab / filter / breadcrumb handlers --------------------------------- */
  const onTabClick = (next: ListKey) => {
    if (next === tab) return;
    setTab(next);
    setFilter("open");
    if (route.kind) goto({ kind: null, number: null }, true);
  };
  const onBack = (e: ReactMouseEvent) => {
    e.preventDefault();
    // arrived from the list this session -> history back keeps ?cid= etc.;
    // deep-linked with no history -> plain list route (the href fallback).
    if (window.history.length > 1) nav(-1);
    else goto({ kind: null, number: null });
  };

  /* ---- shared detail-header actions --------------------------------------- */
  const detailActions = (kind: GhKind, item: GhItem & { html_url?: string | null }, taskState: TaskState | null) => {
    const showFixInfo = kind === "pull" && !(taskState && taskState.task_id);
    return (
      <div className="gh-detail-actions">
        <StartCell
          kind={kind}
          item={item}
          taskState={taskState}
          busy={!!busy[kind + ":" + item.number]}
          ddOpen={dd?.key === kind + ":" + item.number}
          onStart={(k, n) => postStart(k, n, null)}
          onToggleDd={toggleDd}
        />
        {showFixInfo ? (
          <button
            className="iconbtn sm gh-fix-info"
            type="button"
            data-gh-fix-info={item.number}
            aria-haspopup="true"
            aria-expanded={fixInfo?.number === item.number}
            title="What will the dispatched agent do?"
            aria-label="What will the dispatched agent do?"
            onClick={(e) => { e.stopPropagation(); toggleFixInfo(e.currentTarget, item.number); }}
          >
            <GhIcon name="info" cls="gl" />
          </button>
        ) : null}
        <a className="btn ghost sm gh-open-ext" href={item.html_url || "#"} target="_blank" rel="noopener noreferrer">
          <Icon name="ext" cls="gl" />Open on GitHub
        </a>
        {kind === "pull" ? (
          <button
            type="button"
            className="btn ghost sm gh-browse-head"
            onClick={(e) => { e.stopPropagation(); gotoBrowse({ ref: `pr/${item.number}`, path: "" }); }}
          >
            <Icon name="search" cls="gl" />Browse head
          </button>
        ) : null}
      </div>
    );
  };

  const breadcrumb = (kind: GhKind, number: number, repo: string | null | undefined) => (
    <div className="gh-crumb">
      <a
        className="gh-crumb-back"
        href={"?" + (kind === "pull" ? "tab=pulls" : "tab=issues")}
        data-gh-back="1"
        onClick={onBack}
      >
        <GhIcon name="arrow" cls="gl gh-crumb-ico" /><span>{kind === "pull" ? "Pull requests" : "Issues"}</span>
      </a>
      <span className="gh-crumb-sep">·</span>
      <span className="gh-crumb-repo mono">{isLocalRepo(repo) ? "Local" : repo || ""}</span>
      <span className="gh-crumb-sep">·</span>
      <span className="gh-crumb-num">#{number}</span>
    </div>
  );

  /* ---- list rows ----------------------------------------------------------- */
  const issueRow = (it: GhIssueRow) => (
    <div
      key={it.number}
      className="ghrow"
      data-gh-row={`issue:${it.number}`}
      data-gh-open={`issue:${it.number}`}
      onClick={() => goto({ kind: "issue", number: it.number })}
    >
      <GhIcon name="issueDot" cls="gl gh-kind-ico issue" />
      <span className="gh-num mono">#{it.number}</span>
      <span className="grow gh-main">
        <span className="gh-title">{it.title}</span>
        <span className="gh-meta">
          {(it.labels || []).slice(0, 4).map((l, i) => <LabelChip key={i} label={l} theme={theme} />)}
          {it.assignee
            ? <span className="gh-assignee"><GhAvatar login={it.assignee} /><span>{it.assignee}</span></span>
            : <span className="tag gh-unassigned">Unassigned</span>}
        </span>
      </span>
      <span className="gh-reviewers-col"></span>
      <span className="gh-checks-col"></span>
      <span className="gh-merge-col"></span>
      <span className="gh-updated">{relTime(it.updated_at)}</span>
      <span className="gh-actions">
        <StartCell
          kind="issue"
          item={it}
          taskState={startedOf("issue", it.number)}
          busy={!!busy["issue:" + it.number]}
          ddOpen={dd?.key === "issue:" + it.number}
          onStart={(k, n) => postStart(k, n, null)}
          onToggleDd={toggleDd}
        />
      </span>
    </div>
  );

  const pullRow = (pr: GhPullRow) => (
    <div
      key={pr.number}
      className="ghrow"
      data-gh-row={`pull:${pr.number}`}
      data-gh-open={`pull:${pr.number}`}
      onClick={() => goto({ kind: "pull", number: pr.number })}
    >
      <GhIcon name="pullArrow" cls={"gl gh-kind-ico pull" + (pr.draft ? " draft" : "")} />
      <span className="gh-num mono">#{pr.number}</span>
      <span className="grow gh-main">
        <span className="gh-title">{pr.draft ? <span className="tag gh-draft">Draft</span> : null}{pr.title}</span>
        <span className="gh-meta"><span className="gh-branch mono">{pr.head || ""}</span></span>
      </span>
      <span className="gh-reviewers-col"><Reviewers logins={pr.requested_reviewers} /></span>
      <span className="gh-checks-col"><ChecksChip rollup={pr.checks} /></span>
      <span className="gh-merge-col"><MergeChip pr={pr} /></span>
      <span className="gh-updated">{relTime(pr.updated_at)}</span>
      <span className="gh-actions">
        <StartCell
          kind="pull"
          item={pr}
          taskState={startedOf("pull", pr.number)}
          busy={!!busy["pull:" + pr.number]}
          ddOpen={dd?.key === "pull:" + pr.number}
          onStart={(k, n) => postStart(k, n, null)}
          onToggleDd={toggleDd}
        />
      </span>
    </div>
  );

  /* ---- list body (github-state.js bodyHtml, skeleton gate folded in) ------- */
  // server-backed PR filter footer: "N of ~total" when GitHub's search gave an
  // honest total_count; otherwise just the loaded count (the list path has none).
  const loadMoreFooter = () => {
    if (!filteredMeta) return null;
    const shown = filteredPulls.length;
    const of = filteredMeta.totalCount != null ? `${shown} of ~${filteredMeta.totalCount}` : `${shown} loaded`;
    if (!filteredMeta.hasMore) {
      return <div className="gh-loadmore-done muted" style={{ padding: "10px 4px", fontSize: 12 }}>{of}</div>;
    }
    return (
      <button
        className="btn subtle sm gh-loadmore"
        type="button"
        style={{ width: "100%", margin: "8px 0 2px" }}
        disabled={filteredLoading}
        onClick={loadMoreFilteredPulls}
      >
        {filteredLoading ? "Loading…" : `Load more · ${of}`}
      </button>
    );
  };

  const listBody = () => {
    const key = tab;
    const kind: GhKind = key === "pulls" ? "pull" : "issue";

    // Server-backed filter path (pulls tab only): author=/involvement=/q= active
    // -> render the accumulated filtered/paginated pages instead of the plain
    // cached list; the Issues tab and the no-filter Pulls view are untouched.
    if (key === "pulls" && pullsFilterActive) {
      if (filteredError) return <GhErrorBody err={filteredError} onConnect={() => setConnectOpen(true)} />;
      if (!filteredPulls.length && filteredLoading) return skeletonReady ? <GhSkeleton kind="list-rows" /> : null;
      if (!filteredPulls.length) {
        return <div className="none" style={{ padding: 20 }}>No pull requests match this filter.</div>;
      }
      const rows = filteredPulls.map((p) => (p.checks == null && checksByNumber[p.number] != null ? { ...p, checks: checksByNumber[p.number] } : p));
      return (
        <>
          <ColumnHeader tab="pull" />
          {rows.map((it) => pullRow(it))}
          {loadMoreFooter()}
        </>
      );
    }

    const pl = payload[key];
    const err = loadError[key];
    // unsettled (no payload AND no error yet): the vanilla page's OrchaSkeleton
    // "list-rows" shimmer, behind the same 120ms show delay (nothing before it)
    if (pl == null && err == null) return skeletonReady ? <GhSkeleton kind="list-rows" /> : null;
    if (err) return <GhErrorBody err={err} onConnect={() => setConnectOpen(true)} />;
    // list endpoints answer HTTP 200 even when available:false (see ghlib's
    // classifyError docstring) — the local-run degrade never reaches loadError.
    if (isLocalSourcePayload(pl)) return <LocalSourceCallout onConnect={() => setConnectOpen(true)} originDetected={pl?.origin_detected} />;
    if (!pl || !pl.repo) return <EmptyRepo onConnect={() => setConnectOpen(true)} />;
    const rawItems: GhItem[] = (pl.issues || pl.pulls || []) as GhItem[];
    // merge the progressively-filled checks map onto still-null rollups
    const all = key === "pulls"
      ? (rawItems as GhPullRow[]).map((p) => (p.checks == null && checksByNumber[p.number] != null ? { ...p, checks: checksByNumber[p.number] } : p))
      : rawItems;
    const filtered = (all as GhItem[])
      .filter((it) => matchesFilter(kind, it, filter, myLogin))
      .filter((it) => matchesSearch(it, query));
    if (!filtered.length) {
      return (
        <div className="none" style={{ padding: 20 }}>
          {all.length
            ? "No " + (kind === "pull" ? "pull requests" : "issues") + " match this filter."
            : "No open " + (kind === "pull" ? "pull requests" : "issues") + "."}
        </div>
      );
    }
    return (
      <>
        <ColumnHeader tab={kind} />
        {filtered.map((it) => (kind === "pull" ? pullRow(it as GhPullRow) : issueRow(it as GhIssueRow)))}
      </>
    );
  };

  /* ---- PR detail (github-state.js prDetailHtml) ---------------------------- */
  const prDetail = (pull: GhPullDetail, repo: string | null | undefined) => {
    const checks = pull.checks || {};
    const total = checks.total != null ? checks.total : (checks.passed || 0) + (checks.failing || 0) + (checks.pending || 0);
    const filesCount = (pull.files && pull.files.count) || 0;
    const activeSub = detailSubTab || "conversation";
    const tabsDef = [
      { k: "conversation", label: "Conversation" },
      { k: "checks", label: `Checks (${total})` },
      { k: "files", label: `Files changed (${filesCount})` },
    ];
    return (
      <>
        {breadcrumb("pull", pull.number, repo)}
        <div className="gh-detail-layout">
          <div className="gh-detail-main">
            <div className="gh-detail-head">
              <h1 className="gh-detail-title">{pull.title} <span className="gh-detail-num mono">#{pull.number}</span></h1>
              <div className="gh-detail-chips">
                <StatePill kind="pull" item={pull} />
                <BranchChips base={pull.base} head={pull.head} />
                <span className="gh-detail-updated">Updated {relTime(pull.updated_at)}</span>
              </div>
              {detailActions("pull", pull, startedOf("pull", pull.number))}
            </div>
            <nav className="aut gh-subtabs" role="tablist" aria-label="Pull request sections">
              {tabsDef.map((t) => (
                <span
                  key={t.k}
                  className={"seg" + (t.k === activeSub ? " on" : "")}
                  role="tab"
                  tabIndex={0}
                  aria-selected={t.k === activeSub}
                  data-gh-subtab={t.k}
                  onClick={() => setDetailSubTab(t.k)}
                >
                  {t.label}
                </span>
              ))}
            </nav>
            <div className="card gh-subtab-body">
              {activeSub === "checks" ? (
                <ChecksSection checks={pull.checks} />
              ) : activeSub === "files" ? (
                <FilesSection files={pull.files} htmlUrl={pull.html_url} />
              ) : (
                <div className="md gh-conversation-body" dangerouslySetInnerHTML={{ __html: mdText(pull.body_markdown || "", tasks) }} />
              )}
            </div>
          </div>
          <PullRail pull={pull} />
        </div>
      </>
    );
  };

  /* ---- issue detail (github-state.js issueDetailHtml) ---------------------- */
  const issueDetail = (issue: GhIssueDetail, repo: string | null | undefined) => {
    const comments = issue.comments || [];
    return (
      <>
        {breadcrumb("issue", issue.number, repo)}
        <div className="gh-detail-layout">
          <div className="gh-detail-main">
            <div className="gh-detail-head">
              <h1 className="gh-detail-title">{issue.title} <span className="gh-detail-num mono">#{issue.number}</span></h1>
              <div className="gh-detail-chips">
                <StatePill kind="issue" item={issue} />
                {(issue.labels || []).map((l, i) => <LabelChip key={i} label={l} theme={theme} />)}
                <span className="gh-detail-updated">Updated {relTime(issue.updated_at)}</span>
              </div>
              {detailActions("issue", issue, startedOf("issue", issue.number))}
            </div>
            <div className="card gh-subtab-body">
              <div className="md gh-conversation-body" dangerouslySetInnerHTML={{ __html: mdText(issue.body_markdown || "", tasks) }} />
            </div>
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-h"><h3>Comments</h3><span className="count">{comments.length ? "(" + comments.length + ")" : ""}</span></div>
              <div className="card-b" style={{ padding: "14px 16px" }}>
                {comments.length
                  ? comments.map((c, i) => <CommentRow key={i} c={c} tasks={tasks} />)
                  : <div className="none">No comments yet.</div>}
              </div>
            </div>
          </div>
          <aside className="gh-rail">
            <div className="card gh-rail-card">
              <div className="gh-rail-h">Status</div>
              <StatePill kind="issue" item={issue} />
            </div>
            <div className="card gh-rail-card">
              <div className="gh-rail-h">Assignees</div>
              <PersonList logins={issue.assignees && issue.assignees.length ? issue.assignees : issue.assignee ? [issue.assignee] : []} />
            </div>
          </aside>
        </div>
      </>
    );
  };

  /* ---- detail body (github-state.js detailHtml degrade ladder) ------------- */
  const detailBody = () => {
    const kind = route.kind as GhKind;
    const number = route.number as number;
    const dp = detailPayload[kind];
    const p = dp && dp.__number === number ? dp : null;
    const de = detailError[kind];
    const err = de && de.__number === number ? de : null;
    if (!p && err) return <GhErrorBody err={err} notFoundKind={kind} onConnect={() => setConnectOpen(true)} />;
    const item = p ? (kind === "pull" ? p.pull : p.issue) : null;
    // no item yet (and no error) -> the vanilla "detail-pane" skeleton,
    // regardless of fetch timing (same 120ms show delay as the list)
    if (!item) return skeletonReady ? <GhSkeleton kind="detail-pane" /> : null;
    return kind === "pull" ? prDetail(item as GhPullDetail, p!.repo) : issueDetail(item as GhIssueDetail, p!.repo);
  };

  /* ---- filter chips (github-state.js filterChipsHtml) ---------------------- */
  const filterChips = () => {
    const kind: GhKind = tab === "pulls" ? "pull" : "issue";
    const chips: { k: string; label: string }[] = [{ k: "open", label: "Open" }, { k: "mine", label: "Mine" }];
    if (kind === "pull") chips.push({ k: "needs-review", label: "Needs review" });
    return chips.map((c) => (
      <button key={c.k} className={c.k === filter ? "on" : ""} data-gh-filter={c.k} onClick={() => setFilter(c.k)}>
        {c.label}
      </button>
    ));
  };

  /* ---- PR-list server-backed filter bar (monorepo-scale repos) -------------
     Author input (+ datalist of authors seen in loaded rows), Assigned-to-me/
     My-reviews chips (mutually exclusive; disabled+tooltip with no github_login
     on the acting identity), and the free-text search box lives in the header
     above (wired to pullsFilter.q on this tab — see the ghSearch input). */
  const pullsFilterBar = () => {
    const loadedRows: GhPullRow[] = [...((payload.pulls && payload.pulls.pulls) || []), ...filteredPulls];
    const authorOptions = authorsFromRows(loadedRows);
    const noIdentity = !myLogin;
    const chip = (key: Involvement, label: string) => {
      const on = pullsFilter.involvement === key;
      return (
        <button
          key={key || "none"}
          type="button"
          className={"tag gh-involve-chip" + (on ? " on" : "")}
          disabled={noIdentity}
          title={noIdentity ? "Link a GitHub login to use this filter" : undefined}
          aria-pressed={on}
          onClick={() => setPullsFilter((f) => ({ ...f, involvement: on ? null : key }))}
        >
          {label}
        </button>
      );
    };
    return (
      <div className="gh-pulls-filterbar" id="ghPullsFilterBar">
        <input
          className="gh-search-in gh-author-in"
          type="text"
          list="ghPullsAuthors"
          placeholder="Author…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Filter by author"
          value={pullsFilter.author}
          onChange={(e) => setPullsFilter((f) => ({ ...f, author: e.target.value }))}
        />
        <datalist id="ghPullsAuthors">
          {authorOptions.map((a) => <option key={a} value={a} />)}
        </datalist>
        {chip("assigned", "Assigned to me")}
        {chip("review_requested", "My reviews")}
      </div>
    );
  };

  /* ---- Fix-info popover content (fixInfoPopoverBodyHtml) ------------------- */
  const fixInfoBody = () => {
    const p = fixInfo && detailPayload.pull && detailPayload.pull.__number === fixInfo.number ? detailPayload.pull.pull : null;
    const items = fixOutstandingItems(p || ({} as GhPullDetail));
    return (
      <>
        <div className="pm-head plain">Fix dispatches an agent to:</div>
        {items.length ? (
          <ul className="gh-fix-info-list">{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
        ) : (
          <p className="muted">Review the PR&#39;s feedback and CI state and address anything outstanding.</p>
        )}
      </>
    );
  };

  /* ---- page ----------------------------------------------------------------- */
  return (
    <Shell page="github" title="GitHub" ctx={snap?.container?.name}>
      <div className="gh-wrap">
        <div className={"gh-head" + (route.kind || browseRoute.on ? " hidden" : "")} id="ghHead">
          <nav className="aut" id="ghTabs" role="tablist" aria-label="GitHub hub sections">
            <span
              className={"seg" + (tab === "issues" ? " on" : "")}
              role="tab"
              tabIndex={0}
              aria-selected={tab === "issues"}
              data-tab="issues"
              onClick={() => onTabClick("issues")}
            >
              Issues
            </span>
            <span
              className={"seg" + (tab === "pulls" ? " on" : "")}
              role="tab"
              tabIndex={0}
              aria-selected={tab === "pulls"}
              data-tab="pulls"
              onClick={() => onTabClick("pulls")}
            >
              Pull requests
            </span>
          </nav>
          <button type="button" className="btn subtle sm gh-browse-cta" onClick={() => gotoBrowse()}>
            <Icon name="search" cls="gl" />Browse files
          </button>
          {boundRepo ? (
            <RepoBadge repo={boundRepo} workspaceName={snap?.container?.name} originRepo={fallthroughOriginRepo} />
          ) : null}
          <button type="button" className="btn subtle sm" onClick={() => setConnectOpen(true)}>
            <CloudIcon name="folder" cls="gl" />{boundRepo ? "Change repo" : "Connect repo"}
          </button>
          <div className="grow"></div>
          <input
            id="ghSearch"
            className="gh-search-in"
            type="search"
            placeholder={tab === "pulls" ? "Search title or body…" : "Filter by title or #number…"}
            spellCheck={false}
            autoComplete="off"
            value={tab === "pulls" ? pullsFilter.q : query}
            onChange={(e) => (tab === "pulls"
              ? setPullsFilter((f) => ({ ...f, q: e.target.value }))
              : setQuery(e.target.value))}
          />
        </div>

        {browseRoute.on ? (
          <div className="gh-crumb">
            <a className="gh-crumb-back" href="?" data-gh-back="1" onClick={(e) => { e.preventDefault(); exitBrowse(); }}>
              <GhIcon name="arrow" cls="gl gh-crumb-ico" /><span>{tab === "pulls" ? "Pull requests" : "Issues"}</span>
            </a>
            <span className="gh-crumb-sep">·</span>
            <span className="gh-crumb-repo mono">Files</span>
          </div>
        ) : null}

        <div className="filters" id="ghFilters">{route.kind || browseRoute.on ? null : filterChips()}</div>
        {!route.kind && !browseRoute.on && tab === "pulls" ? pullsFilterBar() : null}

        {browseRoute.on ? (
          cid ? (
            <RepoBrowser
              cid={cid}
              gitRef={browseRoute.ref}
              path={browseRoute.path}
              // never build a github.com/local link for the local sentinel —
              // Orcha Cloud local run, Addendum 2 (RepoBadge deliverable).
              htmlUrlBase={boundRepo && !isLocalRepo(boundRepo) ? `https://github.com/${boundRepo}` : null}
              onNavigate={(next) => gotoBrowse(next, true)}
            />
          ) : null
        ) : (
          <div className={"card ghlist-card" + (route.kind ? " gh-detail-mode" : "")} id="ghlist">
            {route.kind ? detailBody() : listBody()}
          </div>
        )}
      </div>

      {connectOpen && cid ? (
        <ConnectRepoModal
          cid={cid}
          currentRepo={boundRepo}
          fallbackLocalName={snap?.container?.name || null}
          onClose={() => setConnectOpen(false)}
          onBound={(repo) => {
            setBinding(repo);
            // fresh binding invalidates every cached list/detail payload so
            // the hub re-fetches against the new repo instead of showing
            // stale rows from the previous connection.
            setPayload({ issues: null, pulls: null });
            setDetailPayload({ pull: null, issue: null });
            setLoadError({ issues: null, pulls: null });
            checksRequested.current = {};
            setChecksByNumber({});
          }}
        />
      ) : null}

      {dd
        ? createPortal(
            <div
              ref={ddRef}
              id="ghAssignMenu"
              className="pmenu float show"
              style={{ top: dd.top, left: dd.left, right: "auto" }}
            >
              <div className="pm-head plain">Assign to</div>
              <AgentRoster
                kind={dd.kind}
                number={dd.number}
                item={findItem(dd.kind, dd.number)}
                agents={agents}
                onPick={(agentId) => { const d = dd; setDd(null); postStart(d.kind, d.number, agentId); }}
              />
            </div>,
            document.body,
          )
        : null}

      {fixInfo
        ? createPortal(
            <div
              ref={fixInfoRef}
              id="ghFixInfoMenu"
              className="pmenu float gh-fix-info-pop show"
              style={{ top: fixInfo.top, left: fixInfo.left, right: "auto" }}
            >
              {fixInfoBody()}
            </div>,
            document.body,
          )
        : null}
    </Shell>
  );
}
