/**
 * GitHub hub page — React + TypeScript port of the vanilla cloud page
 * (static/github.html + pages/github-{state,render,boot}.js).
 *
 * One SPA route (/github) hosts the Issues/PRs list AND every item's detail
 * view via ?pr=N / ?issue=N (react-router search params replace the vanilla
 * pushState/popstate wiring). The shared 3s snapshot poll rides context
 * (SnapshotProvider); issues/pulls are a heavier GitHub-backed fetch that
 * refreshes on load, on tab switch, and on a 60s timer — never the 3s tick.
 * Volatile UI (search text, sub-tab, dropdowns, <details> expansion) lives in
 * useState so the poll never clobbers typing.
 *
 * Linear layout (directives D5–D12):
 *  - list = Linear "My issues": a filter-pill toolbar in the Shell's fixed
 *    toolbar slot, one-line 38px rows (muted #id · state glyph · title · chips
 *    · avatars · time) grouped under D8 band headers (PRs by GitHub's merge
 *    state, issues by whether Orcha already tracks them);
 *  - detail = Linear issue: header row (glyph · #id · title … circle actions
 *    · "2 / 5 ↑↓"), a large title, one muted meta line, a compact Orcha
 *    dispatch card, the description, an Activity timeline, and a
 *    PropertyRail on the right.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { getJSON } from "../../api/client";
import { DiffFile, FilesChanged, type BlobSource } from "../../components/FilesChanged";
import { refBlobSource } from "../../components/filePreview/sources";
import { Icon, useToast } from "../../components/ui";
import {
  Avatar,
  AvatarStack,
  Button,
  ButtonLink,
  Chip,
  IconButton,
  Menu,
  MenuButton,
  Popover,
  StatusGlyph,
  Tabs,
  Tooltip,
  rowNavKeyDown,
  statusLabel,
  type MenuItemSpec,
} from "../../components/primitives";
import { FilterPills } from "../../components/primitives";
import { useScrollEdges } from "../../components/primitives/FilterPills";
import { iconButtonClass } from "../../components/primitives";
import { ListGroup } from "../../components/primitives";
import { Property, PropertyRail, PropertySection } from "../../components/primitives";
import { RelTime, Timeline, TimelineComment, TimelineEvent } from "../../components/primitives";
import { mdText, relTime } from "../../lib/format";
import { actingHuman, snapshotErrorKind, useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { repoConnectBlockedReason } from "./repoPermissions";
import { PageHeader, PageToolbar, Pager } from "../../shell/PageChrome";
import { Shell } from "../../shell/Shell";
import type { Agent, Task } from "../../types";
import { CloudIcon } from "../projects/icons";
import { useDebouncedValue } from "./browse/useDebounce";
import { RepoBrowser } from "./browse/RepoBrowser";
import { RepoNotConnected } from "./RepoNotConnected";
import { ConnectRepoModal } from "./ConnectRepoModal";
import { isLocalRepo } from "./connectRepo";
import "./connectRepo.css";
import { RepoBadge } from "./RepoBadge";
import {
  authorsFromRows,
  buildPullsQuery,
  CHECKS_BATCH_CAP,
  classifyDetailError,
  classifyError,
  dispatchLabel,
  unavailableError,
  EMPTY_PULLS_FILTER,
  fixOutstandingItems,
  hasActivePullsFilter,
  fillMissingChecks,
  EMPTY_ISSUES_FILTER,
  issueFacets,
  matchesIssuesFilter,
  UNASSIGNED,
  type IssuesFilter,
  isLocalSourcePayload,
  labelDot,
  matchesFilter,
  mergeStateLabel,
  matchesSearch,
  suggestAgents,
  topSuggestions,
  trackedTaskLabel,
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

/* ---- page-local GitHub glyphs (not task-status glyphs: GitHub's own issue /
   PR / check shapes, coloured by GitHub state via CSS classes) ------------- */
const GH_ICONS: Record<string, string> = {
  issueDot: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.4" fill="currentColor" stroke="none"/>',
  issueDone: '<circle cx="10" cy="10" r="7"/><path d="m7 10.2 2.1 2.1L13.2 8"/>',
  pullArrow: '<circle cx="6" cy="5" r="1.9"/><circle cx="6" cy="15" r="1.9"/><circle cx="14" cy="15" r="1.9"/><path d="M6 6.9v6.2M14 13.1V8.4a2 2 0 0 0-2-2H9.4"/><path d="m11 4.6-1.8 1.8L11 8.2"/>',
  pullDraft: '<circle cx="6" cy="5" r="1.9"/><circle cx="6" cy="15" r="1.9"/><circle cx="14" cy="15" r="1.9"/><path d="M6 6.9v6.2M14 11.6v-.8M14 8.2v-.8M14 4.8V4"/>',
  ring: '<circle cx="10" cy="10" r="6"/>',
  info: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="6.6" r="0.9" fill="currentColor" stroke="none"/><path d="M10 9.6v4.4"/>',
  // D8: the failed ✕ and the cancelled slash belong to task states — merge
  // conflicts get a ring + "!" and "blocked" the task set's ring + bar (no-entry).
  conflict: '<circle cx="10" cy="10" r="7"/><path d="M10 6.2v4.6"/><circle cx="10" cy="13.6" r=".9" fill="currentColor" stroke="none"/>',
  blocked: '<circle cx="10" cy="10" r="7"/><path d="M6.6 10h6.8"/>',
  unstable: '<path d="M10 3.2 17.2 16H2.8z"/><path d="M10 8.2v3.4"/><circle cx="10" cy="13.7" r=".7" fill="currentColor" stroke="none"/>',
  merge: '<circle cx="10" cy="10" r="7"/><path d="m7 10.2 2.1 2.1L13.2 8"/>',
  behind: '<circle cx="10" cy="10" r="7"/><path d="M10 6.4v7.2M7 10.6l3 3 3-3"/>',
  unknown: '<circle cx="10" cy="10" r="7" stroke-dasharray="2.2 2.4"/>',
  // "Tracked in Orcha" band: a neutral issue ring with an arrow in (handed to
  // Orcha) — muted like every other band glyph, never accent-coloured
  tracked: '<circle cx="10" cy="10" r="7"/><path d="M6.8 10h6M10.6 7.6 13 10l-2.4 2.4"/>',
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
      focusable="false"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

/** GitHub state glyph for an item: PR open / draft / closed, issue open / closed. */
function KindGlyph({ kind, item }: { kind: GhKind; item: { draft?: boolean; state?: string | null } }) {
  if (kind === "pull") {
    if (item.draft) return <GhIcon name="pullDraft" cls="gl gh-kind-ico pull is-draft" />;
    if (item.state === "closed") return <GhIcon name="pullArrow" cls="gl gh-kind-ico pull is-closed" />;
    return <GhIcon name="pullArrow" cls="gl gh-kind-ico pull is-open" />;
  }
  if (item.state === "closed") return <GhIcon name="issueDone" cls="gl gh-kind-ico issue is-closed" />;
  return <GhIcon name="issueDot" cls="gl gh-kind-ico issue is-open" />;
}

/* ---- people: D7 round avatars (GitHub logins; the image falls back to initials) */
function GhAvatar({ login, size = 20, decorative }: { login: string | null | undefined; size?: 16 | 20 | 24; decorative?: boolean }) {
  return <Avatar alias={login || "unknown"} ghLogin={login || null} size={size} decorative={decorative} label={login || "Unknown"} />;
}

/* ---- chips (D8: rounded-full, 1px border, coloured icon/dot + neutral text) */
function checksTotal(r: ChecksRollup): number {
  return r.total != null ? r.total : (r.passed || 0) + (r.failing || 0) + (r.pending || 0);
}
function ChecksChip({ rollup, unavailable }: { rollup: ChecksRollup | null | undefined; unavailable?: boolean }) {
  if (rollup === null || rollup === undefined) {
    // unknown ≠ zero: a failed checks fetch says so instead of spinning forever
    if (unavailable) return <span className="gh-checks zero" title="Couldn't load checks from GitHub">Checks unavailable</span>;
    return <span className="gh-checks loading" title="Loading checks from GitHub">checks…</span>;
  }
  const passed = rollup.passed || 0;
  const failing = rollup.failing || 0;
  const pending = rollup.pending || 0;
  const total = checksTotal(rollup);
  if (!total) return <span className="gh-checks zero">No checks</span>;
  const title = [passed ? `${passed} passed` : "", failing ? `${failing} failing` : "", pending ? `${pending} pending` : ""].filter(Boolean).join(" · ");
  if (failing > 0) return <Chip size="sm" className="gh-checks fail" title={title} icon={<Icon name="x" cls="gl" />}>{failing} failing</Chip>;
  if (pending > 0) return <Chip size="sm" className="gh-checks pend" title={title} icon={<GhIcon name="ring" cls="gl" />}>{pending} pending</Chip>;
  return <Chip size="sm" className="gh-checks pass" title={title} icon={<Icon name="check" cls="gl" />}>{passed} passed</Chip>;
}

// GitHub's mergeability in its own words (Mergeable / Blocked / Conflicts /
// Unstable / Behind / Draft) — never "Checks passed", which contradicted a
// pending check shown right beside it.
const MERGE_GLYPH: Record<string, string> = {
  Mergeable: "merge", Blocked: "blocked", Conflicts: "conflict", Unstable: "unstable", Behind: "behind", Draft: "pullDraft", Unknown: "unknown",
};
function MergeState({ pr }: { pr: { mergeable_state?: string | null; draft?: boolean } }) {
  const m = mergeStateLabel(pr.mergeable_state, pr.draft);
  return (
    <span className={"gh-merge " + m.tone} title={m.hint}>
      <GhIcon name={MERGE_GLYPH[m.label] || "unknown"} cls="gl" />{m.label}
    </span>
  );
}

// neutral chip + a dot in the repo's label color (no saturated pills).
function LabelChip({ label }: { label: GhLabel | string }) {
  const c = labelDot(label);
  return (
    <Chip size="sm" className="gh-label" icon={<span className="gh-label-dot" style={{ background: c.color }} />}>
      {c.name}
    </Chip>
  );
}
function LabelChips({ labels, max }: { labels: (GhLabel | string)[] | undefined; max: number }) {
  const l = labels || [];
  if (!l.length) return null;
  const rest = l.slice(max);
  return (
    <>
      {l.slice(0, max).map((x, i) => <LabelChip key={i} label={x} />)}
      {rest.length ? (
        <span className="gh-more" title={rest.map((x) => labelDot(x).name).join(", ")}>+{rest.length}</span>
      ) : null}
    </>
  );
}

function stateWord(kind: GhKind, item: { draft?: boolean; state?: string | null }): string {
  if (kind === "pull" && item.draft) return "Draft";
  return item.state === "closed" ? "Closed" : "Open";
}
function StateValue({ kind, item }: { kind: GhKind; item: { draft?: boolean; state?: string | null } }) {
  return (
    <span className="gh-state">
      <KindGlyph kind={kind} item={item} />
      {stateWord(kind, item)}
    </span>
  );
}

/* ---- tracked Orcha task chip: the task TITLE (never the raw uuid) + its real
   status glyph; a router link styled as a D8 chip (v2-chip classes). */
function TrackedChip({ taskId, existing, tasks, size = "sm" }: { taskId: string; existing?: boolean; tasks: Task[]; size?: "sm" | "md" }) {
  const title = trackedTaskLabel(taskId, tasks);
  const task = tasks.find((t) => t.id === taskId);
  const status = task ? task.status : null;
  return (
    <Chip
      className="gh-task-chip"
      size={size}
      to={"/tasks?task=" + encodeURIComponent(taskId)}
      title={(existing ? "Already tracked: " : "Tracked: ") + title + (status ? " · " + statusLabel(status) : "")}
      onClick={(e) => e.stopPropagation()}
      icon={status ? <StatusGlyph status={status} size={13} /> : <Icon name="tasks" cls="gl" />}
    >
      {title}
    </Chip>
  );
}

/* ---- empty / error states -------------------------------------------------
   V2: every state names what happened and offers the recovery that really
   exists, with ONE primary action (the fix) and quiet secondary ones. */
// The shared not-connected state (RepoNotConnected) — Code Space renders the
// same component, so one condition has one look everywhere.
function EmptyRepo({ onConnect, blockedReason }: { onConnect: () => void; blockedReason?: string | null }) {
  return <RepoNotConnected onConnect={onConnect} disabledReason={blockedReason} />;
}
// Orcha Cloud local run, Addendum 2 (hub degradation): the bound repo is the
// local git working tree, not GitHub — browse/Code Space keep working, only
// issues/PRs/checks are affected. Honest callout + a way to connect GitHub
// on top.
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
      <div className="gh-empty-ico" aria-hidden="true"><CloudIcon name="folder" cls="" /></div>
      <p>{message}</p>
      <div className="gh-empty-acts">
        {originDetected ? (
          <ButtonLink variant="primary" icon="link" to="/settings#tab=github-access">Add GitHub access</ButtonLink>
        ) : (
          <Button variant="primary" icon="link" onClick={onConnect}>Connect GitHub repo</Button>
        )}
      </div>
    </div>
  );
}
/** A 403 that is about project membership, not the GitHub token (pure). */
export function isMembershipDenial(detail: string | null | undefined): boolean {
  return /not a member|member of (this|any) project/i.test(detail || "");
}
function RetryBtn({ onRetry, variant = "secondary" }: { onRetry?: () => void; variant?: "secondary" | "ghost" | "primary" }) {
  if (!onRetry) return null;
  return <Button variant={variant} icon="refresh" className="gh-retry" onClick={onRetry}>Retry now</Button>;
}
// Rate limit: the 60 s refresh tick really does retry on this page, so the
// copy may promise it. The hub's 200-payload `rate_limited` reason also covers
// an ambiguous 403 ("rate limit or access forbidden") — that wording gets the
// honest "one of two causes" copy with the access check offered first.
function RateLimit({ detail, onRetry }: { detail?: string | null; onRetry?: () => void }) {
  const ambiguous = /forbidden|access|scope|permission/i.test(detail || "");
  return (
    <div className="gh-empty card-empty" role="alert">
      <div className="gh-empty-ico is-warn" aria-hidden="true"><Icon name="clock" cls="" /></div>
      <div className="t1">{ambiguous ? "GitHub refused the request" : "GitHub rate limit reached"}</div>
      <p>
        {ambiguous
          ? "Either this token hit GitHub's rate limit, or it can't access this repository. This page retries every minute."
          : "GitHub is throttling requests for this token. This page retries automatically every minute."}
      </p>
      {detail ? <p className="gh-empty-detail">{detail}</p> : null}
      <div className="gh-empty-acts">
        {ambiguous ? <ButtonLink variant="secondary" to="/settings#tab=github-access">Check GitHub access</ButtonLink> : null}
        <RetryBtn onRetry={onRetry} />
        {ambiguous ? null : <ButtonLink variant="ghost" to="/settings#tab=github-access">Check GitHub access</ButtonLink>}
      </div>
    </div>
  );
}
// V2: a real permissions problem (HTTP 403 that isn't a rate limit, or a bound
// repo GitHub won't return). No auto-retry promise — waiting won't fix it.
function NoAccess({ repo, detail, title, onConnect, onRetry }: {
  repo: string; detail?: string | null; title?: string; onConnect: () => void; onRetry?: () => void;
}) {
  return (
    <div className="gh-empty card-empty" role="alert">
      <div className="gh-empty-ico is-danger" aria-hidden="true"><Icon name="shield" cls="" /></div>
      <div className="t1">{title || <>GitHub token can&#39;t access {repo}</>}</div>
      <p>
        This project is connected to <span className="mono">{repo}</span>, but GitHub didn&#39;t return it — the access token may be
        missing, expired, or not granted to this repository.
      </p>
      {detail ? <p className="gh-empty-detail">{detail}</p> : null}
      <div className="gh-empty-acts">
        <ButtonLink variant="primary" to="/settings#tab=github-access">Check GitHub access</ButtonLink>
        <Button variant="secondary" onClick={onConnect}>Change repo</Button>
        <RetryBtn onRetry={onRetry} variant="ghost" />
      </div>
    </div>
  );
}
function GenericError({ status, detail, onRetry }: { status?: number; detail?: string | null; onRetry?: () => void }) {
  return (
    <div className="gh-empty card-empty" role="alert">
      <div className="gh-empty-ico is-danger" aria-hidden="true"><Icon name="alert" cls="" /></div>
      <div className="t1">Couldn&#39;t load from GitHub{status && status >= 400 ? " (" + String(status) + ")" : ""}</div>
      <p>{detail ? detail : "Something went wrong talking to GitHub."}</p>
      <div className="gh-empty-acts"><RetryBtn onRetry={onRetry} /></div>
    </div>
  );
}
function DetailNotFound({ kind, onBack }: { kind: GhKind; onBack?: () => void }) {
  return (
    <div className="gh-empty card-empty" role="status">
      <div className="t1">{kind === "pull" ? "Pull request" : "Issue"} not found</div>
      <p>It may have been deleted, or the number doesn&#39;t exist in this repo.</p>
      {onBack ? (
        <div className="gh-empty-acts">
          <Button variant="secondary" onClick={onBack}>Back to {kind === "pull" ? "pull requests" : "issues"}</Button>
        </div>
      ) : null}
    </div>
  );
}
function GhErrorBody({ err, notFoundKind, onConnect, onRetry, onBack, boundRepo, blockedReason }: {
  err: GhError;
  /** why Connect repo is unavailable to this viewer (null = allowed) */
  blockedReason?: string | null;
  notFoundKind?: GhKind;
  onConnect: () => void;
  onRetry?: () => void;
  onBack?: () => void;
  /** the container's GitHub binding (owner/name), when known — turns a
   *  "not connected" answer for a BOUND repo into the missing-access state */
  boundRepo?: string | null;
}) {
  if (err.kind === "not_found" && notFoundKind) return <DetailNotFound kind={notFoundKind} onBack={onBack} />;
  if (err.kind === "local_source") return <LocalSourceCallout onConnect={onConnect} originDetected={err.originDetected} />;
  if (err.kind === "not_connected") {
    if (boundRepo && !isLocalRepo(boundRepo)) {
      // G13: the server's "no GitHub repo is connected" contradicts the bound
      // repo on screen — for a bound repo that answer means no usable token.
      const detail = /no GitHub repo is connected/i.test(err.detail || "") ? "No GitHub token can read this repository — add one in Settings › Integrations." : err.detail;
      return <NoAccess repo={boundRepo} title={"Can't reach " + boundRepo} detail={detail} onConnect={onConnect} onRetry={onRetry} />;
    }
    return <EmptyRepo onConnect={onConnect} blockedReason={blockedReason} />;
  }
  if (err.kind === "no_access") {
    return <NoAccess repo={boundRepo && !isLocalRepo(boundRepo) ? boundRepo : "this repository"} detail={err.detail} onConnect={onConnect} onRetry={onRetry} />;
  }
  if (err.kind === "rate_limited") return <RateLimit detail={err.detail} onRetry={onRetry} />;
  return <GenericError status={err.status} detail={err.detail} onRetry={onRetry} />;
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

/* ---- list grouping (D8 band headers) ----------------------------------------
   PRs group by GitHub's own merge state (the group band IS the merge fact, so
   rows don't repeat it); issues group by whether Orcha already tracks them.
   Pure + exported for tests. */
export interface GhGroup<T> { id: string; title: string; glyph: string; tone: string; items: T[] }
const PULL_GROUP_ORDER = ["Conflicts", "Blocked", "Unstable", "Behind", "Mergeable", "Unknown", "Draft"];
export function groupPulls<T extends { mergeable_state?: string | null; draft?: boolean }>(rows: T[]): GhGroup<T>[] {
  const by = new Map<string, { tone: string; items: T[] }>();
  rows.forEach((r) => {
    const m = mergeStateLabel(r.mergeable_state, r.draft);
    const g = by.get(m.label) || { tone: m.tone, items: [] };
    g.items.push(r);
    by.set(m.label, g);
  });
  return PULL_GROUP_ORDER.filter((k) => by.has(k)).map((k) => {
    const g = by.get(k)!;
    return { id: k.toLowerCase(), title: k, glyph: MERGE_GLYPH[k] || "unknown", tone: g.tone, items: g.items };
  });
}
export function groupIssues<T>(rows: T[], isTracked: (r: T) => boolean): GhGroup<T>[] {
  const tracked = rows.filter(isTracked);
  const open = rows.filter((r) => !isTracked(r));
  const out: GhGroup<T>[] = [];
  if (tracked.length) out.push({ id: "tracked", title: "Tracked in Embodent", glyph: "tracked", tone: "neutral", items: tracked });
  if (open.length) out.push({ id: "untracked", title: "Not tracked", glyph: "issueDot", tone: "ok", items: open });
  return out;
}

/* ---- Start / Fix split action ------------------------------------------------
   In list rows the action is a quiet ghost control revealed on row hover /
   focus (always visible on touch); in the detail's Orcha card it is the
   view's single primary action. Tracked items show a TrackedChip instead. */
interface StartCellProps {
  kind: GhKind;
  item: GhItem;
  taskState: TaskState | null;
  tasks: Task[];
  busy: boolean;
  ddOpen: boolean;
  primary?: boolean;
  onStart: (kind: GhKind, number: number) => void;
  onToggleDd: (anchor: HTMLElement, kind: GhKind, number: number) => void;
  /** G09: why this viewer can't dispatch (viewer / non-member) — both halves
   *  disabled with the reason as their tooltip; null = allowed */
  blocked?: string | null;
}
function StartCell({ kind, item, taskState, tasks, busy, ddOpen, primary, onStart, onToggleDd, blocked }: StartCellProps) {
  if (taskState && taskState.task_id) {
    return <TrackedChip taskId={taskState.task_id} existing={taskState.existing} tasks={tasks} size={primary ? "md" : "sm"} />;
  }
  const d = dispatchLabel(kind);
  return (
    <div className={"gh-start-split" + (primary ? " is-primary" : "")}>
      <Button
        variant={primary ? "primary" : "secondary"}
        size="sm"
        className="gh-start"
        busy={busy}
        icon="play"
        data-gh-start={kind}
        data-gh-number={item.number}
        title={blocked || d.tooltip}
        aria-label={d.tooltip}
        disabled={!!blocked}
        onClick={(e) => { e.stopPropagation(); if (!blocked) onStart(kind, item.number); }}
      >
        {d.label}
      </Button>
      <button
        className={"v2-btn v2-btn-" + (primary ? "primary" : "secondary") + " v2-btn-sm v2-btn-icononly gh-start-dd"}
        type="button"
        data-gh-start-dd={kind}
        data-gh-number={item.number}
        aria-haspopup="true"
        aria-expanded={ddOpen}
        title={blocked || "Assign to an agent"}
        aria-label="Assign to an agent"
        disabled={!!blocked}
        onClick={(e) => { e.stopPropagation(); if (!blocked) onToggleDd(e.currentTarget, kind, item.number); }}
      >
        <Icon name="chev" cls="v2-ico v2-btn-ico" />
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
      <Avatar alias={a.alias} kind="ai" status={a.status} size={20} decorative />
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

function FilesSection({ files, htmlUrl, blobSource }: { files: GhFiles | undefined; htmlUrl: string | null | undefined; blobSource?: BlobSource | null }) {
  const f = files || {};
  const items = f.items || [];
  if (!items.length) return <div className="gh-quiet-empty">No files changed.</div>;
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
      // GitHub sends no patch for a binary file (and no line counts) — preview it instead
      binary: !it.patch && !it.patch_omitted && !it.additions && !it.deletions && it.status !== "renamed",
    }));
  return (
    <div className="gh-files">
      <FilesChanged preparsed={preparsed} blobSource={blobSource} />
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
      <span className="grow gh-run-name" title={name}>{name}</span>
      <span className="gh-run-state">{completed ? (conclusion || "done") : (run.status || "queued")}</span>
      {run.html_url ? (
        <a className={iconButtonClass({ size: "sm" }, "gh-run-link")} href={run.html_url} target="_blank" rel="noopener noreferrer" aria-label={"Open " + name + " on GitHub"} title="Open on GitHub">
          <Icon name="ext" cls="v2-ico" />
        </a>
      ) : null}
    </div>
  );
}
/** Checks tab count = the rows the tab actually lists (never the rollup's
 *  larger total beside 3 rows); the gap is explained under the list. Exported for tests. */
export function checksTabCount(checks: ChecksRollup | null | undefined): number | null {
  const r = checks || {};
  const runs = (r.runs || []).length;
  return runs || checksTotal(r) || null;
}
function ChecksSection({ checks, htmlUrl }: { checks: ChecksRollup | null | undefined; htmlUrl?: string | null }) {
  const runs = (checks && checks.runs) || [];
  const total = checksTotal(checks || {});
  if (!runs.length) return <div className="gh-quiet-empty">No checks reported for this pull request.</div>;
  const hasLink = !!htmlUrl && htmlUrl !== "#";
  return (
    <>
      <div className="gh-runs">{runs.map((r, i) => <RunRow key={i} run={r} />)}</div>
      {total > runs.length ? (
        <div className="gh-files-more muted gh-runs-more">
          GitHub reported {total} checks; {runs.length} shown here.
          {hasLink ? <> <a className="gh-inline-link" href={htmlUrl + "/checks"} target="_blank" rel="noopener noreferrer">All checks on GitHub<Icon name="ext" cls="gl" /></a></> : null}
        </div>
      ) : null}
    </>
  );
}

/* ---- right rail values --------------------------------------------------- */
function PersonList({ logins }: { logins: string[] | undefined }) {
  const l = Array.isArray(logins) ? logins : [];
  if (!l.length) return null;
  return (
    <div className="gh-people-list">
      {l.map((login) => (
        <span key={login} className="gh-person"><GhAvatar login={login} decorative /><span>{login}</span></span>
      ))}
    </div>
  );
}
function ChecksSummary({ checks }: { checks: ChecksRollup | null | undefined }) {
  const r = checks || {};
  if (!checksTotal(r)) return null;
  return (
    <span className="gh-checks-summary">
      {r.passed ? <span className="gh-cs pass"><Icon name="check" cls="gl" />{r.passed} passed</span> : null}
      {r.failing ? <span className="gh-cs fail"><Icon name="x" cls="gl" />{r.failing} failing</span> : null}
      {r.pending ? <span className="gh-cs pend"><GhIcon name="ring" cls="gl" />{r.pending} pending</span> : null}
    </span>
  );
}

/* ---- GitHub Markdown bodies: mdText keeps paragraph breaks as text (the
   body is white-space: pre-wrap), so a newline between two block spans
   (heading / list item) would render as an extra blank line. Drop exactly
   those; real paragraph breaks stay. Exported for tests. */
export function tightMd(html: string): string {
  return html
    .replace(/\n(?=<span class="md-(?:h|li)\b)/g, "")
    // a paragraph after a list / heading: the block already ends its line, so
    // "\n\n" would paint TWO blank lines — keep one paragraph break.
    .replace(/^(<span class="md-(?:h|li)\b[^\n]*<\/span>)\n(?=\n)/gm, "$1");
}

/* ---- human copy for a failed Start/Fix dispatch ----------------------------
   V2: never a raw "Start failed (404): <server string>" — say what failed in
   plain words; a short server reason rides along only when it reads as prose. */
export function startFailureMessage(kind: GhKind, number: number, status: number, detail?: string | null): string {
  const what = "Couldn't start a task for " + (kind === "pull" ? "PR" : "issue") + " #" + number;
  let why: string;
  if (status === 0) why = "the portal is unreachable — check your connection and try again";
  else if (status === 401 || status === 403) why = "you don't have permission to create tasks in this project";
  else if (status === 404) why = "this item or the project's GitHub connection wasn't found";
  else if (status === 409) why = "it's already being started — refresh in a moment";
  else if (status === 429) why = "GitHub is rate limiting — try again in a minute";
  else if (status >= 500) why = "the server hit an error — try again";
  else why = detail && detail.length < 120 && /\s/.test(detail) ? detail : "the request was rejected";
  return what + ": " + why + ".";
}

/* ---- empty list (r3): the shared compact EmptyState, like every other
   list, with a muted line naming the active filters. */
function ListEmpty({ kind, filtered, filters }: { kind: GhKind; filtered: boolean; filters: string[] }) {
  const noun = kind === "pull" ? "pull requests" : "issues";
  return (
    // EmptyState's markup/classes (compact), with the GitHub kind glyph —
    // EmptyState's `icon` only takes the app icon set, which has no issue glyph.
    <div className="gh-list-empty">
      <div className="v2-empty v2-empty-neutral v2-empty-compact">
        <div className="v2-empty-icon" aria-hidden="true"><GhIcon name={kind === "pull" ? "pullArrow" : "issueDot"} cls="v2-ico" /></div>
        <div className="v2-empty-title">{filtered ? "No " + noun + " match this filter" : "No open " + noun}</div>
        {filters.length ? <div className="v2-empty-body gh-list-empty-filters">Filters: {filters.join(" · ")}</div> : null}
      </div>
    </div>
  );
}

/* ---- PR rail branch value (r3): the head/base branch is often longer than
   the rail — full name in the tooltip, click (or Enter) copies it. */
function BranchValue({ name }: { name: string | null | undefined }) {
  const toast = useToast();
  if (!name) return null;
  const copy = () => {
    const fail = () => toast("Couldn't copy — select and copy it manually: " + name, "danger");
    try {
      const p = navigator.clipboard?.writeText(name);
      if (!p) { fail(); return; }
      p.then(() => toast("Branch name copied", "ok"), fail);
    } catch {
      fail();
    }
  };
  return (
    <button type="button" className="mono gh-branch-v gh-branch-copy" title={name + " — click to copy"} aria-label={"Copy branch name " + name} onClick={copy}>
      <span className="gh-branch-name">{name}</span>
      <Icon name="copy" cls="v2-ico gh-branch-copy-ico" />
    </button>
  );
}

/* ---- detail header ⋯ menu (D5 "ID title ☆ ⋯"): copy the GitHub link /
   the #N reference, plus the actions the circle buttons also offer. */
function DetailMoreMenu({ kind, number, htmlUrl, onBrowseHead }: {
  kind: GhKind; number: number; htmlUrl: string | null | undefined; onBrowseHead?: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const noun = kind === "pull" ? "pull request" : "issue";
  const hasLink = !!htmlUrl && htmlUrl !== "#";
  const copy = (text: string, what: string) => {
    try {
      void navigator.clipboard?.writeText(text).then(
        () => toast(what + " copied", "ok"),
        () => toast("Couldn't copy — select and copy it manually: " + text, "danger"),
      );
    } catch {
      toast("Couldn't copy — select and copy it manually: " + text, "danger");
    }
  };
  const items: (MenuItemSpec | "separator")[] = [
    { label: "Copy GitHub link", icon: "link", disabled: !hasLink, disabledReason: "GitHub didn't return a link for this " + noun, onSelect: () => copy(htmlUrl as string, "Link") },
    { label: "Copy #" + number, icon: "copy", onSelect: () => copy("#" + number, "Reference") },
  ];
  if (onBrowseHead) items.push({ label: "Browse files at head", icon: "code", onSelect: onBrowseHead });
  if (hasLink) items.push("separator", { label: "Open on GitHub", icon: "ext", onSelect: () => { window.open(htmlUrl as string, "_blank", "noopener,noreferrer"); } });
  return (
    <>
      <IconButton ref={ref} icon="more" size="sm" label={(kind === "pull" ? "Pull request" : "Issue") + " actions"} className="gh-more-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} items={items} label={(kind === "pull" ? "Pull request" : "Issue") + " actions"} placement="bottom-start" />
    </>
  );
}

/* ---- narrow toolbar ⋯ (≤600px): the repo switcher and Browse files fold in
   here so the kind pills keep the row (review r2: the selected "Pull
   requests" pill used to scroll off-screen behind the repo button). ------- */
function ToolbarMoreMenu({ items }: { items: (MenuItemSpec | "separator")[] }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton ref={ref} variant="outline" icon="more" label="Repository actions" className="gh-tb-more" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      <Menu anchor={ref} open={open} onClose={() => setOpen(false)} items={items} label="Repository actions" placement="bottom-end" />
    </>
  );
}

/* ---- floating menu placement (assignee roster / Fix info) -----------------
   bottom-end under the anchor, clamped 8px inside the viewport on both sides;
   flips above the anchor when it would run past the bottom edge. Pure +
   exported for tests. */
export interface AnchorRect { top: number; bottom: number; left: number; right: number }
function rectOf(el: HTMLElement): AnchorRect {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}
export function placeFloating(a: AnchorRect, w: number, h: number, vw: number, vh: number): { top: number; left: number } {
  const M = 8;
  let left = a.right - w;
  left = Math.max(M, Math.min(left, vw - w - M));
  let top = a.bottom + 6;
  if (top + h > vh - M && a.top - h - 6 >= M) top = a.top - h - 6;
  return { top: Math.round(top), left: Math.round(left) };
}

/* ---- route shape ----------------------------------------------------------- */
interface GhRoute { kind: GhKind | null; number: number | null }
type ListKey = "issues" | "pulls";
// ?browse=1&ref=&path= — the Files sub-view (browse/RepoBrowser.tsx), mutually
// exclusive with ?pr=/?issue= the same way those two are mutually exclusive.
interface BrowseRoute { on: boolean; ref: string; path: string }
type DetailPayload = { __number: number; repo?: string | null; pull?: GhPullDetail; issue?: GhIssueDetail };
type NumberedError = GhError & { __number: number };

/** ↓ / j with focus on nothing interactive (body, or the panel chrome) moves
 *  focus to the first visible [data-gh-row]. Returns true when it did. */
export function focusFirstGhRowFromIdle(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key !== "ArrowDown" && e.key !== "j") return false;
  const ae = document.activeElement as HTMLElement | null;
  const idle = !ae || ae === document.body || ae === document.documentElement
    || !ae.closest('input, textarea, select, button, a[href], [contenteditable="true"], [role="menu"], [role="listbox"], [role="dialog"], [data-gh-row], [tabindex]:not([tabindex="-1"])');
  if (!idle) return false;
  const row = document.querySelector<HTMLElement>("#ghlist [data-gh-row]");
  if (!row) return false;
  e.preventDefault();
  row.focus();
  return true;
}

/* ============================================================================
   The page
   ============================================================================ */
export function GitHubPage() {
  const { snap, cid, identity, error: snapError } = useSnapshot();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  // e2e-permissions-16: binding a repo is owner-or-manage_repo server-side;
  // the Connect affordances say so up front instead of failing on click.
  const actingAuth = useActingAuthority();
  const connectBlocked = repoConnectBlockedReason(actingAuth, identity);
  // G09: Start / Fix / Assign create a task — a viewer or non-member can't
  // (the server refuses); the controls say why instead of a toast on click.
  const startBlocked = actingAuth.readOnly ? (actingAuth.reason || "Your role is viewer (read-only)") : null;

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
  // PR server-filter popover (author / involvement)
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef<HTMLButtonElement | null>(null);

  // ---- PR-list server-backed filter bar (monorepo-scale repos): author input +
  // Assigned-to-me/My-reviews chips + free-text search. Only meaningful on the
  // pulls tab; the issues tab keeps its plain client-side "Mine"/free-text-title
  // behavior untouched. `query` above still drives client-side title filtering for
  // the NO-filter path (matchesSearch); pullsFilter.q takes over as the server
  // -backed search text once any filter is active (see the input's onChange below).
  const [pullsFilter, setPullsFilter] = useState<PullsFilter>(EMPTY_PULLS_FILTER);
  const debouncedPullsQ = useDebouncedValue(pullsFilter.q, 300);
  const pullsFilterActive = hasActivePullsFilter({ ...pullsFilter, q: debouncedPullsQ });
  // Issues: client-side label / assignee facets (the list payload is complete)
  const [issuesFilter, setIssuesFilter] = useState<IssuesFilter>(EMPTY_ISSUES_FILTER);
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
  // V2 freshness: when each tab's list last loaded successfully, so a failed
  // refresh over an existing list is labeled stale instead of passing as live.
  const [loadedAt, setLoadedAt] = useState<Record<ListKey, number | null>>({ issues: null, pulls: null });
  const loadingRef = useRef<Record<ListKey, boolean>>({ issues: false, pulls: false });
  const payloadRef = useRef(payload);
  payloadRef.current = payload;

  // progressive checks fill: number -> rollup, kept OUTSIDE payload so a
  // list refetch doesn't need to re-carry checks (vanilla checksByNumber).
  const [checksByNumber, setChecksByNumber] = useState<Record<number, ChecksRollup>>({});
  const checksRequested = useRef<Record<number, boolean>>({});
  const [checksUnavailable, setChecksUnavailable] = useState<Record<number, boolean>>({});

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
  const [dd, setDd] = useState<{ key: string; kind: GhKind; number: number; anchor: AnchorRect; top: number; left: number } | null>(null);
  const [fixInfo, setFixInfo] = useState<{ number: number; anchor: AnchorRect; top: number; left: number } | null>(null);
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
  // `/github?connect=1` (Code Space's "Connect repo") opens the picker in one
  // step; the flag is consumed so a refresh/back doesn't reopen it.
  useEffect(() => {
    if (!cid || searchParams.get("connect") !== "1") return;
    setConnectOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("connect");
    setSearchParams(next, { replace: true });
  }, [cid, searchParams, setSearchParams]);
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
        // 200 + {available:false} (rate limit / unreachable / no access) is an
        // ERROR state, never "No open issues." — local_source stays a payload
        // (its own callout renders from it, unchanged).
        const off = isLocalSourcePayload(body) ? null : unavailableError(body, status);
        if (off) {
          setLoadError((e) => ({ ...e, [key]: off }));
          // a repo-level "not connected" means any list we had is no longer valid
          if (off.kind === "not_connected") setPayload((p) => ({ ...p, [key]: null }));
          return;
        }
        setPayload((p) => ({ ...p, [key]: body as GhListPayload }));
        setLoadError((e) => ({ ...e, [key]: null }));
        setLoadedAt((t) => ({ ...t, [key]: Date.now() }));
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
          const de = classifyDetailError(status, body);
          setDetailError((e) => ({ ...e, [kind]: { __number: number, ...de } }));
          // V2: a transient refresh failure (rate limit / unreachable) keeps the
          // item on screen, labeled stale; only "gone"/"disconnected" clears it.
          const keep = de.kind === "rate_limited" || de.kind === "error";
          if (!keep) setDetailPayload((p) => ({ ...p, [kind]: null }));
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
    if (route.kind) {
      loadDetail(route.kind, route.number as number, false);
      // a deep-linked detail still gets its list (cached, no force) so the
      // header's "N / M ↑↓" pager can walk the same grouped order
      loadList(route.kind === "pull" ? "pulls" : "issues", false);
    } else loadList(tab, false);
  }, [cid, routeKey, tab, route.kind, route.number, loadDetail, loadList, browseRoute.on]);

  // r3: the sibling list's COUNT on its section pill (Issues / Pull requests)
  // used to stay blank until that tab was opened, so the two segments looked
  // different. Once the active list has landed, fetch the sibling once in the
  // background (cached, never forced; the 60s tick only refreshes the active
  // tab). A failure just leaves the count blank — the tab itself re-shows the
  // recoverable error when opened.
  const activePl = payload[tab];
  const activeListLoaded = !!(activePl && activePl.repo && !isLocalSourcePayload(activePl));
  useEffect(() => {
    if (!cid || browseRoute.on || !activeListLoaded) return;
    const other: ListKey = tab === "pulls" ? "issues" : "pulls";
    if (payloadRef.current[other] || loadError[other]) return;
    loadList(other, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, tab, activeListLoaded, browseRoute.on, loadList]);

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
        if (!body || body.available === false || !body.checks) {
          // degrade honestly: the chip says "Checks unavailable", not a forever spinner
          setChecksUnavailable((prev) => { const next = { ...prev }; wanted.forEach((n) => { next[n] = true; }); return next; });
          return;
        }
        // numbers the batch omitted resolve to "No checks" — never an
        // endless "checks…" placeholder
        const filled = fillMissingChecks(wanted, body.checks);
        setChecksByNumber((prev) => ({ ...prev, ...filled }));
      })
      .catch(() => {
        setChecksUnavailable((prev) => { const next = { ...prev }; wanted.forEach((n) => { next[n] = true; }); return next; });
      });
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
          toast(startFailureMessage(kind, number, status, d && d.detail), "danger", { sticky: true });
          setBusy((b) => ({ ...b, [busyKey]: false }));
          return;
        }
        setStarted((s) => ({ ...s, [kind]: { ...s[kind], [number]: { task_id: d.task_id as string, existing: !!d.existing } } }));
        toast(d.existing ? "Already tracked as a task" : "Task created", "ok");
        setBusy((b) => ({ ...b, [busyKey]: false }));
      })
      .catch(() => {
        toast(startFailureMessage(kind, number, 0, null), "danger", { sticky: true });
        setBusy((b) => ({ ...b, [busyKey]: false }));
      });
  }, [cid, snap, toast]);

  /* ---- list keyboard entry (wave4 review): with NOTHING focused, ↓ / j
     lands on the first visible row, so the advertised "↑ ↓ Move between
     rows" works without first clicking or tabbing into the list. Row-to-row
     movement stays with the .gh-groups handler (rowNavKeyDown). */
  const listKeysOn = !route.kind && !browseRoute.on;
  useEffect(() => {
    if (!listKeysOn) return;
    const onKey = (e: KeyboardEvent) => { focusFirstGhRowFromIdle(e); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [listKeysOn]);

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

  // V2 keyboard: the assignee menu takes focus when it opens (first agent)
  // and gives it back to the chevron that opened it when it closes.
  const ddAnchorRef = useRef<HTMLElement | null>(null);
  const ddOpenKey = dd ? dd.key : null;
  useEffect(() => {
    if (ddOpenKey) {
      const first = ddRef.current?.querySelector<HTMLElement>("button");
      first?.focus();
      return;
    }
    const a = ddAnchorRef.current;
    ddAnchorRef.current = null;
    if (a && document.contains(a) && (document.activeElement === document.body || !document.activeElement)) a.focus();
  }, [ddOpenKey]);
  const onDdKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button"));
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    e.preventDefault();
    items[next]?.focus();
  }, []);

  // bottom-end placement from a first guess, then re-placed from the menu's
  // MEASURED size (useLayoutEffect below) so a wide roster never runs off the
  // window's right edge and a tall one flips above its anchor.
  const toggleDd = useCallback((anchor: HTMLElement, kind: GhKind, number: number) => {
    ddAnchorRef.current = anchor;
    const key = kind + ":" + number;
    setDd((cur) => {
      if (cur && cur.key === key) return null;
      const a = rectOf(anchor);
      return { key, kind, number, anchor: a, ...placeFloating(a, 240, 240, window.innerWidth, window.innerHeight) };
    });
  }, []);
  const toggleFixInfo = useCallback((anchor: HTMLElement, number: number) => {
    setFixInfo((cur) => {
      if (cur && cur.number === number) return null;
      const a = rectOf(anchor);
      return { number, anchor: a, ...placeFloating(a, 280, 160, window.innerWidth, window.innerHeight) };
    });
  }, []);
  useLayoutEffect(() => {
    const el = ddRef.current;
    if (!dd || !el) return;
    const p = placeFloating(dd.anchor, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight);
    if (p.top !== dd.top || p.left !== dd.left) setDd({ ...dd, ...p });
  }, [dd]);
  useLayoutEffect(() => {
    const el = fixInfoRef.current;
    if (!fixInfo || !el) return;
    const p = placeFloating(fixInfo.anchor, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight);
    if (p.top !== fixInfo.top || p.left !== fixInfo.left) setFixInfo({ ...fixInfo, ...p });
  }, [fixInfo]);

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

  /* ---- tab / filter handlers ------------------------------------------------ */
  const onTabClick = (next: ListKey) => {
    if (next === tab) return;
    setTab(next);
    setFilter("open");
    setFilterOpen(false);
    if (route.kind) goto({ kind: null, number: null }, true);
  };

  /* ---- visible list rows (filter + search + progressive checks), in the SAME
     grouped order the list renders — the detail pager walks this order. ---- */
  const isTracked = useCallback((kind: GhKind) => (it: GhItem) => !!(startedOf(kind, it.number)?.task_id), [startedOf]);
  const visibleRows = (key: ListKey): GhItem[] | null => {
    const kind: GhKind = key === "pulls" ? "pull" : "issue";
    const withChecks = (rows: GhPullRow[]) => rows.map((p) => (p.checks == null && checksByNumber[p.number] != null ? { ...p, checks: checksByNumber[p.number] } : p));
    if (key === "pulls" && pullsFilterActive) return withChecks(filteredPulls);
    const pl = payload[key];
    if (!pl || isLocalSourcePayload(pl) || !pl.repo) return null;
    const raw = (pl.issues || pl.pulls || []) as GhItem[];
    const all = key === "pulls" ? withChecks(raw as GhPullRow[]) : raw;
    return (all as GhItem[])
      .filter((it) => matchesFilter(kind, it, filter, myLogin))
      .filter((it) => kind !== "issue" || matchesIssuesFilter(it as GhIssueRow, issuesFilter))
      .filter((it) => matchesSearch(it, query));
  };
  const groupsFor = (kind: GhKind, rows: GhItem[]): GhGroup<GhItem>[] => (kind === "pull"
    ? groupPulls(rows as GhPullRow[]) as unknown as GhGroup<GhItem>[]
    : groupIssues(rows, isTracked("issue")));

  /* ---- list rows: ONE line (Linear My issues) — muted #id · state glyph ·
     title (ellipsis, full title + branch in the tooltip) · chips · people ·
     time. The Start/Fix action is revealed on hover/focus (touch: always). */
  const rowAction = (kind: GhKind, it: GhItem) => {
    const ts = startedOf(kind, it.number);
    if (ts && ts.task_id) return null;
    return (
      <span className="gh-actions">
        <StartCell
          kind={kind}
          item={it}
          taskState={null}
          tasks={tasks}
          busy={!!busy[kind + ":" + it.number]}
          ddOpen={dd?.key === kind + ":" + it.number}
          onStart={(k, n) => postStart(k, n, null)}
          onToggleDd={toggleDd}
          blocked={startBlocked}
        />
      </span>
    );
  };
  const trackedFor = (kind: GhKind, n: number) => {
    const ts = startedOf(kind, n);
    return ts && ts.task_id ? <TrackedChip taskId={ts.task_id} existing={ts.existing} tasks={tasks} /> : null;
  };

  const issueRow = (it: GhIssueRow) => (
    <div
      key={it.number}
      className="ghrow"
      data-gh-row={`issue:${it.number}`}
      data-gh-open={`issue:${it.number}`}
      role="link"
      tabIndex={0}
      aria-label={"Issue #" + it.number + ": " + it.title}
      onClick={() => goto({ kind: "issue", number: it.number })}
      onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") goto({ kind: "issue", number: it.number }); }}
    >
      <span className="gh-num">#{it.number}</span>
      <KindGlyph kind="issue" item={it as { state?: string | null }} />
      <span className="gh-title-text" title={it.title || ""}>{it.title}</span>
      <span className="gh-chips">
        {trackedFor("issue", it.number)}
        {/* D12: at most 2 chips per row — the linked task counts as one */}
        <LabelChips labels={it.labels} max={trackedFor("issue", it.number) ? 1 : 2} />
      </span>
      <span className="gh-people gh-assignee-col">
        {it.assignee
          ? <GhAvatar login={it.assignee} />
          : <span className="gh-unassigned" title="Unassigned"><span className="v2-sr">Unassigned</span></span>}
      </span>
      <span className="gh-updated" title={it.updated_at ? new Date(it.updated_at).toLocaleString() : undefined}>{relTime(it.updated_at)}</span>
      {rowAction("issue", it)}
    </div>
  );

  const pullRow = (pr: GhPullRow) => {
    const reviewers = Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : [];
    return (
      <div
        key={pr.number}
        className="ghrow"
        data-gh-row={`pull:${pr.number}`}
        data-gh-open={`pull:${pr.number}`}
        role="link"
        tabIndex={0}
        aria-label={"Pull request #" + pr.number + ": " + pr.title}
        onClick={() => goto({ kind: "pull", number: pr.number })}
        onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") goto({ kind: "pull", number: pr.number }); }}
      >
        <span className="gh-num">#{pr.number}</span>
        <KindGlyph kind="pull" item={pr} />
        <span className="gh-title-text" title={(pr.title || "") + (pr.head ? "\n" + pr.head : "")}>{pr.title}</span>
        <span className="gh-chips">
          {trackedFor("pull", pr.number)}
          <ChecksChip rollup={pr.checks} unavailable={!!checksUnavailable[pr.number]} />
        </span>
        <span className="gh-people gh-reviewers-col">
          {reviewers.length
            ? <AvatarStack className="gh-reviewers" label="Review requested" actors={reviewers.map((r) => ({ alias: r, ghLogin: r }))} max={3} />
            : null}
        </span>
        <span className="gh-updated" title={pr.updated_at ? new Date(pr.updated_at).toLocaleString() : undefined}>{relTime(pr.updated_at)}</span>
        {rowAction("pull", pr)}
      </div>
    );
  };

  const groupedRows = (kind: GhKind, rows: GhItem[]) => (
    // ↑/↓ and j/k move between rows (Settings › Interface advertises it) —
    // the shared roving handler, which skips rows in collapsed groups; Enter
    // stays with the focused row.
    <div className="gh-groups" onKeyDown={rowNavKeyDown({ selector: "[data-gh-row]", vimKeys: true })}>
      {groupsFor(kind, rows).map((g) => (
        <ListGroup
          key={g.id}
          id={kind + "-" + g.id}
          storageKey="orcha:gh:groups"
          title={g.title}
          count={g.items.length}
          glyph={<GhIcon name={g.glyph} cls={"gl gh-group-ico tone-" + g.tone} />}
        >
          {g.items.map((it) => (kind === "pull" ? pullRow(it as GhPullRow) : issueRow(it as GhIssueRow)))}
        </ListGroup>
      ))}
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
      return <div className="gh-loadmore-done">{of}</div>;
    }
    return (
      <div className="gh-loadmore-row">
        <Button variant="ghost" size="sm" className="gh-loadmore" busy={filteredLoading} onClick={loadMoreFilteredPulls}>
          {filteredLoading ? "Loading…" : `Load more · ${of}`}
        </Button>
      </div>
    );
  };

  // The muted "what's filtering this list" line under an empty state.
  const activeFilterSummary = (kind: GhKind): string[] => {
    const parts: string[] = [filter === "mine" ? "Mine" : "Open"];
    if (kind === "issue") {
      if (issuesFilter.label) parts.push("label " + issuesFilter.label);
      if (issuesFilter.assignee) parts.push("assignee " + issuesFilter.assignee);
      if (query.trim()) parts.push("“" + query.trim() + "”");
    } else if (pullsFilterActive) {
      if (pullsFilter.author.trim()) parts.push("author " + pullsFilter.author.trim());
      if (pullsFilter.involvement === "assigned") parts.push("assigned to me");
      if (pullsFilter.involvement === "review_requested") parts.push("review requested");
      if (debouncedPullsQ.trim()) parts.push("“" + debouncedPullsQ.trim() + "”");
    } else if (query.trim()) parts.push("“" + query.trim() + "”");
    return parts;
  };

  const listBody = () => {
    const key = tab;
    const kind: GhKind = key === "pulls" ? "pull" : "issue";

    // Server-backed filter path (pulls tab only): author=/involvement=/q= active
    // -> render the accumulated filtered/paginated pages instead of the plain
    // cached list; the Issues tab and the no-filter Pulls view are untouched.
    if (key === "pulls" && pullsFilterActive) {
      if (filteredError) {
        return (
          <GhErrorBody
            err={filteredError}
            boundRepo={boundRepo}
            blockedReason={connectBlocked}
            onConnect={() => setConnectOpen(true)}
            onRetry={() => loadFilteredPulls({ ...pullsFilter, q: debouncedPullsQ }, 1, false)}
          />
        );
      }
      if (!filteredPulls.length && filteredLoading) return skeletonReady ? <GhSkeleton kind="list-rows" /> : null;
      if (!filteredPulls.length) {
        return <ListEmpty kind="pull" filtered filters={activeFilterSummary("pull")} />;
      }
      return (
        <>
          {groupedRows("pull", visibleRows("pulls") || [])}
          {loadMoreFooter()}
        </>
      );
    }

    const pl = payload[key];
    const err = loadError[key];
    // unsettled (no payload AND no error yet): the vanilla page's OrchaSkeleton
    // "list-rows" shimmer, behind the same 120ms show delay (nothing before it)
    if (pl == null && err == null) return skeletonReady ? <GhSkeleton kind="list-rows" /> : null;
    const retryList = () => loadList(key, true);
    // A failed REFRESH over a list we already have: keep the rows but label
    // them stale with the last good time (never shown as live); a failure with
    // nothing loaded yet renders the full recoverable error state.
    const havePriorRows = !!(pl && pl.repo && !isLocalSourcePayload(pl));
    if (err && !(havePriorRows && err.kind !== "not_connected" && err.kind !== "local_source")) {
      return <GhErrorBody err={err} boundRepo={boundRepo} blockedReason={connectBlocked} onConnect={() => setConnectOpen(true)} onRetry={retryList} />;
    }
    const staleBar = err ? (
      <div className="gh-stale" role="status">
        <Icon name="alert" cls="gl" />
        <span>
          Couldn&#39;t refresh from GitHub
          {err.kind === "rate_limited" ? " (rate limit)" : err.kind === "no_access" ? " (token lost access)" : err.detail ? " (" + err.detail + ")" : ""}
          {" "}— showing the list from {loadedAt[key] ? new Date(loadedAt[key] as number).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "earlier"}, not live.
        </span>
        <Button variant="secondary" size="sm" className="gh-retry" onClick={retryList}>Retry now</Button>
      </div>
    ) : null;
    // list endpoints answer HTTP 200 even when available:false (see ghlib's
    // classifyError docstring) — the local-run degrade never reaches loadError.
    if (isLocalSourcePayload(pl)) return <LocalSourceCallout onConnect={() => setConnectOpen(true)} originDetected={pl?.origin_detected} />;
    if (!pl || !pl.repo) return <EmptyRepo onConnect={() => setConnectOpen(true)} blockedReason={connectBlocked} />;
    const all = (pl.issues || pl.pulls || []) as GhItem[];
    const filtered = visibleRows(key) || [];
    if (!filtered.length) {
      return (
        <>
          {staleBar}
          <ListEmpty kind={kind} filtered={all.length > 0} filters={activeFilterSummary(kind)} />
        </>
      );
    }
    return (
      <>
        {staleBar}
        {groupedRows(kind, filtered)}
      </>
    );
  };

  /* ---- detail (Linear issue layout) ----------------------------------------
     Header row: state glyph · #id · title … circle actions · "2 / 5 ↑↓".
     Main: large title, ONE muted meta line, the Orcha dispatch card (the
     view's single primary action), the description, then Activity (PR:
     Activity / Checks / Files changed tabs). Right: PropertyRail. */
  const detailPager = (kind: GhKind, number: number) => {
    const key: ListKey = kind === "pull" ? "pulls" : "issues";
    const rows = visibleRows(key);
    if (!rows || !rows.length) return null;
    const ordered = groupsFor(kind, rows).flatMap((g) => g.items);
    const i = ordered.findIndex((it) => it.number === number);
    if (i < 0) return null;
    const go = (j: number) => { const t = ordered[j]; if (t) goto({ kind, number: t.number }); };
    return <Pager index={i} total={ordered.length} noun={kind === "pull" ? "pull request" : "issue"} onPrev={() => go(i - 1)} onNext={() => go(i + 1)} />;
  };
  const detailTop = (kind: GhKind, item: GhItem & { html_url?: string | null; title?: string | null; state?: string | null }) => {
    // the ↗ button is the constant detail action on both kinds: GitHub's own
    // html_url, else the canonical github.com URL built from the bound repo
    // slug (never for a local-checkout binding — there is no github.com page)
    const extUrl = item.html_url && item.html_url !== "#"
      ? item.html_url
      : boundRepo && !isLocalRepo(boundRepo)
        ? `https://github.com/${boundRepo}/${kind === "pull" ? "pull" : "issues"}/${item.number}`
        : null;
    return (
      <PageHeader
        className="gh-pagehead"
        glyph={
          <Link
            to={"/github?tab=" + (kind === "pull" ? "pulls" : "issues")}
            className={iconButtonClass({ size: "sm" }, "gh-back")}
            aria-label={"Back to " + (kind === "pull" ? "pull requests" : "issues")}
            title={"Back to " + (kind === "pull" ? "pull requests" : "issues")}
            onClick={(e) => { e.preventDefault(); goto({ kind: null, number: null }); }}
          >
            <Icon name="arrow-left" cls="v2-ico" />
          </Link>
        }
        id={<><KindGlyph kind={kind} item={item} /><span>#{item.number}</span></>}
        title={item.title || ""}
        trailing={
          <DetailMoreMenu
            kind={kind}
            number={item.number}
            htmlUrl={extUrl}
            onBrowseHead={kind === "pull" ? () => gotoBrowse({ ref: `pr/${item.number}`, path: "" }) : undefined}
          />
        }
        actions={
          <>
            {/* ↗ always first (same place on issues and PRs); PRs add </> second */}
            {extUrl ? (
              <a
                className={iconButtonClass({ size: "sm", variant: "outline" }, "gh-open-ext")}
                href={extUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open on GitHub"
                title="Open on GitHub"
              >
                <Icon name="ext" cls="v2-ico" />
              </a>
            ) : null}
            {kind === "pull" ? (
              <IconButton
                icon="code"
                variant="outline"
                size="sm"
                label="Browse files at head"
                className="gh-browse-head"
                onClick={(e) => { e.stopPropagation(); gotoBrowse({ ref: `pr/${item.number}`, path: "" }); }}
              />
            ) : null}
          </>
        }
        pager={detailPager(kind, item.number)}
      />
    );
  };
  /** the compact Orcha card (D10 "gate actions in a compact card near the top") */
  const dispatchCard = (kind: GhKind, item: GhItem) => {
    const ts = startedOf(kind, item.number);
    const tracked = !!(ts && ts.task_id);
    const showFixInfo = kind === "pull" && !tracked;
    return (
      <section className="gh-orcha-card" aria-label="Embodent">
        <span className="gh-orcha-ico" aria-hidden="true"><Icon name="spark" cls="gl" /></span>
        <span className="gh-orcha-h">Embodent</span>
        <span className="gh-orcha-t">
          {tracked
            ? "Tracked as a task"
            : kind === "pull"
              ? "Dispatch an agent to fix checks and review feedback"
              : "Dispatch an agent to work on this issue"}
        </span>
        <span className="gh-orcha-acts">
          {showFixInfo ? (
            <IconButton
              icon="info"
              size="sm"
              label="What will the dispatched agent do?"
              className="gh-fix-info"
              data-gh-fix-info={item.number}
              aria-haspopup="true"
              aria-expanded={fixInfo?.number === item.number}
              onClick={(e) => { e.stopPropagation(); toggleFixInfo(e.currentTarget, item.number); }}
            />
          ) : null}
          <StartCell
            kind={kind}
            item={item}
            taskState={ts}
            tasks={tasks}
            primary
            busy={!!busy[kind + ":" + item.number]}
            ddOpen={dd?.key === kind + ":" + item.number}
            onStart={(k, n) => postStart(k, n, null)}
            onToggleDd={toggleDd}
            blocked={startBlocked}
          />
        </span>
      </section>
    );
  };
  const bodyMd = (md: string | null | undefined) => (
    md && md.trim()
      ? <div className="md gh-conversation-body" dangerouslySetInnerHTML={{ __html: tightMd(mdText(md, tasks)) }} />
      : <div className="gh-conversation-body gh-no-desc">No description provided.</div>
  );
  const activity = (
    kind: GhKind,
    item: { author_login?: string | null; created_at?: string | null; html_url?: string | null },
    comments: GhComment[] | undefined,
    count: number | null | undefined,
    reviewCount: number | null | undefined,
  ) => {
    const list = comments || [];
    const total = count != null ? count : list.length;
    const review = reviewCount || 0;
    const htmlUrl = item.html_url;
    const hasLink = !!htmlUrl && htmlUrl !== "#";
    const summary = [
      total ? `${total} comment${total !== 1 ? "s" : ""}` : "No comments",
      review ? `${review} review comment${review !== 1 ? "s" : ""}` : null,
    ].filter(Boolean).join(" · ");
    const needsFooter = !list.length || list.length < total || !!review;
    return (
      <Timeline label="Activity" className="gh-timeline">
        {item.created_at ? (
          <TimelineEvent
            glyph={item.author_login ? <GhAvatar login={item.author_login} size={16} decorative /> : undefined}
            actor={item.author_login || "Someone"}
            at={item.created_at}
          >
            opened this {kind === "pull" ? "pull request" : "issue"}
          </TimelineEvent>
        ) : null}
        {list.map((c, i) => (
          <TimelineComment
            key={i}
            author={c.author_login || "unknown"}
            avatar={<GhAvatar login={c.author_login} size={20} decorative />}
            at={c.created_at}
          >
            <div className="md gh-comment-text" dangerouslySetInnerHTML={{ __html: tightMd(mdText(c.body_markdown || "", tasks)) }} />
          </TimelineComment>
        ))}
        {needsFooter ? (
          <TimelineEvent
            icon="inbox"
            className="gh-comments-more"
            trailing={hasLink && (total || review) ? (
              <a className="gh-inline-link" href={htmlUrl as string} target="_blank" rel="noopener noreferrer">
                {list.length ? "View all on GitHub" : "Read on GitHub"}<Icon name="ext" cls="gl" />
              </a>
            ) : undefined}
          >
            <span>{list.length && list.length < total ? `Showing ${list.length} of ${summary}` : summary}</span>
          </TimelineEvent>
        ) : null}
      </Timeline>
    );
  };
  const metaLine = (parts: ReactNode[]) => (
    <p className="gh-detail-meta">
      {parts.filter(Boolean).map((p, i) => <span key={i} className="gh-meta-part">{i ? <span className="gh-dot" aria-hidden="true">·</span> : null}{p}</span>)}
    </p>
  );

  const prDetail = (pull: GhPullDetail) => {
    const filesCount = (pull.files && pull.files.count) || 0;
    const activeSub = detailSubTab || "conversation";
    const commentTotal = (pull.comments_count || 0) + (pull.review_comments_count || 0);
    return (
      <div className="gh-item">
        {detailTop("pull", pull)}
        <div className="gh-detail-layout">
          <div className="gh-detail-main">
            <div className="gh-detail-title v2-t-display" aria-hidden="true">{pull.title}</div>
            {metaLine([
              pull.author_login ? <><b>{pull.author_login}</b> wants to merge</> : "Merge",
              <span className="gh-branch-line"><span className="mono gh-head" title={pull.head || ""}>{pull.head || "?"}</span><Icon name="arrow" cls="gl" /><span className="mono">{pull.base || "?"}</span></span>,
              <>Updated <RelTime at={pull.updated_at} /></>,
            ])}
            {dispatchCard("pull", pull)}
            {bodyMd(pull.body_markdown)}
            <Tabs
              className="gh-subtabs"
              label="Pull request sections"
              idPrefix="gh-pr"
              value={activeSub}
              onChange={setDetailSubTab}
              tabs={[
                { key: "conversation", label: "Activity", count: commentTotal || null },
                { key: "checks", label: "Checks", count: checksTabCount(pull.checks) },
                { key: "files", label: "Files changed", count: filesCount },
              ]}
            />
            <div className="gh-subtab-body" role="tabpanel" id={"gh-pr-panel-" + activeSub} aria-labelledby={"gh-pr-tab-" + activeSub}>
              {activeSub === "checks" ? (
                <ChecksSection checks={pull.checks} htmlUrl={pull.html_url} />
              ) : activeSub === "files" ? (
                <FilesSection
                  files={pull.files}
                  htmlUrl={pull.html_url}
                  // before = the base branch, after = the PR head (browse/raw ref=pr/<n>)
                  blobSource={cid && pull.number ? refBlobSource(cid, pull.base, "pr/" + pull.number) : null}
                />
              ) : (
                activity("pull", pull, pull.comments, pull.comments_count, pull.review_comments_count)
              )}
            </div>
          </div>
          <PropertyRail label="Pull request properties" className="gh-rail">
            <PropertySection title="Properties">
              <Property label="Status"><StateValue kind="pull" item={pull} /></Property>
              <Property label="Merge"><MergeState pr={pull} /></Property>
              <Property label="Checks" empty="No checks">{checksTotal(pull.checks || {}) ? <ChecksSummary checks={pull.checks} /> : null}</Property>
              <Property label="Author" empty="Unknown">{pull.author_login ? <PersonList logins={[pull.author_login]} /> : null}</Property>
              <Property label="Assignees" empty="No assignee">{(pull.assignees || []).length ? <PersonList logins={pull.assignees} /> : null}</Property>
              <Property label="Reviewers" empty="No reviewer">{(pull.requested_reviewers || []).length ? <PersonList logins={pull.requested_reviewers} /> : null}</Property>
            </PropertySection>
            <PropertySection title="Branch">
              <Property label="Head" layout="row">{pull.head ? <BranchValue name={pull.head} /> : null}</Property>
              <Property label="Base" layout="row">{pull.base ? <BranchValue name={pull.base} /> : null}</Property>
            </PropertySection>
          </PropertyRail>
        </div>
      </div>
    );
  };

  /* ---- issue detail (github-state.js issueDetailHtml) ---------------------- */
  const issueDetail = (issue: GhIssueDetail) => {
    const assignees = issue.assignees && issue.assignees.length ? issue.assignees : issue.assignee ? [issue.assignee] : [];
    return (
      <div className="gh-item">
        {detailTop("issue", issue)}
        <div className="gh-detail-layout">
          <div className="gh-detail-main">
            <div className="gh-detail-title v2-t-display" aria-hidden="true">{issue.title}</div>
            {metaLine([
              issue.author_login ? <><b>{issue.author_login}</b> opened this issue</> : "Issue",
              <>Updated <RelTime at={issue.updated_at} /></>,
            ])}
            {dispatchCard("issue", issue)}
            {bodyMd(issue.body_markdown)}
            <h2 className="gh-section-h">Activity</h2>
            {activity("issue", issue, issue.comments, issue.comments_count ?? (issue.comments || []).length, 0)}
          </div>
          <PropertyRail label="Issue properties" className="gh-rail">
            <PropertySection title="Properties">
              <Property label="Status"><StateValue kind="issue" item={issue} /></Property>
              <Property label="Author" empty="Unknown">{issue.author_login ? <PersonList logins={[issue.author_login]} /> : null}</Property>
              <Property label="Assignees" empty="No assignee">{assignees.length ? <PersonList logins={assignees} /> : null}</Property>
            </PropertySection>
            <PropertySection title="Labels">
              <div className="gh-rail-labels">
                {(issue.labels || []).length ? <LabelChips labels={issue.labels} max={20} /> : <span className="gh-prop-none">No labels</span>}
              </div>
            </PropertySection>
          </PropertyRail>
        </div>
      </div>
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
    if (!p && err) {
      return (
        <GhErrorBody
          err={err}
          notFoundKind={kind}
          boundRepo={boundRepo}
          blockedReason={connectBlocked}
          onConnect={() => setConnectOpen(true)}
          onRetry={() => loadDetail(kind, number, true)}
          onBack={() => goto({ kind: null, number: null })}
        />
      );
    }
    const item = p ? (kind === "pull" ? p.pull : p.issue) : null;
    // no item yet (and no error) -> the vanilla "detail-pane" skeleton,
    // regardless of fetch timing (same 120ms show delay as the list)
    if (!item) return skeletonReady ? <GhSkeleton kind="detail-pane" /> : null;
    return (
      <>
        {err ? (
          <div className="gh-stale" role="status">
            <Icon name="alert" cls="gl" />
            <span>Couldn&#39;t refresh this {kind === "pull" ? "pull request" : "issue"} from GitHub{err.detail ? " (" + err.detail + ")" : ""} — showing the last loaded version, not live.</span>
            <Button variant="secondary" size="sm" className="gh-retry" onClick={() => loadDetail(kind, number, true)}>Retry now</Button>
          </div>
        ) : null}
        {kind === "pull" ? prDetail(item as GhPullDetail) : issueDetail(item as GhIssueDetail)}
      </>
    );
  };

  /* ---- PR-list server-backed filters (monorepo-scale repos) -----------------
     Author input (+ datalist of authors seen in loaded rows), Assigned-to-me/
     My-reviews pill toggles (mutually exclusive; disabled with a visible
     tooltip reason when the acting identity has no github_login). */
  const pullsFilterPanel = () => {
    const loadedRows: GhPullRow[] = [...((payload.pulls && payload.pulls.pulls) || []), ...filteredPulls];
    const authorOptions = authorsFromRows(loadedRows);
    const noIdentity = !myLogin;
    const chip = (key: Involvement, label: string) => {
      const on = pullsFilter.involvement === key;
      const btn = (
        <Button
          key={key || "none"}
          variant="ghost"
          size="sm"
          pill
          className={"gh-involve-chip" + (on ? " on" : "")}
          disabled={noIdentity}
          aria-pressed={on}
          onClick={() => setPullsFilter((f) => ({ ...f, involvement: on ? null : key }))}
        >
          {label}
        </Button>
      );
      if (!noIdentity) return btn;
      // a disabled <button> swallows pointer events — the tooltip rides a
      // focusable wrapper so the reason is discoverable by mouse AND keyboard
      return (
        <Tooltip key={key || "none"} label="Link your GitHub login (Settings → GitHub access) to use this filter" placement="bottom">
          <span className="gh-tip-wrap" tabIndex={0} aria-label={label + " (unavailable: link your GitHub login)"}>{btn}</span>
        </Tooltip>
      );
    };
    return (
      <div className="gh-filterpop">
        <div className="gh-fp-h">Author</div>
        <label className="gh-field gh-author-field">
          <Icon name="person" cls="gl" />
          <input
            className="gh-field-in gh-author-in"
            type="text"
            list="ghPullsAuthors"
            placeholder="Author…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Filter by author"
            value={pullsFilter.author}
            onChange={(e) => setPullsFilter((f) => ({ ...f, author: e.target.value }))}
          />
        </label>
        <datalist id="ghPullsAuthors">
          {authorOptions.map((a) => <option key={a} value={a} />)}
        </datalist>
        <div className="gh-fp-h">Involvement</div>
        <div className="gh-fp-row">
          {chip("assigned", "Assigned to me")}
          {chip("review_requested", "My reviews")}
        </div>
      </div>
    );
  };
  /* ---- Issues filter popover: label + assignee facets over the loaded rows */
  const issuesFilterPanel = () => {
    const rows = ((payload.issues && payload.issues.issues) || []) as GhIssueRow[];
    const f = issueFacets(rows);
    const row = (on: boolean, name: string, count: number, key: string, icon: ReactNode, onClick: () => void) => (
      <button key={key} type="button" className={"gh-facet" + (on ? " on" : "")} aria-pressed={on} onClick={onClick}>
        <span className="gh-facet-ico" aria-hidden="true">{icon}</span>
        <span className="gh-facet-name">{name}</span>
        <span className="gh-facet-n">{count}</span>
        <span className="gh-facet-chk" aria-hidden="true">{on ? <Icon name="check" cls="gl" /> : null}</span>
      </button>
    );
    return (
      <div className="gh-filterpop gh-issues-filterpop">
        <div className="gh-fp-h">Label</div>
        <div className="gh-facet-list" role="group" aria-label="Label">
          {f.labels.length ? f.labels.map((l) => row(
            issuesFilter.label === l.name, l.name, l.count, "l:" + l.name,
            <span className="gh-label-dot" style={{ background: l.color }} />,
            () => setIssuesFilter((x) => ({ ...x, label: x.label === l.name ? null : l.name })),
          )) : <span className="gh-fp-none">No labels on open issues</span>}
        </div>
        <div className="gh-fp-h">Assignee</div>
        <div className="gh-facet-list" role="group" aria-label="Assignee">
          {f.assignees.map((a) => row(
            issuesFilter.assignee === a.login, a.login, a.count, "a:" + a.login,
            <GhAvatar login={a.login} size={16} decorative />,
            () => setIssuesFilter((x) => ({ ...x, assignee: x.assignee === a.login ? null : a.login })),
          ))}
          {f.unassigned ? row(
            issuesFilter.assignee === UNASSIGNED, "No assignee", f.unassigned, "a:none",
            <span className="gh-unassigned gh-unassigned-sm" />,
            () => setIssuesFilter((x) => ({ ...x, assignee: x.assignee === UNASSIGNED ? null : UNASSIGNED })),
          ) : null}
        </div>
      </div>
    );
  };
  const activeIssueChips = () => {
    const out: ReactNode[] = [];
    if (issuesFilter.label) {
      out.push(
        <Chip key="label" size="sm" selected className="gh-active-filter" trailing={<Icon name="x" cls="gl" />}
          aria-label={"Remove filter: label " + issuesFilter.label}
          onClick={() => setIssuesFilter((f) => ({ ...f, label: null }))}>
          {issuesFilter.label}
        </Chip>,
      );
    }
    if (issuesFilter.assignee) {
      const who = issuesFilter.assignee === UNASSIGNED ? "No assignee" : issuesFilter.assignee;
      out.push(
        <Chip key="assignee" size="sm" selected className="gh-active-filter" icon={<Icon name="person" cls="gl" />} trailing={<Icon name="x" cls="gl" />}
          aria-label={"Remove filter: " + who}
          onClick={() => setIssuesFilter((f) => ({ ...f, assignee: null }))}>
          {who}
        </Chip>,
      );
    }
    return out;
  };
  // active server-backed PR filters, as removable chips in the toolbar (the
  // filter state is always visible even with the popover closed)
  const activePullChips = () => {
    const out: ReactNode[] = [];
    if (pullsFilter.author.trim()) {
      out.push(
        <Chip key="author" size="sm" selected className="gh-active-filter" icon={<Icon name="person" cls="gl" />} trailing={<Icon name="x" cls="gl" />}
          aria-label={"Remove filter: author " + pullsFilter.author.trim()}
          onClick={() => setPullsFilter((f) => ({ ...f, author: "" }))}>
          {pullsFilter.author.trim()}
        </Chip>,
      );
    }
    if (pullsFilter.involvement) {
      const label = pullsFilter.involvement === "assigned" ? "Assigned to me" : "My reviews";
      out.push(
        <Chip key="inv" size="sm" selected className="gh-active-filter" trailing={<Icon name="x" cls="gl" />}
          aria-label={"Remove filter: " + label}
          onClick={() => setPullsFilter((f) => ({ ...f, involvement: null }))}>
          {label}
        </Chip>,
      );
    }
    return out;
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

  /* ---- toolbar helpers ------------------------------------------------------ */
  // V2: with no repo bound at all, the list chrome (tabs / filters / Browse)
  // is hidden — the only meaningful action is the empty state's Connect repo.
  const curErr = loadError[tab];
  // G10b: a non-member gets ONE "not a member" state — never the token-403
  // card with Check GitHub access / Change repo / Connect repo.
  const notMember = (!snap?.container && snapshotErrorKind(snapError) === "forbidden")
    || (!!curErr && curErr.kind === "no_access" && isMembershipDenial(curErr.detail));
  const noRepo = !route.kind && !browseRoute.on && binding === null && !hubPayloadRepo
    && !!curErr && curErr.kind === "not_connected";
  const listCount = (key: ListKey): number | null => {
    const pl = payload[key];
    if (!pl || isLocalSourcePayload(pl)) return null;
    const rows = (pl.issues || pl.pulls || []) as GhItem[];
    return rows.length;
  };
  const repoMenuItems: MenuItemSpec[] = [
    { label: "Browse files", icon: "code", onSelect: () => gotoBrowse() },
    { label: boundRepo ? "Change repo…" : "Connect repo…", icon: "folder", onSelect: () => setConnectOpen(true), disabled: !!connectBlocked, disabledReason: connectBlocked || undefined },
    ...(boundRepo && !isLocalRepo(boundRepo)
      ? [{ label: "Open on GitHub", icon: "ext", onSelect: () => { window.open(`https://github.com/${boundRepo}`, "_blank", "noopener,noreferrer"); } }]
      : []),
  ];

  // ≤600px: the repo switcher collapses into the toolbar ⋯ — the repo name
  // rides along as the "Change repo…" hint so it is still one tap away
  const repoShort = boundRepo ? (isLocalRepo(boundRepo) ? (snap?.container?.name || "Local repository") : boundRepo) : null;
  const narrowMenuItems: (MenuItemSpec | "separator")[] = [
    { label: "Browse files", icon: "code", onSelect: () => gotoBrowse() },
    { label: boundRepo ? "Change repo…" : "Connect repo…", icon: "folder", hint: repoShort || undefined, onSelect: () => setConnectOpen(true), disabled: !!connectBlocked, disabledReason: connectBlocked || undefined },
    ...(boundRepo && !isLocalRepo(boundRepo)
      ? ["separator" as const, { label: "Open on GitHub", icon: "ext", onSelect: () => { window.open(`https://github.com/${boundRepo}`, "_blank", "noopener,noreferrer"); } }]
      : []),
  ];

  /* ---- header crumbs: the list's kind lives in the toolbar pills (never
     twice); a detail adds "Pull requests / #N". ------------------------------ */
  const shellCrumbs = (() => {
    if (browseRoute.on) return [{ label: "Files", title: browseRoute.path || "Repository root" }];
    if (route.kind) {
      const dp = detailPayload[route.kind];
      const item = dp && dp.__number === route.number ? (route.kind === "pull" ? dp.pull : dp.issue) : null;
      return [
        { label: route.kind === "pull" ? "Pull requests" : "Issues", href: "/github?tab=" + (route.kind === "pull" ? "pulls" : "issues") },
        { label: "#" + route.number, title: item && item.title ? item.title : undefined },
      ];
    }
    return [];
  })();

  const listMode = !route.kind && !browseRoute.on;
  // the pills strip scrolls sideways at narrow widths — edge fades say so
  const tbScrollRef = useRef<HTMLDivElement | null>(null);
  useScrollEdges(tbScrollRef, [tab, listMode, issuesFilter, pullsFilter.author, pullsFilter.involvement]);
  const serverFilterCount = tab === "pulls"
    ? (pullsFilter.author.trim() ? 1 : 0) + (pullsFilter.involvement ? 1 : 0)
    : (issuesFilter.label ? 1 : 0) + (issuesFilter.assignee ? 1 : 0);
  const filterItems = [{ key: "open", label: "Open" }, { key: "mine", label: "Mine" }];
  if (tab === "pulls") filterItems.push({ key: "needs-review", label: "Needs review" });
  const toolbar = listMode && !noRepo && !notMember ? (
    <PageToolbar
      label="GitHub filters"
      className="gh-toolbar"
      end={
        <>
          <label className="gh-field gh-search">
            <Icon name="search" cls="gl" />
            <input
              id="ghSearch"
              className="gh-field-in"
              type="search"
              placeholder="Search…"
              aria-label={tab === "pulls" ? "Search pull requests" : "Filter issues"}
              spellCheck={false}
              autoComplete="off"
              value={tab === "pulls" ? pullsFilter.q : query}
              onChange={(e) => (tab === "pulls"
                ? setPullsFilter((f) => ({ ...f, q: e.target.value }))
                : setQuery(e.target.value))}
            />
          </label>
          {boundRepo ? (
            <MenuButton
              className="gh-repo-menu"
              variant="ghost"
              size="sm"
              menuLabel="Repository"
              title={isLocalRepo(boundRepo) ? "Local repository" : boundRepo}
              value={<RepoBadge repo={boundRepo} workspaceName={snap?.container?.name} originRepo={fallthroughOriginRepo} />}
              items={repoMenuItems}
            />
          ) : (
            <Button variant="secondary" size="sm" pill icon="folder" className="gh-connect-cta" onClick={() => setConnectOpen(true)} disabled={!!connectBlocked} title={connectBlocked || undefined}>Connect repo</Button>
          )}
          {(
            <IconButton
              ref={filterBtnRef}
              variant="outline"
              icon="sliders"
              label={tab === "pulls" ? "Pull request filters" : "Issue filters"}
              className="gh-filter-btn"
              aria-haspopup="dialog"
              aria-expanded={filterOpen}
              pressed={serverFilterCount > 0 || undefined}
              badge={serverFilterCount || null}
              onClick={() => setFilterOpen((o) => !o)}
            />
          )}
          <IconButton variant="outline" icon="code" label="Browse files" className="gh-browse-cta" onClick={() => gotoBrowse()} />
          <ToolbarMoreMenu items={narrowMenuItems} />
        </>
      }
    >
      <div className="v2-filterbar-main gh-tb-scroll" ref={tbScrollRef}>
      <FilterPills
        label="GitHub hub sections"
        className="gh-kind-pills"
        value={tab}
        onChange={(k) => onTabClick(k as ListKey)}
        items={[
          { key: "issues", label: "Issues", count: listCount("issues"), icon: <GhIcon name="issueDot" cls="v2-ico v2-pill-ico" /> },
          { key: "pulls", label: "Pull requests", count: listCount("pulls"), icon: <GhIcon name="pullArrow" cls="v2-ico v2-pill-ico" /> },
        ]}
      />
      <span className="gh-tb-sep" aria-hidden="true" />
      <FilterPills label="Filter" size="sm" className="gh-filter-pills" value={filter} onChange={setFilter} items={filterItems} />
      {tab === "pulls" ? activePullChips() : activeIssueChips()}
      </div>
    </PageToolbar>
  ) : null;

  /* ---- page ----------------------------------------------------------------- */
  return (
    <Shell page="github" title="GitHub" crumbs={shellCrumbs} toolbar={toolbar} flush={!noRepo}>
      <div className={"gh-wrap" + (listMode ? " is-list" : "") + (route.kind ? " is-detail" : "")}>
        {notMember ? (
          <div className="ghlist-card gh-norepo" id="ghlist">
            <div className="gh-empty card-empty" role="status" id="ghNotMember">
              <div className="t1">You&#39;re not a member of this project.</div>
              <p>Ask an owner to invite you to see its GitHub issues and pull requests.</p>
            </div>
          </div>
        ) : browseRoute.on ? (
          cid ? (
            <RepoBrowser
              cid={cid}
              gitRef={browseRoute.ref}
              path={browseRoute.path}
              // never build a github.com/local link for the local sentinel —
              // Orcha Cloud local run, Addendum 2 (RepoBadge deliverable).
              htmlUrlBase={boundRepo && !isLocalRepo(boundRepo) ? `https://github.com/${boundRepo}` : null}
              onNavigate={(next) => gotoBrowse(next, true)}
              leading={
                <IconButton
                  size="sm"
                  icon="arrow-left"
                  className="gh-back"
                  data-gh-back="1"
                  label={"Back to " + (tab === "pulls" ? "pull requests" : "issues")}
                  onClick={exitBrowse}
                />
              }
            />
          ) : null
        ) : (
          <div className={"ghlist-card" + (route.kind ? " gh-detail-mode" : "") + (noRepo ? " gh-norepo" : "")} id="ghlist">
            {route.kind ? detailBody() : listBody()}
          </div>
        )}
      </div>

      {connectOpen && cid ? (
        <ConnectRepoModal
          cid={cid}
          currentRepo={boundRepo}
          fallbackLocalName={snap?.container?.name || null}
          blockedReason={connectBlocked}
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
              role="group"
              aria-label="Assign to an agent"
              onKeyDown={onDdKeyDown}
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

      {listMode ? (
        <Popover anchor={filterBtnRef} open={filterOpen} onClose={() => setFilterOpen(false)} placement="bottom-end" role="dialog" label={tab === "pulls" ? "Pull request filters" : "Issue filters"} className="gh-filter-popover">
          {tab === "pulls" ? pullsFilterPanel() : issuesFilterPanel()}
        </Popover>
      ) : null}

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
