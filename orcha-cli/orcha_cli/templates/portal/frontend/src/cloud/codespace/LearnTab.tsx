/**
 * Learn tab — learn the codebase from your agents.
 *
 *  - Quick starts, aware of the open file + line selection ("Explain this file",
 *    "Why does this exist?", "Teach me the concept at line N", "Give me a tour of
 *    this folder/repo"). Each creates a REAL teach/why code thread anchored to the
 *    file + lines and asks the picked @agent (useStartLesson → createThread).
 *  - The library: every teach|why thread repo-wide (the ?recent= list mode — the
 *    pathless list returns COUNTS, never rows), grouped by file, searchable and
 *    filterable (All · Teach · Why, @agent). A row reads as a lesson: title, the
 *    file:lines it covers and the answering agent's round avatar.
 *  - Opening one shows LessonView: a waiting state while the agent works, then the
 *    answer as a stepped LessonCard that highlights the lines each step cites.
 *
 * The open lesson may be CONTROLLED by CodeSpacePage (so the editor's gutter lesson
 * markers and the floating Teach · Why lens can open one); unmanaged mounts keep
 * their own state.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FilterPills, IconButton, ListGroup, Menu } from "../../components/primitives";
import { Icon } from "../../components/ui";
import { relTime } from "../../lib/format";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { fetchRecentThreads } from "./codespaceApi";
import {
  anchorLabel,
  groupByPath,
  kindLabel,
  learnThreads,
  type CodeThreadDetailPayload,
  type CodeThreadSummary,
  type CreateThreadResponse,
  type ThreadKind,
} from "./codespaceTypes";
import type { FocusRange } from "./editorLessonFocus";
import { buildQuickStarts, type QuickStart } from "./learnQuickStarts";
import { baseName, questionTitle, type LineRef } from "./lesson";
import { lessonTitleFor } from "./lessonTitles";
import { LessonView } from "./LessonView";
import { KindChip, ThreadAuthorAvatar, ThreadStatusIcon } from "./threadBits";
import { useStartLesson } from "./useStartLesson";

export interface LearnTabProps {
  cid: string;
  agents: Agent[];
  gitRef?: string;
  /** The open file ("" / undefined when none). */
  path?: string;
  lineCount?: number;
  selection?: { start: number; end: number } | null;
  /** Controlled open lesson (undefined = uncontrolled). */
  openLessonId?: string | null;
  /** `opts.full` = open it straight into the full-page lesson view. */
  onOpenLesson?: (thread: CodeThreadSummary | null, seed?: CodeThreadDetailPayload | null, opts?: { full?: boolean }) => void;
  /** Full-page lesson mode + its toggles (CodeSpacePage); see LessonView. */
  lessonFull?: boolean;
  onToggleLessonFull?: () => void;
  lessonPresent?: boolean;
  onToggleLessonPresent?: () => void;
  lessonInitialStep?: number;
  onLessonStepChange?: (step: number) => void;
  lessonPeek?: { path: string; content: string } | null;
  /** Optimistic seed for a lesson that was JUST created elsewhere (the editor lens). */
  lessonSeed?: CodeThreadDetailPayload | null;
  onFocusLines?: (ranges: FocusRange[] | null, path: string) => void;
  onOpenFileRef?: (ref: LineRef) => void;
  onJumpToPinnedSha?: (sha: string) => void;
}

type KindFilter = "all" | ThreadKind;

/** The lesson's display title: the remembered lesson title, else the question. */
export function libraryTitle(t: CodeThreadSummary): string {
  return lessonTitleFor(t.id) || (t.first_message ? questionTitle(t.first_message) : kindLabel(t.kind) + " · " + baseName(t.path));
}

export function LearnTab({
  cid,
  agents,
  gitRef = "HEAD",
  path = "",
  lineCount = 0,
  selection = null,
  openLessonId,
  onOpenLesson,
  lessonSeed,
  onFocusLines,
  onOpenFileRef,
  onJumpToPinnedSha,
  lessonFull = false,
  onToggleLessonFull,
  lessonPresent,
  onToggleLessonPresent,
  lessonInitialStep,
  onLessonStepChange,
  lessonPeek,
}: LearnTabProps) {
  const { bump } = useSnapshot();
  const [threads, setThreads] = useState<CodeThreadSummary[] | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  const [seed, setSeed] = useState<CodeThreadDetailPayload | null>(null);
  const [askAgent, setAskAgent] = useState<string>("");
  const token = useRef(0);
  const { start, busy, blocked, aiAgents } = useStartLesson(cid, gitRef, agents);

  const controlled = openLessonId !== undefined;
  const openId = controlled ? openLessonId : localOpen;

  useEffect(() => {
    const myToken = ++token.current;
    // repo-wide: the pathless list returns {by_path} COUNTS — threads come
    // from the recent mode (wire contract; the Learn crash was this mismatch).
    fetchRecentThreads(cid, { n: 50 }).then((res) => {
      if (myToken !== token.current) return;
      setThreads(res.ok ? res.data.threads ?? [] : (prev) => prev ?? []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, bump]);

  const open = (t: CodeThreadSummary | null, s?: CodeThreadDetailPayload | null, opts?: { full?: boolean }) => {
    setSeed(s ?? null);
    if (!controlled) setLocalOpen(t ? t.id : null);
    if (opts) onOpenLesson?.(t, undefined, opts);
    else onOpenLesson?.(t);
  };
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const rowMenuAnchor = useRef<HTMLButtonElement | null>(null);

  const created = (res: CreateThreadResponse | null) => {
    if (!res) return;
    const detail = { thread: res.thread, messages: [res.message] };
    setThreads((prev) => [res.thread, ...(prev ?? []).filter((x) => x.id !== res.thread.id)]);
    open(res.thread, detail);
  };

  const runQuickStart = async (q: QuickStart) => {
    created(await start({ kind: q.kind, path: q.path, start: q.start, end: q.end, body: q.body }, askAgent || null, q.id));
  };

  const followUp = async (question: string, from: CodeThreadSummary) => {
    created(await start({ kind: "teach", path: from.path, start: from.start_line, end: from.end_line, body: question }, from.tagged_agent_id || askAgent || null, question));
  };

  const quickStarts = useMemo(() => buildQuickStarts({ path, lineCount, selection }), [path, lineCount, selection?.start, selection?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  if (openId) {
    const activeSeed = (seed && seed.thread.id === openId ? seed : null) || (lessonSeed && lessonSeed.thread.id === openId ? lessonSeed : null);
    return (
      <LessonView
        key={openId}
        threadId={openId}
        seed={activeSeed ?? undefined}
        agents={agents}
        onBack={() => open(null)}
        onFocusLines={onFocusLines ? (r, other) => {
          const t = (threads ?? []).find((x) => x.id === openId) || activeSeed?.thread;
          onFocusLines(r, other ?? t?.path ?? path);
        } : undefined}
        onOpenFileRef={onOpenFileRef}
        onFollowUp={followUp}
        followUpBusy={busy}
        onJumpToPinnedSha={onJumpToPinnedSha}
        full={lessonFull}
        onToggleFull={onToggleLessonFull}
        present={lessonPresent}
        onTogglePresent={onToggleLessonPresent}
        initialStep={lessonInitialStep}
        onStepChange={onLessonStepChange}
        peek={lessonPeek}
      />
    );
  }

  const taught = learnThreads(threads);
  const q = query.trim().toLowerCase();
  const filtered = taught
    .filter((t) => kindFilter === "all" || t.kind === kindFilter)
    .filter((t) => agentFilter === "all" || t.tagged_agent_id === agentFilter || t.created_by_agent_id === agentFilter)
    .filter((t) => !q || (libraryTitle(t) + " " + (t.first_message ?? "") + " " + t.path).toLowerCase().includes(q));
  // the open file's lessons first, then the rest by recency (list order)
  const grouped = Array.from(groupByPath(filtered).entries()).sort(([a], [b]) => (a === path ? -1 : b === path ? 1 : 0));
  const empty = threads !== null && taught.length === 0;

  return (
    <div className={"cs-learn" + (empty ? " is-empty" : "")}>
      <section className={"cs-learn-hero" + (empty ? " is-big" : "")} aria-label="Start a lesson">
        {empty ? (
          <div className="cs-learn-intro cs-reveal" style={{ ["--i" as string]: 0 }}>
            <span className="cs-learn-glyph" aria-hidden="true"><Icon name="spark" cls="v2-ico" /></span>
            <h3>Learn this codebase</h3>
            <p>Ask an agent to walk you through {path ? <span className="mono">{baseName(path)}</span> : "the repo"}. Answers arrive as step-by-step lessons that light up the lines they explain.</p>
          </div>
        ) : null}
        <div className="cs-learn-qs-head">
          <span className="cs-learn-label">{empty ? "Start with" : "New lesson"}</span>
          <span className="grow" />
          {aiAgents.length ? (
            <select className="cs-agent-select cs-learn-ask" value={askAgent} aria-label="Ask which agent" onChange={(e) => setAskAgent(e.target.value)}>
              <option value="">Ask @{aiAgents[0].alias}</option>
              {aiAgents.slice(1).map((a) => <option key={a.id} value={a.id}>Ask @{a.alias}</option>)}
            </select>
          ) : null}
        </div>
        <div className="cs-learn-qs">
          {quickStarts.map((qs, i) => (
            <button
              key={qs.id}
              type="button"
              className={"cs-learn-qs-card kind-" + qs.kind + " cs-reveal"}
              style={{ ["--i" as string]: i + 1 }}
              disabled={!!busy || !!blocked}
              aria-busy={busy === qs.id || undefined}
              title={blocked || qs.body}
              onClick={() => runQuickStart(qs)}
            >
              <span className="cs-learn-qs-ico" aria-hidden="true"><Icon name={qs.icon} cls="v2-ico" /></span>
              <span className="cs-learn-qs-text">
                <span className="cs-learn-qs-label">{qs.label}</span>
                <span className="cs-learn-qs-hint mono">{qs.hint}</span>
              </span>
              <Icon name={busy === qs.id ? "refresh" : "arrow"} cls={"v2-ico cs-learn-qs-go" + (busy === qs.id ? " is-spinning" : "")} />
            </button>
          ))}
        </div>
        {blocked ? <p className="cs-learn-blocked">{blocked}</p> : null}
      </section>

      {!empty ? (
        <section className="cs-learn-library" aria-label="Lesson library">
          <div className="cs-learn-lib-head">
            <span className="cs-learn-label">Library</span>
            <span className="cs-learn-count">{taught.length}</span>
          </div>
          <label className="cs-learn-search">
            <Icon name="search" cls="v2-ico" />
            <input type="search" value={query} placeholder="Search lessons" aria-label="Search lessons" onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="cs-learn-filters" role="group" aria-label="Filter learning threads">
            <FilterPills
              size="sm"
              label="Kind"
              value={kindFilter}
              onChange={(k) => setKindFilter(k as KindFilter)}
              items={(["all", "teach", "why"] as KindFilter[]).map((k) => ({ key: k, label: k === "all" ? "All" : kindLabel(k as ThreadKind) }))}
            />
            <select className="cs-agent-select" value={agentFilter} aria-label="Filter by agent" onChange={(e) => setAgentFilter(e.target.value)}>
              <option value="all">All agents</option>
              {aiAgents.map((a) => <option key={a.id} value={a.id}>@{a.alias}</option>)}
            </select>
          </div>
          {!filtered.length ? (
            <div className="cs-empty-line">No lessons match.</div>
          ) : (
            grouped.map(([p, list]) => (
              <ListGroup
                key={p}
                id={p}
                title={<><span className="cs-learn-group-path mono" title={p}>{p}</span>{p === path ? <span className="cs-learn-open-tag">open</span> : null}</>}
                count={list.length}
                level={4}
                className="cs-learn-group"
              >
                {list.map((t) => {
                  const alias = t.tagged_alias || null;
                  return (
                    <div
                      key={t.id}
                      className={"cs-thread-chip cs-lesson-row kind-" + t.kind}
                      role="button"
                      tabIndex={0}
                      aria-label={libraryTitle(t) + ", " + kindLabel(t.kind) + " lesson on " + baseName(t.path) + " line " + anchorLabel(t.start_line, t.end_line)}
                      onClick={() => open(t)}
                      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(t); } }}
                    >
                      <span className="cs-thread-av">
                        <ThreadAuthorAvatar alias={alias} id={t.tagged_agent_id} kind={t.kind} agents={agents} />
                      </span>
                      <div className="cs-thread-main">
                        <div className="row1">
                          <span className="body-preview cs-lesson-row-title">{libraryTitle(t)}</span>
                        </div>
                        <div className="cs-thread-meta">
                          <KindChip kind={t.kind} />
                          <span className="anchor mono">{baseName(t.path)}:{anchorLabel(t.start_line, t.end_line)}</span>
                          {alias ? <span className="cs-thread-who">@{alias}</span> : null}
                        </div>
                      </div>
                      <div className="cs-thread-side">
                        <ThreadStatusIcon status={t.status} />
                        <span className="cs-thread-time">{relTime(t.updated_at || t.created_at)}</span>
                      </div>
                      {onOpenLesson ? (
                        // row menu: its own click/keys never open the row underneath
                        <span className="cs-lesson-row-menu" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                          <IconButton
                            size="sm"
                            icon="more"
                            label={"Lesson actions for " + libraryTitle(t)}
                            title="Lesson actions"
                            aria-haspopup="menu"
                            aria-expanded={rowMenu === t.id}
                            onClick={(e) => { rowMenuAnchor.current = e.currentTarget; setRowMenu((m) => (m === t.id ? null : t.id)); }}
                          />
                          {rowMenu === t.id ? (
                            <Menu
                              anchor={rowMenuAnchor}
                              open
                              onClose={() => setRowMenu(null)}
                              label="Lesson actions"
                              placement="bottom-end"
                              items={[
                                { label: "Open lesson", icon: "arrow", onSelect: () => { setRowMenu(null); open(t); } },
                                { label: "Open full page", icon: "maximize", hint: "F", onSelect: () => { setRowMenu(null); open(t, null, { full: true }); } },
                              ]}
                            />
                          ) : null}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </ListGroup>
            ))
          )}
        </section>
      ) : null}
    </div>
  );
}
