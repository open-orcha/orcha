/**
 * Learn — one lesson (a teach/why code thread) in the Learn tab. Polls the thread on
 * the house 3s bump; while no agent has answered it shows LessonWaiting (honest live
 * state from the snapshot + the agent's run stream), then reveals the answer as a
 * LessonCard. The raw conversation is one click away ("Conversation") for replies.
 *
 * The top bar also carries the full-page toggle (Expand ⇄ Exit, F / Esc) and, in
 * full page at wide widths, the Present toggle; CodeSpacePage owns both states.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Button, IconButton, LivePill } from "../../components/primitives";
import { useRunStream } from "../../hooks/useRunStream";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Run } from "../../types";
import { fetchThread } from "./codespaceApi";
import type { CodeThreadDetailPayload, CodeThreadSummary } from "./codespaceTypes";
import type { FocusRange } from "./editorLessonFocus";
import { baseName, lessonParts, parseLesson, questionTitle, type LineRef } from "./lesson";
import { rememberLessonTitle } from "./lessonTitles";
import { LessonCard } from "./LessonCard";
import { actorKind, ThreadStatusIcon } from "./threadBits";
import { ThreadView } from "./ThreadView";

export interface LessonViewProps {
  threadId: string;
  seed?: CodeThreadDetailPayload;
  agents: Agent[];
  onBack: () => void;
  onFocusLines?: (ranges: FocusRange[] | null, path?: string) => void;
  onOpenFileRef?: (ref: LineRef) => void;
  onFollowUp?: (question: string, thread: CodeThreadSummary) => void;
  followUpBusy?: string | null;
  onJumpToPinnedSha?: (sha: string) => void;
  /** Full-page lesson mode (CodeSpacePage `view=full`). */
  full?: boolean;
  /** Enter / exit full page (the header toggle and F). Omitted = no toggle. */
  onToggleFull?: () => void;
  /** Presenter mode (full page, wide only): also hides the app sidebar. */
  present?: boolean;
  onTogglePresent?: () => void;
  initialStep?: number;
  onStepChange?: (step: number) => void;
  peek?: { path: string; content: string } | null;
}

export function LessonView({
  threadId, seed, agents, onBack, onFocusLines, onOpenFileRef, onFollowUp, followUpBusy, onJumpToPinnedSha,
  full = false, onToggleFull, present = false, onTogglePresent, initialStep, onStepChange, peek,
}: LessonViewProps) {
  const { bump } = useSnapshot();
  const [detail, setDetail] = useState<CodeThreadDetailPayload | null>(seed && seed.thread.id === threadId ? seed : null);
  const [failed, setFailed] = useState(false);
  const [conversation, setConversation] = useState(false);
  const token = useRef(0);

  useEffect(() => {
    setConversation(false);
  }, [threadId]);

  useEffect(() => {
    const my = ++token.current;
    fetchThread(threadId).then((res) => {
      if (my !== token.current) return;
      if (res.ok && res.data.thread) { setDetail(res.data); setFailed(false); }
      else setFailed((f) => f || !detail);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, bump]);

  const thread = detail?.thread;
  const { question, answer } = lessonParts(detail?.messages);
  const lesson = useMemo(
    () => (answer && thread ? parseLesson(answer.body, { path: thread.path, fallbackTitle: question?.body }) : null),
    [answer?.body, thread?.path, question?.body], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    if (lesson && thread) rememberLessonTitle(thread.id, lesson.title);
  }, [lesson?.title, thread?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (conversation && thread) {
    return <ThreadView threadId={threadId} onBack={() => setConversation(false)} onJumpToPinnedSha={onJumpToPinnedSha} />;
  }
  if (!detail || !thread) {
    return (
      <div className="cs-lesson-wrap">
        <div className="cs-lesson-top">
          <Button size="sm" variant="ghost" pill icon="arrow-left" onClick={onBack}>Library</Button>
        </div>
        {failed ? <div className="cs-empty-line">Couldn&#39;t load this lesson.</div> : <LessonSkeleton />}
      </div>
    );
  }

  const answerAlias = answer?.author_alias || agents.find((a) => a.id === answer?.author_agent_id)?.alias || null;
  const extraReplies = Math.max(0, detail.messages.length - 2);

  return (
    <div className={"cs-lesson-wrap" + (full ? " is-full" : "")}>
      <div className="cs-lesson-top">
        <Button size="sm" variant="ghost" pill icon="arrow-left" onClick={onBack}>Library</Button>
        <span className="grow" />
        <ThreadStatusIcon status={thread.status} />
        <Button size="sm" variant="ghost" pill icon="inbox" onClick={() => setConversation(true)} title="Open the full thread to reply">
          {extraReplies ? "Conversation · " + extraReplies : "Conversation"}
        </Button>
        {full && onTogglePresent ? (
          <Button
            size="sm"
            variant={present ? "secondary" : "ghost"}
            pill
            icon="play"
            className="cs-lesson-present"
            aria-pressed={present}
            onClick={onTogglePresent}
            title={present ? "Show the sidebar again" : "Present: hide the sidebar for a distraction-free walkthrough"}
          >
            Present
          </Button>
        ) : null}
        {onToggleFull ? (
          <IconButton
            size="sm"
            icon={full ? "minimize" : "maximize"}
            className="cs-lesson-expand"
            label={full ? "Exit full page" : "Full page"}
            title={full ? "Exit full page (Esc)" : "Full page (F)"}
            aria-keyshortcuts={full ? "Escape F" : "F"}
            pressed={full}
            onClick={onToggleFull}
          />
        ) : null}
      </div>
      {question ? (
        <p className="cs-lesson-question" title={question.body}>
          <span className="cs-lesson-question-mark" aria-hidden="true">“</span>{questionTitle(question.body, 140)}
        </p>
      ) : null}
      {lesson && answer ? (
        <LessonCard
          key={thread.id}
          lesson={lesson}
          kind={thread.kind}
          path={thread.path}
          anchor={{ start: thread.start_line, end: thread.end_line }}
          agentAlias={answerAlias}
          agentKind={actorKind(agents, answer.author_agent_id, answerAlias) ?? "ai"}
          answeredAt={answer.created_at ?? null}
          onFocusLines={onFocusLines}
          onOpenFileRef={onOpenFileRef}
          onFollowUp={onFollowUp ? (q) => onFollowUp(q, thread) : undefined}
          followUpBusy={followUpBusy}
          followFiles={full}
          initialStep={initialStep}
          onStepChange={onStepChange}
          onToggleFull={onToggleFull}
          peek={full ? peek : null}
        />
      ) : (
        <LessonWaiting thread={thread} agents={agents} />
      )}
    </div>
  );
}

/* ---- waiting: part of the show, but honest -------------------------------- */

export function LessonWaiting({ thread, agents }: { thread: CodeThreadSummary; agents: Agent[] }) {
  const { snap } = useSnapshot();
  const all = snap?.agents ?? agents;
  const agent = all.find((a) => a.id === thread.tagged_agent_id) || (thread.tagged_alias ? all.find((a) => a.alias === thread.tagged_alias) : undefined);
  const alias = agent?.alias || thread.tagged_alias || null;
  const running = !!agent?.active_run?.run_id;
  const run = useMemo<Run | null>(
    () => (running && agent ? ({ run_id: agent.active_run!.run_id, id: agent.active_run!.run_id, status: "running", agent_id: agent.id, agent: agent.alias } as Run) : null),
    [running, agent?.id, agent?.active_run?.run_id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const events = useRunStream(run);
  const ticker = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if ((e.type === "tool" || e.type === "narrate" || e.type === "think") && e.text && e.text.trim()) return (e.label && e.type === "tool" ? e.label + " " : "") + e.text.trim();
    }
    return null;
  }, [events]);
  const file = baseName(thread.path);

  return (
    <div className="cs-lesson-waiting" role="status" aria-live="polite">
      <div className="cs-waiting-hero">
        <span className={"cs-waiting-orb" + (running ? " is-live" : "")} aria-hidden="true">
          {alias ? <Avatar alias={alias} kind="ai" size={32} decorative /> : null}
        </span>
        <div className="cs-waiting-text">
          <div className="cs-waiting-line">
            {alias ? <b>@{alias}</b> : "An agent"}
            {running ? <> is reading <span className="mono">{file}</span></> : <> will read <span className="mono">{file}</span></>}
            <span className="cs-waiting-dots" aria-hidden="true"><i /><i /><i /></span>
          </div>
          <div className="cs-waiting-sub">
            {running ? (
              <>
                <LivePill state="working" />
                {ticker ? <span className="cs-waiting-ticker mono" key={ticker} title={ticker}>{ticker}</span> : <span>Writing your lesson</span>}
              </>
            ) : (
              <span>Queued — the lesson appears here as soon as {alias ? "@" + alias : "an agent"} answers.</span>
            )}
          </div>
        </div>
      </div>
      <LessonSkeleton />
    </div>
  );
}

function LessonSkeleton() {
  return (
    <div className="cs-lesson-skeleton" aria-hidden="true">
      <span className="sk sk-title" />
      <span className="sk sk-line" />
      {[0, 1, 2].map((i) => (
        <span key={i} className="sk-step" style={{ ["--i" as string]: i }}>
          <span className="sk sk-dot" />
          <span className="sk sk-line" />
        </span>
      ))}
    </div>
  );
}
