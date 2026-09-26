/**
 * Requests page — React port of static/requests.html (the inline script), over
 * the UNCHANGED backend. Same class names/DOM as the vanilla page so the shared
 * stylesheet applies identically; the page-scoped CSS below is the vanilla
 * page's own <style> block carried over verbatim (it never lived in styles.css).
 *
 * Parity notes:
 * - ?req= deep link (ISS-38) read from the hash-router search; selection also
 *   writes it back with history-replace, and the picked row is scroll-anchored
 *   one-shot so the 3s poll never yanks scroll.
 * - ISS-68 PR-3 render cap: top-N + "Load more"; the selected/deeplinked row is
 *   appended past the window so it stays reachable. Resets on filter switch.
 * - ISS-331 sort control (Time/Priority + direction, persisted per-surface)
 *   ported locally — status rank (open→answered→other) stays the outer key,
 *   superseding the ISS-83 recency-band float exactly as the vanilla page does.
 * - ISS-46/ISS-53: drafts (answer box, modal fields) live in useState, never
 *   re-derived from the snapshot, so polls can't clobber typing.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { sendJSON } from "../../api/client";
import { relTime, trunc } from "../../lib/format";
import { Avatar, Icon, Linkified, Modal, Pill, useToast } from "../../components/ui";
import { Shell } from "../../shell/Shell";
import {
  actingHuman,
  agentByAlias,
  isToHuman,
  taskById,
  useSnapshot,
} from "../../state/SnapshotProvider";
import type { Agent, OrchaRequest, Snapshot } from "../../types";
import { SortCtl, sortComparator } from "../../lib/sort";

/* ---- page-scoped CSS: the vanilla requests.html <style> block, verbatim --- */
const PAGE_CSS = `
  /* ISS-38: bound the list to the viewport so it scrolls independently of the detail —
     lets a deeplinked row scrollIntoView WITHOUT scrolling the page away from the request
     detail. Without this (303+ requests) the sticky aside grows taller than the screen. */
  .rlist-card { padding: 9px; max-height: calc(100vh - 92px); overflow-y: auto; }
  .rlist-card .rh { padding: 9px 9px 8px; font-size: 10.5px; font-weight: 650; letter-spacing: .07em;
    text-transform: uppercase; color: var(--faint); display: flex; align-items: center; gap: 7px; }
  .filters { display: flex; gap: 5px; padding: 0 6px 8px; flex-wrap: wrap; }
  .filters button { border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); font: inherit;
    font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 999px; cursor: pointer; transition: .12s; }
  .filters button:hover { color: var(--text); }
  .filters button.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-line); }
  .qrow { display: flex; flex-direction: column; gap: 7px; padding: 11px 11px; border-radius: 11px; cursor: pointer;
    border: 1px solid transparent; transition: background .12s, border-color .12s; width: 100%; text-align: left;
    background: transparent; font: inherit; color: inherit; }
  .qrow:hover { background: var(--hover); }
  .qrow.sel { background: var(--accent-soft); border-color: var(--accent-line); }
  .qrow .flow { display: flex; align-items: center; gap: 7px; font-weight: 620; font-size: 13px; }
  .qrow .pv { color: var(--muted); font-size: 11.5px; line-height: 1.4; }
  .qrow .bot { display: flex; align-items: center; gap: 7px; }
  .flowbig { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .flowbig .node { display: flex; align-items: center; gap: 8px; padding: 7px 12px 7px 8px; border: 1px solid var(--border);
    border-radius: 999px; background: var(--surface-2); font-weight: 650; font-size: 13.5px; text-decoration: none; }
  .flowbig .arrow svg { width: 22px; height: 22px; color: var(--faint); }
  .chain { display: flex; flex-direction: column; gap: 0; }
  .chain .clink { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border);
    border-radius: 11px; background: var(--surface-2); cursor: pointer; transition: border-color .12s; width: 100%; text-align: left; font: inherit; color: inherit; }
  .chain .clink:hover { border-color: var(--accent-line); }
  .chain .clink.cur { border-color: var(--accent-line); background: var(--accent-soft); }
  .chain .rail { width: 2px; height: 14px; background: var(--border); margin-left: 23px; }
  .chain .clink .cf { flex: 1; min-width: 0; font-size: 12.5px; }
  .chain .clink .cf .ttl { font-weight: 620; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chain .clink .cf .sub { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .payload { font-size: 14px; line-height: 1.6; color: var(--text); white-space: pre-wrap; }
  .answer { border-left: 2px solid var(--ok); padding: 4px 0 4px 13px; color: var(--text-2); font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; }
  .answer.rej { border-left-color: var(--danger); }
  .ans-in { width: 100%; min-height: 90px; resize: vertical; background: var(--surface-2); border: 1px solid var(--border);
    color: var(--text); border-radius: 10px; padding: 11px 13px; font: inherit; font-size: 13.5px; line-height: 1.55; outline: none; }
  .ans-in:focus { border-color: var(--accent-line); box-shadow: var(--ring); }
`;

const REQS_PAGE = 15; // ISS-68 PR-3 render-cap page size

const FILTERS = [
  { k: "all", label: "All" },
  { k: "open", label: "Open" },
  { k: "answered", label: "Answered" },
  { k: "escalated", label: "Escalations" },
  { k: "task", label: "Task reqs" },
] as const;

const partyLabel = (name: string) => (name === "human" ? "you" : name);
const prioNum = (p: OrchaRequest["priority"]) => Number(p);
const prioCls = (p: OrchaRequest["priority"]) => (prioNum(p) <= 20 ? "p-hi" : prioNum(p) <= 40 ? "p-md" : "");

/* ---- ISS-331 sort (shared lib/sort — same orcha:sort:requests key) -------- */
// ISS-83: requests carry no frontend sort — they arrive in backend order. The comparator
// mirrors the server _sort_clause: status rank (open→answered→other) stays the OUTER key.
const REQ_STATUS_RANK: Record<string, number> = { open: 0, answered: 1 };
const reqRank = (r: OrchaRequest) => REQ_STATUS_RANK[r.status] ?? 2;
const reqTime = (r: OrchaRequest) => Date.parse(r.created_at || "") || 0;

/* ---- small render helpers ------------------------------------------------ */
function TaskLink({ snap, id, label }: { snap: Snapshot | null; id: string; label?: string }) {
  const t = taskById(snap, id);
  return (
    <a className="dlink" href={"/tasks?task=" + encodeURIComponent(id)}>
      {label || (t ? t.title : id)}
    </a>
  );
}

function AgentNode({ snap, alias }: { snap: Snapshot | null; alias: string }) {
  const human = alias === "human";
  const a = agentByAlias(snap, alias);
  const inner = (
    <>
      <Avatar alias={alias} kind={human ? "human" : a ? a.kind : "ai"} size="sm" />
      {partyLabel(alias)}
    </>
  );
  // vanilla points the human node at "#" (a no-op); an href-less anchor is the
  // hash-router-safe equivalent (a literal "#" would navigate to the home route).
  return human ? (
    <a className="node" style={{ color: "inherit" }}>{inner}</a>
  ) : (
    <a className="node" style={{ color: "inherit" }} href={"/agents?agent=" + encodeURIComponent(alias)}>{inner}</a>
  );
}

/* ---- modal state --------------------------------------------------------- */
type ModalSt =
  | { kind: "escalate"; req: OrchaRequest }
  | { kind: "convert"; req: OrchaRequest; title: string; dod: string; assignee: string }
  | { kind: "close"; req: OrchaRequest; reason: string };

/* ========================================================================== */
export function RequestsPage() {
  const { snap, refresh } = useSnapshot();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();

  const dlReq = new URLSearchParams(location.search).get("req");
  const [sel, setSel] = useState<string | null>(dlReq);
  const [filter, setFilter] = useState<string>("all");
  const [reqsShown, setReqsShown] = useState(REQS_PAGE);
  const [answering, setAnswering] = useState(false); // inline answer box open (ISS-53)
  const [ansDraft, setAnsDraft] = useState("");
  const [modal, setModal] = useState<ModalSt | null>(null);
  const [, sortTick] = useState(0); // repaint when the shared SortCtl changes state
  // ISS-38: one-shot scroll anchor for a deeplinked/picked row — cleared after
  // the next list paint so the 3s poll never yanks scroll.
  const pendingScroll = useRef(!!dlReq);
  const listRef = useRef<HTMLElement | null>(null);

  // external ?req= changes (notification links, chain links from elsewhere)
  useEffect(() => {
    if (dlReq && dlReq !== sel) {
      setSel(dlReq);
      setAnswering(false);
      setAnsDraft("");
      pendingScroll.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlReq]);

  const reqs = useMemo(() => snap?.requests ?? [], [snap]);
  const toHuman = (r: OrchaRequest) => isToHuman(snap, r);
  const matches = (r: OrchaRequest) => {
    if (filter === "all") return true;
    if (filter === "escalated") return r.to === "human" || toHuman(r);
    if (filter === "task") return r.type === "task";
    if (filter === "answered") return r.status === "answered";
    if (filter === "open") return r.status === "open";
    return true;
  };

  // vanilla firstSel(): first open request, else the first in backend order
  const firstSel = (reqs.find((r) => r.status === "open") || reqs[0])?.id ?? null;
  const selEff = sel && reqs.some((r) => r.id === sel) ? sel : firstSel;

  const list = reqs.filter(matches).sort(sortComparator("requests", { bucket: reqRank, time: reqTime, prio: (r) => prioNum(r.priority) }));
  const head = list.slice(0, reqsShown);
  // ISS-38: the render cap is a UI window, not a filter — a deeplinked/selected
  // request beyond the window is appended past it so it stays reachable.
  const selBeyond = selEff && list.some((r) => r.id === selEff) && !head.some((r) => r.id === selEff)
    ? list.find((r) => r.id === selEff)
    : undefined;
  const shown = selBeyond ? head.concat(selBeyond) : head;
  const r = reqs.find((x) => x.id === selEff) || null;
  const openCount = reqs.filter((x) => x.status === "open").length;

  // ISS-38: anchor the deeplinked/selected row after the list paints (one-shot)
  useEffect(() => {
    if (!snap || !pendingScroll.current) return;
    pendingScroll.current = false;
    const row = listRef.current?.querySelector(".qrow.sel");
    if (row && typeof (row as HTMLElement).scrollIntoView === "function") {
      (row as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  });

  const select = (id: string) => {
    if (id === selEff) return;
    setSel(id);
    setAnswering(false);
    setAnsDraft("");
    pendingScroll.current = true; // ISS-38: keep the picked row anchored in view
    navigate("/requests?req=" + encodeURIComponent(id), { replace: true });
    window.scrollTo({ top: 0 }); // ISS-57 parity: land on the top of the swapped detail
  };

  /* ---- actions (real POSTs; acting-human gated like the vanilla page) ---- */
  const requireHuman = (): Agent | null => {
    const h = actingHuman(snap);
    if (!h) toast("Pick an acting human (top-right) first.", "danger");
    return h;
  };
  const failMsg = (e: unknown) => "Failed (" + ((e as { status?: number }).status ?? "?") + ")";

  const sendAnswer = async (req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    const v = ansDraft.trim();
    if (!v) return;
    try {
      await sendJSON("POST", "/api/requests/" + encodeURIComponent(req.id) + "/respond", {
        responder_agent_id: h.id,
        response: v,
      });
      toast("Answer sent to " + req.from, "ok");
      setAnsDraft("");
      setAnswering(false);
      void refresh();
    } catch (e) {
      toast(failMsg(e), "danger");
    }
  };

  const doEscalate = async (req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    setModal(null);
    try {
      await sendJSON("POST", "/api/requests/" + encodeURIComponent(req.id) + "/escalate", {
        requester_agent_id: h.id,
      });
      toast("Escalated to human", "ok");
      void refresh();
    } catch (e) {
      toast(failMsg(e), "danger");
    }
  };

  const doConvert = async (m: Extract<ModalSt, { kind: "convert" }>) => {
    const h = requireHuman();
    if (!h) return;
    const title = m.title.trim();
    const dod = m.dod.trim();
    if (!title || !dod) {
      toast("Title and definition of done are required.", "danger");
      return; // keep the modal open, like the vanilla validation
    }
    setModal(null);
    try {
      await sendJSON("POST", "/api/requests/" + encodeURIComponent(m.req.id) + "/convert-to-task", {
        requester_agent_id: h.id,
        title,
        definition_of_done: dod,
        assignee_alias: m.assignee,
      });
      toast("Task created from request", "ok");
      void refresh();
    } catch (e) {
      toast(failMsg(e), "danger");
    }
  };

  const doNudge = async (req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    try {
      const res = await sendJSON<{ nudged: boolean }>("POST", "/api/requests/" + encodeURIComponent(req.id) + "/nudge", {
        actor_agent_id: h.id,
      });
      // never changes request state — nudged:false is a clean no-op (no agent to wake).
      toast(res.nudged ? "Nudge sent" : "Nothing to wake — no agent owns the next action", res.nudged ? "ok" : "warn");
    } catch (e) {
      // 409 = not actionable in this state; sendJSON's Error.message already carries the
      // server's ": <detail>" suffix, so surface it verbatim instead of a generic failMsg.
      const st = (e as { status?: number }).status;
      if (st === 409) {
        const detail = (e as Error).message.split(": ").slice(1).join(": ");
        toast("Can't nudge — " + (detail || "not actionable in this state"), "danger");
      } else {
        toast(failMsg(e), "danger");
      }
    }
  };

  const doClose = async (m: Extract<ModalSt, { kind: "close" }>) => {
    const h = requireHuman();
    if (!h) return;
    const reason = m.reason.trim();
    setModal(null);
    try {
      await sendJSON("POST", "/api/requests/" + encodeURIComponent(m.req.id) + "/close", {
        requester_agent_id: h.id,
        reason: reason || undefined, // JSON.stringify drops undefined — same wire body as vanilla
      });
      toast("Request closed", "ok");
      void refresh();
    } catch (e) {
      const st = (e as { status?: number }).status;
      toast(
        st === 422 ? "A reason is required to close another agent's request." : "Failed (" + (st ?? "?") + ")",
        "danger",
      );
    }
  };

  const openAction = (act: string, req: OrchaRequest) => {
    const h = requireHuman();
    if (!h) return;
    if (act === "answer") { setAnswering(true); return; }
    if (act === "cancel-answer") { setAnsDraft(""); setAnswering(false); return; }
    if (act === "escalate") { setModal({ kind: "escalate", req }); return; }
    if (act === "convert") {
      const ai = (snap?.agents ?? []).filter((a) => a.kind === "ai");
      setModal({
        kind: "convert",
        req,
        title: "From request: " + trunc(String(req.payload ?? ""), 48),
        dod: "",
        assignee: ai[0]?.alias ?? "",
      });
      return;
    }
    if (act === "close") { setModal({ kind: "close", req, reason: "" }); return; }
  };

  /* ---- request chain ----------------------------------------------------- */
  const chainSeq = (cur: OrchaRequest): OrchaRequest[] => {
    const seq: OrchaRequest[] = [];
    const seen = new Set<string>([cur.id]);
    let node: OrchaRequest | undefined = cur;
    while (node && node.in_service_of) {
      const p = reqs.find((x) => x.id === node!.in_service_of);
      if (!p || seen.has(p.id)) break;
      seen.add(p.id);
      seq.unshift(p);
      node = p;
    }
    seq.push(cur);
    reqs.filter((x) => x.in_service_of === cur.id).forEach((c) => seq.push(c));
    return seq;
  };

  /* ---- actions block (vanilla actionsFor) -------------------------------- */
  const actionsFor = (req: OrchaRequest): ReactNode => {
    if (req.status === "closed" || req.status === "converted_to_task") {
      const tl = req.task_link && req.task_link.task_id;
      return (
        <div className="none" style={{ textAlign: "left", padding: "14px" }}>
          This request is {req.status.replace(/_/g, " ")}.{" "}
          {tl ? (<>Spawned <TaskLink snap={snap} id={tl} /></>) : "No further action."}
        </div>
      );
    }
    const h = actingHuman(snap);
    if (!h) {
      return (
        <div className="none" style={{ textAlign: "left", padding: "14px" }}>
          Pick an acting human (top-right) to arbitrate this request.
        </div>
      );
    }
    const isTarget = String(req.target_id) === String(h.id) || req.to === "human";
    const isRequester = String(req.requester_id) === String(h.id);
    return (
      <>
        <div className="wrap-g" id="reqacts" data-req={req.id}>
          {isTarget && req.status === "open" && (
            <button className="btn approve" onClick={() => openAction("answer", req)}>
              <Icon name="check" cls="" />Answer
            </button>
          )}
          {isRequester && req.status === "answered" && (
            <button className="btn subtle" onClick={() => openAction("convert", req)}>
              <Icon name="convert" cls="" />Convert to task
            </button>
          )}
          {isRequester && (req.status === "open" || req.status === "answered") && (
            <button className="btn subtle" onClick={() => openAction("escalate", req)}>
              <Icon name="flag" cls="" />Escalate to human
            </button>
          )}
          {(req.status === "open" || req.status === "answered") && (
            <button className="btn subtle" onClick={() => void doNudge(req)}>
              <Icon name="bell" cls="" />Nudge
            </button>
          )}
          <button className="btn ghost" onClick={() => openAction("close", req)}>Close</button>
        </div>
        <div className="acting-note" style={{ marginTop: "10px", color: "var(--muted)", fontSize: "11.5px" }}>
          <Avatar alias={h.alias} kind="human" size="sm" />
          {" "}Arbitrating as {h.alias} — answer (if it&#39;s yours), convert, escalate, or close. Every action is logged.
        </div>
        {answering && isTarget && req.status === "open" && (
          <div style={{ marginTop: "14px" }}>
            <textarea
              id="ansIn"
              className="ans-in"
              placeholder={`Type your answer — ${req.from} sees it verbatim on the next wake.`}
              value={ansDraft}
              onChange={(e) => setAnsDraft(e.target.value)}
              autoFocus
            />
            <div style={{ display: "flex", gap: "9px", marginTop: "10px" }}>
              <button className="btn approve" onClick={() => void sendAnswer(req)}>
                <Icon name="check" cls="" />Send answer
              </button>
              <button className="btn subtle" onClick={() => openAction("cancel-answer", req)}>Cancel</button>
            </div>
          </div>
        )}
      </>
    );
  };

  /* ---- render ------------------------------------------------------------ */
  if (!snap || !snap.container) {
    return (
      <Shell page="requests" title="Requests">
        <style>{PAGE_CSS}</style>
      </Shell>
    );
  }

  const escd = r ? toHuman(r) && r.status === "open" : false;
  const seq = r ? chainSeq(r) : [];
  const aiAgents = snap.agents.filter((a) => a.kind === "ai");

  return (
    <Shell page="requests" title="Requests" ctx={reqs.length + " requests · " + (snap.container.name ?? "")}>
      <style>{PAGE_CSS}</style>
      <div className="split wide">
        <aside className="card rlist-card stick" id="rlist" ref={listRef}>
          <div className="rh">
            <Icon name="requests" cls="" />
            Requests · {openCount} open
            <span className="grow" style={{ flex: 1 }} />
            <SortCtl name="requests" onChange={() => sortTick((n) => n + 1)} />
          </div>
          <div className="filters">
            {FILTERS.map((f) => (
              <button
                key={f.k}
                className={f.k === filter ? "on" : ""}
                onClick={() => { setFilter(f.k); setReqsShown(REQS_PAGE); }}
              >
                {f.label}
              </button>
            ))}
          </div>
          {shown.length ? (
            shown.map((x) => {
              const xEsc = toHuman(x) && x.status === "open";
              const fa = agentByAlias(snap, x.from);
              const ta = agentByAlias(snap, x.to);
              return (
                <button key={x.id} className={"qrow" + (x.id === selEff ? " sel" : "")} onClick={() => select(x.id)}>
                  <span className="flow">
                    <Avatar alias={x.from} kind={fa ? fa.kind : "ai"} size="sm" />
                    <span>{x.from}</span>
                    <span className="faint"><Icon name="arrow" cls="" /></span>
                    <Avatar alias={x.to} kind={x.to === "human" ? "human" : ta ? ta.kind : "ai"} size="sm" />
                    <span>{partyLabel(x.to)}</span>
                  </span>
                  <span className="pv">{trunc(String(x.payload ?? ""), 84)}</span>
                  <span className="bot">
                    <Pill status={xEsc ? "escalated" : x.status} />
                    <span className="tag">{x.type}</span>
                    {x.chain_depth ? <span className="tag" style={{ color: "var(--info)" }}>↳ chain</span> : null}
                    <span className={"prio" + (prioCls(x.priority) ? " " + prioCls(x.priority) : "")} style={{ marginLeft: "auto" }}>
                      P{x.priority}
                    </span>
                  </span>
                </button>
              );
            })
          ) : (
            <div className="none" style={{ margin: "6px" }}>No requests match this filter.</div>
          )}
          {list.length > head.length && ( // count the window (head), not the appended deeplink row
            <button
              className="btn subtle"
              style={{ width: "calc(100% - 12px)", margin: "8px 6px 4px" }}
              onClick={() => setReqsShown((n) => n + REQS_PAGE)}
            >
              Load more · {head.length} of {list.length}
            </button>
          )}
        </aside>

        <main id="detailMain">
          {!r ? (
            <div className="card pad"><div className="none">Request not found.</div></div>
          ) : (
            <>
              <div className="card pad" style={{ marginBottom: "18px" }}>
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
                  <div className="flowbig">
                    <AgentNode snap={snap} alias={r.from} />
                    <span className="arrow"><Icon name="arrow" cls="" /></span>
                    <AgentNode snap={snap} alias={r.to} />
                  </div>
                  <Pill status={escd ? "escalated" : r.status} size="lg" />
                </div>
                <div className="row" style={{ gap: "10px", marginTop: "14px", flexWrap: "wrap" }}>
                  <span className="tag">{r.type} request</span>
                  <span className={"prio" + (prioCls(r.priority) ? " " + prioCls(r.priority) : "")}>Priority {r.priority}</span>
                  <span className="muted" style={{ fontSize: "12.5px" }}>· opened {r.created_at ? relTime(r.created_at) : "—"}</span>
                  {r.task_link && r.task_link.task_id ? (
                    <>
                      <span className="muted" style={{ fontSize: "12.5px" }}>· in service of</span>{" "}
                      <TaskLink snap={snap} id={r.task_link.task_id} />
                    </>
                  ) : null}
                  {escd && (
                    <span className="tag" style={{ color: "var(--danger)", marginLeft: "auto" }}>
                      <Icon name="flag" cls="" />escalated to you
                    </span>
                  )}
                </div>
              </div>

              {seq.length >= 2 && (
                <div className="field" style={{ marginBottom: "18px" }}>
                  <div className="lbl"><Icon name="link" cls="" />Request chain · in service of</div>
                  <div className="chain">
                    {seq.map((x, i) => (
                      <div key={x.id}>
                        <button className={"clink" + (x.id === r.id ? " cur" : "")} onClick={() => select(x.id)}>
                          <Pill status={toHuman(x) && x.status === "open" ? "escalated" : x.status} />
                          <span className="cf">
                            <span className="ttl">{x.from} → {partyLabel(x.to)}</span>
                            <span className="sub">{trunc(String(x.payload ?? ""), 70)}</span>
                          </span>
                          {x.chain_depth ? (
                            <span className="tag" style={{ color: "var(--info)" }}>depth {x.chain_depth}</span>
                          ) : (
                            <span className="tag">root</span>
                          )}
                        </button>
                        {i < seq.length - 1 && <div className="rail" />}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="card pad" style={{ marginBottom: "18px" }}>
                <div className="field" style={{ marginBottom: "18px" }}>
                  <div className="lbl"><Icon name="dot" cls="" />Payload</div>
                  <div className="payload"><Linkified text={r.payload} tasks={snap.tasks} /></div>
                </div>
                {r.response != null && r.response !== "" ? (
                  <div className="field" style={{ marginBottom: "18px" }}>
                    <div className="lbl" style={{ color: "var(--ok)" }}>
                      <Icon name="check" cls="" />Answer · from {partyLabel(r.to)}
                    </div>
                    <div className="answer"><Linkified text={r.response} tasks={snap.tasks} /></div>
                  </div>
                ) : null}
                {r.rejection_reason ? (
                  <div className="field" style={{ marginBottom: "18px" }}>
                    <div className="lbl" style={{ color: "var(--danger)" }}>
                      <Icon name="x" cls="" />Rejected — reason
                    </div>
                    <div className="answer rej"><Linkified text={r.rejection_reason} tasks={snap.tasks} /></div>
                  </div>
                ) : null}
                <div className="field">
                  <div className="lbl"><Icon name="shield" cls="" />Your move</div>
                  {actionsFor(r)}
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {modal?.kind === "escalate" && (
        <Modal
          title="Escalate to a human?"
          desc="Re-targets this request to the human authority. Only the requester can escalate."
          primary="Escalate"
          onPrimary={() => void doEscalate(modal.req)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "convert" && (
        <Modal
          title="Convert to a task"
          desc="Spawn a tracked task from this answered request — assigned, with a definition of done."
          primary="Create task"
          approve
          onPrimary={() => void doConvert(modal)}
          onClose={() => setModal(null)}
        >
          <div className="field" style={{ marginBottom: "12px" }}>
            <div className="lbl">Title</div>
            <input
              className="ans-in"
              style={{ minHeight: 0 }}
              value={modal.title}
              onChange={(e) => setModal({ ...modal, title: e.target.value })}
            />
          </div>
          <div className="field" style={{ marginBottom: "12px" }}>
            <div className="lbl">Definition of done</div>
            <textarea
              className="ans-in"
              style={{ minHeight: "60px" }}
              placeholder="When is this task done?"
              value={modal.dod}
              onChange={(e) => setModal({ ...modal, dod: e.target.value })}
            />
          </div>
          <div className="field">
            <div className="lbl">Assign to</div>
            <select
              className="ans-in"
              style={{ minHeight: 0 }}
              value={modal.assignee}
              onChange={(e) => setModal({ ...modal, assignee: e.target.value })}
            >
              {aiAgents.map((a) => (
                <option key={a.id}>{a.alias}</option>
              ))}
            </select>
          </div>
        </Modal>
      )}
      {modal?.kind === "close" && (
        <Modal
          title="Close this request?"
          desc={"Marks it resolved. " + modal.req.from + " sees it closed on the next sync. A reason is required if it isn't yours."}
          primary="Close request"
          danger
          onPrimary={() => void doClose(modal)}
          onClose={() => setModal(null)}
        >
          <textarea
            className="ans-in"
            style={{ minHeight: "64px" }}
            placeholder="Reason (required when closing someone else's request)…"
            value={modal.reason}
            onChange={(e) => setModal({ ...modal, reason: e.target.value })}
          />
        </Modal>
      )}
    </Shell>
  );
}
