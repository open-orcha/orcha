/**
 * Learn — an agent's teach/why answer rendered as a LESSON, not a chat log:
 * title, one-line summary, a stepped walkthrough (progress + Prev/Next + ←/→),
 * key-concept chips and one-click follow-up questions.
 *
 * Every step that cites lines (lesson.ts parseLineRefs) drives the editor: the
 * active step's local refs are handed to `onFocusLines`, which CodeSpacePage turns
 * into a smooth scroll + a soft glow on those lines with the rest dimmed. A plain
 * prose answer (structured=false) steps paragraph by paragraph the same way.
 *
 * Motion is CSS only (codespace.css `.cs-lesson*`): a staggered reveal on mount
 * (`--i` per block) and a directional slide when the active step changes; all of
 * it is disabled under prefers-reduced-motion.
 *
 * Full-page mode (CodeSpacePage `view=full`): `followFiles` makes a step that only
 * cites ANOTHER file drive the editor to that file (lesson.ts stepTarget — the page
 * navigates), `peek` renders the active step's lines inline for the single-column
 * narrow layout, and `onToggleFull` binds F. J/K step like →/←. The active step
 * is reported through `onStepChange` so the page can mirror it in the URL.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, Button, Chip } from "../../components/primitives";
import { isEditingTarget } from "../../components/primitives";
import { Icon, Md } from "../../components/ui";
import { highlightLine } from "../github/browse/highlight";
import { relTime } from "../../lib/format";
import type { ThreadKind } from "./codespaceTypes";
import type { FocusRange } from "./editorLessonFocus";
import { baseName, localRefs, refLabel, stepTarget, type Lesson, type LineRef } from "./lesson";
import { KindChip } from "./threadBits";

export interface LessonCardProps {
  lesson: Lesson;
  kind: ThreadKind;
  /** The lesson's anchor file (refs without a path point here). */
  path: string;
  anchor: { start: number; end: number };
  agentAlias?: string | null;
  agentKind?: "ai" | "human";
  answeredAt?: string | null;
  /** The active step's lines. `path` is only passed when they're in ANOTHER file
   *  (followFiles); omitted = the lesson's own file. */
  onFocusLines?: (ranges: FocusRange[] | null, path?: string) => void;
  /** A ref naming ANOTHER file was clicked. */
  onOpenFileRef?: (ref: LineRef) => void;
  onFollowUp?: (question: string) => void;
  /** Follow-up currently being created (disables its button). */
  followUpBusy?: string | null;
  initialStep?: number;
  /** Listen for ←/→ on the document (default true; the card is the only lesson on screen). */
  globalKeys?: boolean;
  /** Full page: a step citing only another file points the editor THERE. */
  followFiles?: boolean;
  onStepChange?: (step: number) => void;
  /** F toggles full page (bound only when given). */
  onToggleFull?: () => void;
  /** Single-column full page: the loaded file, for the active step's inline code peek. */
  peek?: { path: string; content: string } | null;
}

/** The first line of a file's peek, clamped: at most this many lines per step. */
const PEEK_MAX = 40;

function stepRanges(refs: LineRef[], path: string): FocusRange[] | null {
  const local = localRefs(refs, path);
  return local.length ? local.map((r) => ({ start: r.start, end: r.end })) : null;
}

export function LessonCard({
  lesson,
  kind,
  path,
  anchor,
  agentAlias,
  agentKind,
  answeredAt,
  onFocusLines,
  onOpenFileRef,
  onFollowUp,
  followUpBusy,
  initialStep = 0,
  globalKeys = true,
  followFiles = false,
  onStepChange,
  onToggleFull,
  peek = null,
}: LessonCardProps) {
  const total = lesson.steps.length;
  const [step, setStep] = useState(() => Math.min(Math.max(0, initialStep), Math.max(0, total - 1)));
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  // an explicit ref chip click overrides the step's own ranges until the step changes
  const [pinned, setPinned] = useState<{ path: string; ranges: FocusRange[] } | null>(null);
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);
  const onFocusRef = useRef(onFocusLines);
  onFocusRef.current = onFocusLines;
  const onStepRef = useRef(onStepChange);
  onStepRef.current = onStepChange;
  const onToggleFullRef = useRef(onToggleFull);
  onToggleFullRef.current = onToggleFull;

  const go = useCallback((next: number) => {
    setStep((cur) => {
      const n = Math.min(Math.max(0, next), Math.max(0, total - 1));
      if (n !== cur) { setDir(n > cur ? "fwd" : "back"); setPinned(null); }
      return n;
    });
  }, [total]);

  // drive the editor: the active step's cited lines (or a pinned ref)
  const active = lesson.steps[step];
  const target = useMemo(() => {
    if (!active) return null;
    if (followFiles) return stepTarget(active, path);
    const r = stepRanges(active.refs, path);
    return r ? { path, ranges: r } : null;
  }, [active, followFiles, path]);
  const focusKey = JSON.stringify(pinned ?? target);
  useEffect(() => {
    const f = JSON.parse(focusKey) as { path: string; ranges: FocusRange[] } | null;
    if (!f) onFocusRef.current?.(null);
    else if (f.path === path) onFocusRef.current?.(f.ranges);
    else onFocusRef.current?.(f.ranges, f.path);
  }, [focusKey, path]);
  useEffect(() => { onStepRef.current?.(step); }, [step]);
  // leaving the lesson clears the glow/dim
  useEffect(() => () => onFocusRef.current?.(null), []);

  // keep the active step in view inside the rail
  useEffect(() => {
    const el = stepRefs.current[step];
    if (el && typeof el.scrollIntoView === "function") {
      const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }
  }, [step]);

  // ←/→ step (never while typing, in a select, on a tab strip or inside an editor)
  useEffect(() => {
    if (!globalKeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const nav = k === "ArrowRight" || k === "ArrowLeft" || k === "j" || k === "k";
      const full = k === "f" && !!onToggleFullRef.current;
      if (!nav && !full) return;
      const t = e.target as Element | null;
      if (isEditingTarget(t) || (t && (t as HTMLElement).closest?.('[role="tablist"], [role="slider"], [role="separator"], [role="menu"], [role="dialog"], .cm-editor'))) return;
      e.preventDefault();
      if (full) { onToggleFullRef.current?.(); return; }
      go(k === "ArrowRight" || k === "j" ? step + 1 : step - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [globalKeys, go, step]);

  const clickRef = (i: number, r: LineRef) => {
    const other = !!r.path && localRefs([r], path).length === 0;
    if (other && !followFiles) { onOpenFileRef?.(r); return; }
    if (i !== step) go(i);
    setPinned({ path: other ? r.path! : path, ranges: [{ start: r.start, end: r.end }] });
  };

  // single-column full page: the active step's own lines, inline
  const peekFocus = pinned ?? target;
  const peekLines = useMemo(() => {
    if (!peek || !peekFocus || peek.path !== peekFocus.path) return null;
    const all = peek.content.split("\n");
    const out: { n: number; text: string }[] = [];
    const seen = new Set<number>();
    for (const r of peekFocus.ranges) {
      for (let n = Math.max(1, r.start); n <= Math.min(all.length, Math.max(r.start, r.end)) && out.length < PEEK_MAX; n++) {
        if (!seen.has(n)) { seen.add(n); out.push({ n, text: all[n - 1] }); }
      }
    }
    return out.length ? out.sort((a, b) => a.n - b.n) : null;
  }, [peek, peekFocus]);

  const pct = total ? Math.round(((step + 1) / total) * 100) : 0;
  const anchorText = baseName(path) + ":" + (anchor.start === anchor.end ? anchor.start : anchor.start + "–" + anchor.end);

  return (
    <article className={"cs-lesson" + (lesson.structured ? " is-structured" : " is-prose")} aria-label={"Lesson: " + lesson.title} aria-roledescription="lesson">
      <header className="cs-lesson-head cs-reveal" style={{ ["--i" as string]: 0 }}>
        <div className="cs-lesson-eyebrow">
          <KindChip kind={kind} />
          <span className="cs-lesson-anchor mono" title={path}>{anchorText}</span>
        </div>
        <h2 className="cs-lesson-title">{lesson.title}</h2>
        {lesson.summary ? <p className="cs-lesson-summary">{lesson.summary}</p> : null}
        {agentAlias ? (
            <span className="cs-lesson-by" title={"Answered by @" + agentAlias}>
              <Avatar alias={agentAlias} kind={agentKind ?? "ai"} size={20} decorative />
              <span className="cs-lesson-by-name">@{agentAlias}</span>
              {answeredAt ? <span className="cs-lesson-by-time">· {relTime(answeredAt)}</span> : null}
            </span>
          ) : null}
      </header>

      {total > 1 ? (
        <div className="cs-lesson-progress cs-reveal" style={{ ["--i" as string]: 1 }}>
          <div
            className="cs-lesson-bar"
            role="progressbar"
            aria-label="Lesson progress"
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={step + 1}
            aria-valuetext={"Step " + (step + 1) + " of " + total}
          >
            <span style={{ width: pct + "%" }} />
          </div>
          <span className="cs-lesson-count" aria-hidden="true">{step + 1} / {total}</span>
        </div>
      ) : null}

      <ol className={"cs-lesson-steps dir-" + dir}>
        {lesson.steps.map((s, i) => {
          const state = i === step ? " is-active" : i < step ? " is-done" : "";
          return (
            <li
              key={i}
              ref={(el) => { stepRefs.current[i] = el; }}
              className={"cs-lesson-step cs-reveal" + state}
              style={{ ["--i" as string]: 2 + Math.min(i, 6) }}
              aria-current={i === step ? "step" : undefined}
            >
              <button type="button" className="cs-lesson-step-dot" onClick={() => go(i)} aria-label={"Go to step " + (i + 1)}>
                {i < step ? <Icon name="check" cls="v2-ico" /> : i + 1}
              </button>
              <div className="cs-lesson-step-main" onClick={() => { if (i !== step) go(i); }}>
                {s.title ? <div className="cs-lesson-step-title">{s.title}</div> : null}
                {s.body ? <Md text={s.body} className={"cs-lesson-step-body tx md" + (i === step ? " is-entering" : "")} /> : null}
                {i === step && peekLines ? (
                  <details className="cs-lesson-peek" open onClick={(e) => e.stopPropagation()}>
                    <summary>
                      <Icon name="code" cls="v2-ico" />
                      <span className="mono">{baseName(peekFocus!.path)}:{refLabel({ start: peekLines[0].n, end: peekLines[peekLines.length - 1].n })}</span>
                    </summary>
                    <pre className="cs-lesson-peek-code mono" aria-label={"Code for step " + (i + 1)}>
                      {peekLines.map((ln, j) => (
                        <div key={ln.n} className={"cs-lesson-peek-line" + (j > 0 && peekLines[j - 1].n !== ln.n - 1 ? " is-gap" : "")}>
                          <span className="cs-lesson-peek-n">{ln.n}</span>
                          <span className="cs-lesson-peek-t">
                            {highlightLine(ln.text, peekFocus!.path).map((tk, x) => (
                              tk.kind === "plain" ? <span key={x}>{tk.text}</span> : <span key={x} className={"rb-tok-" + tk.kind}>{tk.text}</span>
                            ))}
                          </span>
                        </div>
                      ))}
                    </pre>
                  </details>
                ) : null}
                {s.refs.length ? (
                  <div className="cs-lesson-refs">
                    {s.refs.map((r) => {
                      const other = !!r.path && localRefs([r], path).length === 0;
                      return (
                        <button
                          key={(r.path ?? "") + r.start + "-" + r.end}
                          type="button"
                          className={"cs-lesson-ref mono" + (other ? " is-other" : "")}
                          title={other ? (followFiles ? "Show " : "Open ") + r.path + " at line " + r.start : "Highlight " + refLabel(r)}
                          onClick={(e) => { e.stopPropagation(); clickRef(i, r); }}
                        >
                          {other ? baseName(r.path!) + ":" : ""}{refLabel(r)}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {total > 1 ? (
        <div className="cs-lesson-nav cs-reveal" style={{ ["--i" as string]: 3 }}>
          <Button size="sm" variant="ghost" icon="chev-left" onClick={() => go(step - 1)} disabled={step === 0} aria-label="Previous step">
            Prev
          </Button>
          <span className="cs-lesson-keys" aria-hidden="true"><kbd>←</kbd><kbd>→</kbd>{followFiles ? <><kbd>J</kbd><kbd>K</kbd></> : null}</span>
          <Button size="sm" variant={step === total - 1 ? "ghost" : "secondary"} iconRight="chev-right" onClick={() => go(step + 1)} disabled={step === total - 1} aria-label="Next step">
            Next
          </Button>
        </div>
      ) : null}

      {lesson.concepts.length ? (
        <section className="cs-lesson-concepts cs-reveal" style={{ ["--i" as string]: 4 }} aria-label="Key concepts">
          <div className="cs-lesson-label">Key concepts</div>
          <div className="cs-lesson-chips">
            {lesson.concepts.map((c) => (
              <Chip key={c} size="sm" dot="auto" dotKey={c}>{c}</Chip>
            ))}
          </div>
        </section>
      ) : null}

      {lesson.followUps.length && onFollowUp ? (
        <section className="cs-lesson-followups cs-reveal" style={{ ["--i" as string]: 5 }} aria-label="Follow-up questions">
          <div className="cs-lesson-label">Go deeper</div>
          {lesson.followUps.map((q) => (
            <button
              key={q}
              type="button"
              className="cs-lesson-followup"
              disabled={!!followUpBusy}
              aria-busy={followUpBusy === q || undefined}
              onClick={() => onFollowUp(q)}
              title="Ask this as a new lesson"
            >
              <Icon name="spark" cls="v2-ico" />
              <span>{q}</span>
              <Icon name="arrow" cls="v2-ico cs-lesson-followup-go" />
            </button>
          ))}
        </section>
      ) : null}
    </article>
  );
}
