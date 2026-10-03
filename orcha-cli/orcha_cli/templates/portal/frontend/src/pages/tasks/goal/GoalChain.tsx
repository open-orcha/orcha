/**
 * Goal ancestry breadcrumb — "Objective › Parent › Parent › This task" — shown
 * above the task title in the inspector, the narrow detail and the full view.
 *
 * Mount (integrator): in TaskDetail's body, directly above the `.td-title` h1:
 *     <GoalChain taskId={t.id} />
 * It is self-contained: fetches GET /api/tasks/{tid}/goal-chain, carries its
 * own styles (goalCss), reads the snapshot (tasks for the parent picker, the
 * acting human for writes) from SnapshotProvider.
 *
 * Truthful (brief §3): only stored facts — the project's stated objective (or
 * "No objective set"), real parent links / request-derived parents, this task.
 * Nothing renders while loading or on error (no fake crumbs); the title below
 * is never repeated (D12) — the last crumb reads "This task".
 *
 * Linear-grade (D6/D8/D12): 12 px muted single line, shared status glyphs,
 * chevron separators, ellipsis + tooltip, a compact circular "Set parent"
 * control only for someone who may act.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { Icon, useToast } from "../../../components/ui";
import { Popover, StatusGlyph } from "../../../components/primitives";
import { useActingAuthority, useSnapshot } from "../../../state/SnapshotProvider";
import type { Task } from "../../../types";
import {
  chainText,
  clip,
  directParent,
  fetchGoalChain,
  parentCandidates,
  putTaskParent,
  viaLabel,
  type GoalChain as GoalChainData,
  type GoalNode,
} from "./goalApi";
import { goalChainCss } from "./goalCss";

/** re-read at most this often on snapshot polls (titles / statuses of parents move) */
const REFRESH_MS = 15_000;

export interface GoalChainViewProps {
  chain: GoalChainData;
  /** may the viewer change the parent (null = read-only; the string is why) */
  canEdit: boolean;
  readOnlyReason?: string | null;
  onEditParent?: (anchor: HTMLButtonElement) => void;
  editOpen?: boolean;
}

/** Parents shown in full before the far ones fold into a single "…" crumb:
 * with more, every crumb squeezed to "G…" and "This task" was clipped off at
 * inspector width (QA goal-ancestry r1 UI-15/16). */
const MAX_SHOWN_PARENTS = 2;

/** Pure breadcrumb (unit-tested). */
export function GoalChainView({ chain, canEdit, readOnlyReason, onEditParent, editOpen }: GoalChainViewProps) {
  const btn = useRef<HTMLButtonElement | null>(null);
  const nodes = chain.goal_chain;
  const parent = directParent(chain);
  const editLabel = parent ? "Change parent task" : "Set parent task";
  // the root task's chain is the objective alone — it can never take a parent (server 400)
  const isRoot = !nodes.some((n) => n.kind === "task");
  const parents = nodes.filter((n) => n.kind === "parent");
  const folded = parents.length > MAX_SHOWN_PARENTS ? parents.slice(0, parents.length - MAX_SHOWN_PARENTS) : [];
  const shown = nodes.filter((n) => !folded.includes(n));
  const lead = shown[0]?.kind === "objective" ? 1 : 0;
  // ONE gap crumb sits where the hidden hops are (right after the objective): "…" for
  // folded parents (tooltip names them, and says when more exist above), else the
  // truncation / loop note on its own
  const gaps: ReactElement[] = [];
  const note = chain.cycle ? "The parent links loop — showing each task once" : chain.truncated ? "More ancestors exist above these" : "";
  if (folded.length || note) {
    const hidden = folded.map((n) => n.title).join(" › ");
    const tip = folded.length
      ? folded.length + " more parent task" + (folded.length === 1 ? "" : "s") + ": " + hidden + (note ? " — " + note : "")
      : note;
    gaps.push(
      <li key="gc-gap" className={"gc-crumb gc-note" + (folded.length ? " gc-fold" : "")} title={tip}>
        {lead ? <Icon name="chev-right" cls="v2-ico gc-sep" /> : null}
        <span className="v2-muted" aria-label={tip}>
          {folded.length ? "…" : chain.cycle ? "(loop)" : "(more above)"}
        </span>
      </li>,
    );
  }
  const crumb = (n: GoalNode, i: number) => (
    <li
      key={n.kind + ":" + (n.id ?? i)}
      className={"gc-crumb gc-" + n.kind + (n === parent ? " is-nearest" : n.kind === "parent" ? " is-far" : "")}
    >
      {i > 0 || (gaps.length > 0 && i >= lead) ? <Icon name="chev-right" cls="v2-ico gc-sep" /> : null}
      <Crumb n={n} />
    </li>
  );
  return (
    <nav className="gc" aria-label="Goal chain" title={chainText(chain)} data-testid="goal-chain">
      <ol className="gc-list">
        {shown.slice(0, lead).map(crumb)}
        {gaps}
        {shown.slice(lead).map((n, i) => crumb(n, i + lead))}
      </ol>
      {onEditParent && !isRoot ? (
        <button
          ref={btn}
          type="button"
          className="gc-edit"
          aria-label={canEdit ? editLabel : editLabel + " — " + (readOnlyReason || "view-only")}
          title={canEdit ? editLabel : readOnlyReason || "View-only"}
          aria-haspopup="menu"
          aria-expanded={!!editOpen}
          disabled={!canEdit}
          data-act="set-parent"
          onClick={() => btn.current && onEditParent(btn.current)}
        >
          <Icon name="link" cls="v2-ico" />
        </button>
      ) : null}
    </nav>
  );
}

function Crumb({ n }: { n: GoalNode }) {
  if (n.kind === "objective") {
    return n.text ? (
      <span className="gc-obj" title={"Project objective (" + n.title + "): " + n.text}>
        <Icon name="flag" cls="v2-ico gc-obj-ico" />
        <span className="gc-label">{clip(n.text, 90)}</span>
      </span>
    ) : (
      <span className="gc-obj is-empty" title={n.title + " has no stated objective"}>
        <Icon name="flag" cls="v2-ico gc-obj-ico" />
        <span className="gc-label">
          {n.title ? n.title + " · " : ""}
          <span className="v2-muted">No objective set</span>
        </span>
      </span>
    );
  }
  if (n.kind === "parent" && n.id) {
    return (
      <Link
        className="gc-link"
        to={"/tasks?task=" + encodeURIComponent(n.id)}
        title={viaLabel(n) + ": " + n.title}
        data-parent={n.id}
        data-via={n.via || undefined}
      >
        {n.status ? <StatusGlyph status={n.status} size={12} /> : null}
        <span className="gc-label">{n.title}</span>
      </Link>
    );
  }
  return (
    <span className="gc-self" aria-current="page" title={"This task: " + n.title}>
      This task
    </span>
  );
}

/** Searchable single-select menu of parent candidates (+ "Remove parent"). */
function ParentMenu({
  anchor,
  open,
  onClose,
  tasks,
  taskId,
  current,
  canClear,
  onPick,
}: {
  anchor: { current: HTMLElement | null };
  open: boolean;
  onClose: () => void;
  tasks: Task[] | undefined;
  taskId: string;
  current: string | null;
  canClear: boolean;
  onPick: (id: string | null) => void;
}) {
  const [q, setQ] = useState("");
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  const opts = parentCandidates(tasks, taskId, q).slice(0, 50);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"],[role="menuitem"]'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    let j = -1;
    if (e.key === "ArrowDown") j = (i + 1) % items.length;
    else if (e.key === "ArrowUp") j = i <= 0 ? items.length - 1 : i - 1;
    if (j >= 0 && items.length) {
      e.preventDefault();
      items[j].focus();
    }
  };
  const pick = (id: string | null) => {
    onClose();
    onPick(id);
  };
  const act = (id: string | null) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(id);
    }
  };
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} role="menu" label="Parent task" className="v2-menu gc-menu">
      <div className="v2-menu-inner" onKeyDown={onKey}>
        <input
          className="gc-search"
          type="search"
          placeholder="Parent task…"
          aria-label="Search tasks"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && opts[0]) {
              e.preventDefault();
              pick(opts[0].id);
            }
          }}
        />
        {canClear ? (
          <div role="menuitem" tabIndex={-1} className="v2-menu-item gc-clear" onClick={() => pick(null)} onKeyDown={act(null)}>
            <Icon name="x" cls="v2-ico" />
            <span className="v2-menu-label">Remove parent</span>
          </div>
        ) : null}
        {opts.length ? (
          opts.map((t) => (
            <div
              key={t.id}
              role="menuitemradio"
              aria-checked={t.id === current}
              tabIndex={-1}
              data-value={t.id}
              className="v2-menu-item gc-opt"
              onClick={() => pick(t.id)}
              onKeyDown={act(t.id)}
            >
              <StatusGlyph status={t.status} size={12} />
              <span className="v2-menu-label">{t.title}</span>
              {t.id === current ? <Icon name="check" cls="v2-ico v2-menu-check" /> : null}
            </div>
          ))
        ) : (
          <div className="gc-empty v2-muted">No matching tasks</div>
        )}
      </div>
    </Popover>
  );
}

/** Connected breadcrumb: fetch + parent editing. The integrator mounts this. */
export function GoalChain({ taskId }: { taskId: string }) {
  const { snap, bump } = useSnapshot();
  const auth = useActingAuthority();
  const toast = useToast();
  const [chain, setChain] = useState<GoalChainData | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const lastAt = useRef(0);
  const live = useRef(taskId);
  live.current = taskId;

  const load = useCallback(
    (signal?: AbortSignal) => {
      lastAt.current = Date.now();
      const tid = taskId;
      fetchGoalChain(tid, signal)
        .then((c) => {
          if (live.current === tid) setChain(c);
        })
        .catch(() => {
          /* read failure: keep what we had (or nothing) — never invent crumbs */
        });
    },
    [taskId],
  );

  useEffect(() => {
    setChain(null);
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  useEffect(() => {
    if (bump && Date.now() - lastAt.current >= REFRESH_MS) load();
  }, [bump, load]);

  if (!chain || chain.task_id !== taskId) return null;
  const human = auth.human;
  const parent = directParent(chain);
  const onPick = (pid: string | null) => {
    if (!human) return;
    putTaskParent(taskId, pid, human.id)
      .then((c) => {
        if (live.current === taskId) setChain(c);
        toast(pid ? "Parent task set" : "Parent removed", "ok");
      })
      .catch((e: Error) => toast("Couldn't change the parent — " + (e.message || "error"), "danger"));
  };
  return (
    <>
      <style>{goalChainCss}</style>
      <GoalChainView
        chain={chain}
        canEdit={!!human && !auth.readOnly}
        readOnlyReason={auth.reason}
        editOpen={menuOpen}
        onEditParent={(el) => {
          anchor.current = el;
          setMenuOpen((o) => !o);
        }}
      />
      <ParentMenu
        anchor={anchor}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        tasks={snap?.tasks}
        taskId={taskId}
        current={parent?.id ?? null}
        canClear={parent?.via === "parent_link"}
        onPick={onPick}
      />
    </>
  );
}
