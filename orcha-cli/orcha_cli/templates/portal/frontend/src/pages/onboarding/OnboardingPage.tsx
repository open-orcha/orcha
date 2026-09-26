/**
 * Orcha — O1+O2+O3 first-run onboarding, React port of static/onboarding.js.
 * A guided state machine on the dashboard shell:
 *   welcome → fork → create-agent | create-tasks → agent-created
 * plus the #293 Path G propose lane: propose-goal → propose-stream → propose-roster.
 *
 * The backend is UNCHANGED — every endpoint/method/body is copied from the
 * vanilla page. Local flow state persists under the SAME localStorage key
 * ("orcha:onboarding") on the same events, so a draft started in the classic
 * page resumes here and vice versa. The server snapshot (SnapshotProvider) is
 * the source of truth for operator/agents/tasks.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { getJSON } from "../../api/client";
import { Avatar, Icon, KindBadge, OrcaMark, Pill, useToast } from "../../components/ui";
import { trunc } from "../../lib/format";
import { Shell } from "../../shell/Shell";
import { actingHuman, setActingHuman, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Snapshot, Task } from "../../types";
import {
  CONCIERGE_TEMPLATE, ERR_COPY, RAIL,
  loadState, normalizeRoster, postJSON, railKeyFor, reconcileDemoFlag, reconcileGhost,
  resumeStep, rosterToWalk, saveState, startPropose, walkAgentToDraft,
  type AgentDraft, type ClarifyQuestion, type OnbState, type ProposeError, type QueuedTask,
} from "./logic";
import { PAGE_CSS } from "./pageCss";

interface ModelInfo { id: string; name?: string }

/* Everything a step needs, passed down so the step components can live at
 * module level (inline component definitions would remount on every render
 * and clobber input focus). */
interface Flow {
  S: OnbState;
  update: (fn: (s: OnbState) => void) => void;
  go: (step: string) => void;
  refreshAnd: (step: string) => Promise<void>;
  toast: (msg: string, kind?: string) => void;
  cid: string | null;
  snap: Snapshot | null;
  models: ModelInfo[];
  defaultModel: string | null;
  op: Agent | null; // the registered operator (human), if any
  first: boolean; // "first agent" = zero AI agents in the snapshot
  readyTasks: Task[]; // ready + unassigned, live from the snapshot
}

export function OnboardingPage() {
  const { snap, cid, refresh } = useSnapshot();
  const toast = useToast() as unknown as (msg: string, kind?: string) => void;
  const location = useLocation();
  const [S, setS] = useState<OnbState>(loadState);
  const [booted, setBooted] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);

  // Mutable mirror so sequential update() calls in one handler read their own
  // writes (the vanilla code mutated a single S object + save()).
  const SRef = useRef(S);
  SRef.current = S;

  const update = useCallback((fn: (s: OnbState) => void) => {
    const next = JSON.parse(JSON.stringify(SRef.current)) as OnbState;
    fn(next);
    saveState(next); // persist on the same events the vanilla page saves
    SRef.current = next;
    setS(next);
  }, []);

  // scroll-to-top belongs to an explicit STEP CHANGE, not to render() itself —
  // a re-render of the current step never jumps the page (vanilla bug 3). A live
  // propose SSE stream is aborted on navigation via StepProposeStream's effect
  // cleanup (the step unmounts when the step changes).
  const go = useCallback((step: string) => {
    update((s) => { s.step = step; });
    window.scrollTo({ top: 0 });
  }, [update]);

  // After a WRITE, pull a fresh snapshot BEFORE rendering the next
  // snapshot-derived step (review P2 — no 3s rebuild loop to lean on).
  const refreshAnd = useCallback(async (step: string) => {
    try { await refresh(); } catch { /* step renders defensively */ }
    go(step);
  }, [refresh, go]);

  /* ---- boot ONCE on the first snapshot (vanilla boot()) ------------------ */
  useEffect(() => {
    if (booted || !snap) return;
    // query params live in the hash route (/onboarding?new=1) or the real URL.
    const qp = (k: string): string | null => {
      const h = new URLSearchParams(location.search).get(k);
      return h != null ? h : new URLSearchParams(window.location.search).get(k);
    };
    const agents = snap.agents || [];
    const hasOp = agents.some((a) => a.kind === "human");
    update((s) => {
      // Reconcile against server truth FIRST (#140 ghost reconcile).
      const rec = reconcileGhost(s, agents.map((a) => a.alias));
      s.step = rec.step;
      s.lastAgentAlias = rec.lastAgentAlias;
      // DEV-ONLY ?demo=1 — reconciled from the live URL every boot (never sticky).
      reconcileDemoFlag(s, qp("demo") === "1");
      // "+ New agent" deep-link (?new=1 or ?step=create-agent).
      if ((qp("new") === "1" || qp("step") === "create-agent") && hasOp) s.step = "create-agent";
      else s.step = resumeStep(s.step, hasOp); // skip welcome if a human exists
    });
    setBooted(true);
  }, [snap, booted, update, location.search]);

  /* ---- resolve models once on boot (GET /api/models, vanilla init()) ----- */
  useEffect(() => {
    getJSON<{ models?: ModelInfo[]; default?: string }>("/api/models").then((d) => {
      if (d && Array.isArray(d.models)) {
        setModels(d.models);
        const dm = d.default || (d.models[0] && d.models[0].id) || null;
        setDefaultModel(dm);
        if (SRef.current._agentDraft && SRef.current._agentDraft.model == null) {
          update((s) => { if (s._agentDraft && s._agentDraft.model == null) s._agentDraft.model = dm; });
        }
      }
    }).catch(() => { /* model picker stays in "Loading models…" */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agents = snap?.agents ?? [];
  const op = agents.find((a) => a.kind === "human") || null;
  const first = agents.filter((a) => a.kind !== "human").length === 0;
  const readyTasks = (snap?.tasks ?? []).filter((t) => t.status === "ready" && !(t.assignees || []).length);

  const flow: Flow = { S, update, go, refreshAnd, toast, cid, snap, models, defaultModel, op, first, readyTasks };

  return (
    <Shell page="home" title="Set up your workspace" ctx="First-run onboarding">
      <style>{PAGE_CSS}</style>
      {booted && (
        <>
          {S.step !== "welcome" && <GuideRail step={S.step} />}
          <div id="obMain"><StepView f={flow} /></div>
        </>
      )}
    </Shell>
  );
}

function StepView({ f }: { f: Flow }) {
  switch (f.S.step) {
    case "fork": return <StepFork f={f} />;
    case "create-agent": return <StepCreateAgent f={f} />;
    case "agent-created": return <StepAgentCreated f={f} />;
    case "create-tasks": return <StepCreateTasks f={f} />;
    case "propose-goal": return <StepProposeGoal f={f} />;
    case "propose-stream": return <StepProposeStream f={f} />;
    case "propose-roster": return <StepProposeRoster f={f} />;
    case "welcome":
    default: return <StepWelcome f={f} />;
  }
}

/* ---- guided banner under the topbar -------------------------------------- */
function GuideRail({ step }: { step: string }) {
  const curKey = railKeyFor(step);
  const idx = RAIL.findIndex((r) => r.key === curKey);
  return (
    <div className="guide-rail">
      <div className="steps">
        {RAIL.map((r, i) => (
          <Fragment key={r.key}>
            {i ? <span className="sep" /> : null}
            <span className={"st " + (i < idx ? "done" : i === idx ? "cur" : "")}>
              <span className="n">{i < idx ? <Icon name="check" cls="" /> : r.n}</span>{r.label}
            </span>
          </Fragment>
        ))}
      </div>
      <a className="skip" href="/">Skip to dashboard <Icon name="arrow" cls="" /></a>
    </div>
  );
}

/* ---- model picker (vanilla modelCards) ------------------------------------ */
function ModelCards({ models, selected, onPick }: { models: ModelInfo[]; selected: string | null; onPick: (id: string) => void }) {
  if (!models.length) return <div className="none" style={{ padding: 14 }}>Loading models…</div>;
  return (
    <>
      {models.map((m) => (
        <button type="button" key={m.id} className={"m" + (m.id === selected ? " on" : "")} data-model={m.id} onClick={() => onPick(m.id)}>
          <Icon name="check" cls="tick" />
          <div className="mn">{m.name || m.id}</div>
        </button>
      ))}
    </>
  );
}

/* ---- 1 · WELCOME → register the operator (human) -------------------------- */
function StepWelcome({ f }: { f: Flow }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const inpRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const t = setTimeout(() => inpRef.current && inpRef.current.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const submit = async () => {
    const v = (name || "").trim();
    if (!v) { inpRef.current?.focus(); setErr(true); return; }
    if (!f.cid) { f.toast("No workspace found yet — try again in a moment.", "danger"); return; }
    // O1: don't double-register — if an operator already exists, skip to the fork.
    if (f.op) { f.toast("Operator already registered.", "ok"); f.go("fork"); return; }
    setBusy(true);
    const res = await postJSON<{ agent_id?: string }>(
      "/api/containers/" + encodeURIComponent(f.cid) + "/agents",
      { alias: v, role: "Operator", kind: "human" },
    );
    setBusy(false);
    if (!res.ok) { f.toast("Couldn't register you (" + res.status + ")", "danger"); return; }
    // adopt as the acting human so the rest of the portal knows who you are
    try { if (res.body && res.body.agent_id) setActingHuman(f.snap, res.body.agent_id); } catch { /* private mode */ }
    f.toast("Welcome, " + v + " — you're the operator", "ok");
    await f.refreshAnd("fork"); // snapshot now has the operator (fork/resume reads it)
  };

  return (
    <div className="ob welcome">
      <div className="bigmark"><OrcaMark /></div>
      <div className="eyebrow">Orcha · orchestration portal</div>
      <h1>Run a team of agents,<br />with you in command.</h1>
      <p className="lede">Orcha is a human-authoritative, multi-agent workspace. Agents do the work and stream it to you live — but nothing ships on their say-so. You approve plans, verify results, and unblock. Let's set up your workspace.</p>

      <div className="whatis">
        <div className="w"><div className="ic"><Icon name="person" cls="" /></div><h4>You hold authority</h4><p>Agents stop at <i>needs&nbsp;verification</i>. You approve, verify, and decide — always.</p></div>
        <div className="w"><div className="ic"><Icon name="live" cls="" /></div><h4>Episodic agents</h4><p>Each agent wakes as a fresh worker, rehydrates from memory, and streams its work.</p></div>
        <div className="w"><div className="ic"><Icon name="shield" cls="" /></div><h4>Async gates</h4><p>No frantic allow-prompts. Govern through deliberate approve / verify decisions.</p></div>
      </div>

      <div className="namecard">
        <div className="nh"><span className="badge"><Icon name="person" cls="" /></span><h3>Claim the human authority</h3></div>
        <p className="sub">What should we call you? This registers you as the operator — the standing human authority for everything that happens in this workspace.</p>
        <div className="nrow">
          <input
            className="ipt lg" id="opName" ref={inpRef} value={name}
            placeholder="Your name — e.g. Dario" autoComplete="off" spellCheck={false} maxLength={40}
            style={err ? { borderColor: "var(--danger-line)" } : undefined}
            onChange={(e) => { setName(e.target.value); setErr(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
          <button className="btn" id="opGo" style={{ padding: "0 18px" }} disabled={busy} onClick={() => void submit()}><Icon name="arrow" cls="" />Enter</button>
        </div>
        <div className="auth-note"><Icon name="shield" cls="" /><span>You can hand specific tasks to AI agents later — authority stays with you.</span></div>
      </div>
    </div>
  );
}

/* ---- 2 · THE FORK ---------------------------------------------------------- */
function StepFork({ f }: { f: Flow }) {
  return (
    <>
      <div className="ob wide greet">
        <h1>Welcome{f.op && <>, <span className="nm">{f.op.alias}</span></>}. Your workspace is empty — let's change that.</h1>
        <p>Two ways in. Both lead to the same place: a workspace with <b>agents</b> doing <b>tasks</b> under your authority. Pick whichever matches how you think.</p>
      </div>
      <div className="ob wide">
        <div className="gpath">
          <div className="gp-icon"><Icon name="spark" cls="" /></div>
          <div className="gp-body">
            <div className="step">Path G · Recommended</div>
            <h3>Help me set this up</h3>
            <p>Describe your project in a sentence. An AI proposes a starting roster — agents with system prompts and their first tasks — that you review, edit, and create. You stay in command; nothing exists until you approve it.</p>
          </div>
          <button className="btn" data-go="propose-goal" onClick={() => f.go("propose-goal")}><Icon name="spark" cls="" />Propose my roster <Icon name="arrow" cls="" /></button>
        </div>
        <div className="forkmanual"><span></span>or set it up by hand<span></span></div>
        <div className="fork">
          <div className="onramp agent">
            <div className="top"><span className="oic"><Icon name="agents" cls="" /></span><div><div className="step">Path A</div><h3>Create your first agent</h3></div></div>
            <p>Stand up an AI teammate — give it a role, a model, and a system prompt. Best first move: create a <b>concierge</b> agent and brainstorm the whole plan with it.</p>
            <span className="recommend"><Icon name="spark" cls="" />Recommended for a blank slate</span>
            <button className="btn" data-go="create-agent" onClick={() => f.go("create-agent")}><Icon name="plus" cls="" />Create an agent</button>
          </div>
          <div className="onramp task">
            <div className="top"><span className="oic"><Icon name="tasks" cls="" /></span><div><div className="step">Path B</div><h3>Add tasks first</h3></div></div>
            <p>Already know the work? Capture it as tasks — each with a clear definition of done — then create the agents to carry them out.</p>
            <span className="recommend" style={{ color: "var(--violet)", background: "var(--violet-soft)", borderColor: "var(--violet-line)" }}><Icon name="tasks" cls="" />Good if the plan is clear</span>
            <button className="btn subtle" data-go="create-tasks" onClick={() => f.go("create-tasks")}><Icon name="plus" cls="" />Add tasks</button>
          </div>
        </div>
        <div className="merge"><Icon name="convert" cls="" /><span>Either way you'll end up with <b>agents&nbsp;+&nbsp;tasks</b>. Once an agent exists you give it work from its page.</span></div>
      </div>
    </>
  );
}

/* ---- 3a · CREATE AGENT ----------------------------------------------------- */
function StepCreateAgent({ f }: { f: Flow }) {
  const draft = f.S._agentDraft;
  const [busy, setBusy] = useState(false);
  const fRef = useRef(f);
  fRef.current = f;

  // restore an in-progress draft, else seed (concierge template for the first
  // agent) — vanilla seeds + saves on step render.
  useEffect(() => {
    const cur = fRef.current;
    if (!cur.S._agentDraft) {
      cur.update((s) => {
        s._agentDraft = {
          alias: cur.first ? "Atlas" : "",
          role: cur.first ? "Concierge · planning & orchestration" : "",
          prompt: cur.first ? CONCIERGE_TEMPLATE : "",
          model: cur.defaultModel,
          _firstMode: cur.readyTasks.length ? "pick" : "none",
          _pickId: null, _desc: "",
        };
      });
    } else if (cur.S._agentDraft.model == null && cur.defaultModel != null) {
      cur.update((s) => { if (s._agentDraft && s._agentDraft.model == null) s._agentDraft.model = cur.defaultModel; });
    }
  }, [draft, f.defaultModel]);
  if (!draft) return null;

  const setDraft = (fn: (d: AgentDraft) => void) => f.update((s) => { if (s._agentDraft) fn(s._agentDraft); });

  const submitAgent = async () => {
    if (!f.cid) { f.toast("No workspace found yet.", "danger"); return; }
    const alias = (draft.alias || "").trim();
    const role = (draft.role || "").trim();
    const prompt = (draft.prompt || "").trim();
    if (!alias || !role || !prompt) { f.toast("Name, role, and system prompt are required", "bad"); return; }

    // O2: optional initial_task — an existing ready task picked, or a described one.
    let initial_task: { title: string; definition_of_done: string } | null = null;
    const rts = f.readyTasks;
    const picked = draft._firstMode === "pick" && draft._pickId ? rts.find((x) => x.id === draft._pickId) : null;
    if (picked) {
      initial_task = { title: picked.title, definition_of_done: picked.definition_of_done || "Complete: " + picked.title };
    } else if (draft._firstMode === "describe" && (draft._desc || "").trim()) {
      const d = draft._desc.trim();
      // honor a proposal-supplied title (walk) so a roster kickoff keeps its name;
      // manual describe leaves _taskTitle unset → falls back to the truncated dod.
      initial_task = { title: (draft._taskTitle || "").trim() || trunc(d, 60), definition_of_done: d };
    }

    const body: Record<string, unknown> = { alias, role, kind: "ai", prompt, model: draft.model || undefined };
    if (initial_task) body.initial_task = initial_task;

    setBusy(true);
    const res = await postJSON("/api/containers/" + encodeURIComponent(f.cid) + "/agents", body);
    setBusy(false);
    if (!res.ok) { f.toast("Create failed (" + res.status + ")", "danger"); return; }

    f.update((s) => {
      s.lastAgentAlias = alias;
      s._agentDraft = null;
      if (s._walk) s._walk.idx += 1; // advance the roster walk past the agent just created
    });
    f.toast(alias + " created", "ok");
    await f.refreshAnd("agent-created"); // snapshot now has the new agent
  };

  // During an AI-roster walk (Path G), the form is pre-seeded per proposed agent.
  const walk = f.S._walk;
  const first = f.first;

  let ftBody: ReactNode;
  if (draft._firstMode === "pick") {
    // the ready list is LIVE from the snapshot (reflects tasks created earlier in
    // this flow); selection is by task ID, not a positional index (review #4).
    const rtsLive = f.readyTasks;
    ftBody = rtsLive.length ? (
      <div className="picklist">
        {rtsLive.map((t) => (
          <div key={t.id} className={"pl" + (draft._pickId === t.id ? " on" : "")} data-pickid={t.id} onClick={() => setDraft((d) => { d._pickId = t.id; })}>
            <span className="rad" /><div className="grow"><div className="t1">{t.title}</div><div className="t2">{trunc(t.definition_of_done || "", 70)}</div></div>
          </div>
        ))}
      </div>
    ) : (
      <div className="none" style={{ padding: 16 }}>No ready unassigned tasks. Switch to <b>Describe a task</b>, or leave it for now.</div>
    );
  } else if (draft._firstMode === "describe") {
    ftBody = (
      <>
        <textarea
          className="txa" id="ftDesc" rows={3} value={draft._desc}
          placeholder={'Describe the first task in plain language — e.g. "Stand up the schema_migrations runner so we can ship migrations without wiping the volume."'}
          onChange={(e) => setDraft((d) => { d._desc = e.target.value; })}
        />
        <div className="hint">Becomes an initial_task with a title + a definition of done assigned to this agent on creation.</div>
      </>
    );
  } else {
    ftBody = <div className="none" style={{ padding: 16 }}>No first task — you'll brainstorm with this agent and create tasks together.</div>;
  }

  return (
    <div className="ob">
      {walk && <div className="walkbar"><Icon name="spark" cls="" /><span>Agent <b>{walk.idx + 1}</b> of <b>{walk.agents.length}</b> from your proposed roster — edit anything, then create.</span></div>}
      <div className="form-h">
        <span className="fic"><Icon name="agents" cls="" /></span>
        <div>
          <h2>{walk ? <>Review &amp; create {draft.alias || "this agent"}</> : first ? "Create your first agent" : "Create an agent"}</h2>
          <p>{walk ? "Pre-filled from your proposed roster. Edit anything before you create — nothing is committed until you click Create." : first ? "We've pre-filled a concierge agent — an AI teammate you can brainstorm the workspace plan with. Edit anything; it's yours." : "Define the teammate: who they are, how they think, and what they'll pick up first."}</p>
        </div>
      </div>
      <div className="card pad">
        <div className="field2">
          <div className="lab">Agent name <span className="req">*</span></div>
          <input className="ipt" id="agName" value={draft.alias} placeholder="e.g. Atlas, Forge, Vault" autoComplete="off" spellCheck={false} onChange={(e) => setDraft((d) => { d.alias = e.target.value; })} />
          <div className="hint">A short, memorable alias. This is how the agent appears everywhere in the portal.</div>
        </div>
        <div className="field2">
          <div className="lab">Role <span className="req">*</span></div>
          <input className="ipt" id="agRole" value={draft.role} placeholder="e.g. Concierge · planning & orchestration" autoComplete="off" onChange={(e) => setDraft((d) => { d.role = e.target.value; })} />
        </div>
        <div className="field2">
          <div className="lab">
            <span>System prompt</span><span className="req">*</span><span className="grow"></span>
            {first && (
              <span className="refine" id="agTemplate" onClick={() => { setDraft((d) => { d.prompt = CONCIERGE_TEMPLATE; }); f.toast("Concierge template applied — edit freely", "ok"); }}>
                <Icon name="spark" cls="" />Use the concierge template
              </span>
            )}
          </div>
          <textarea className="txa mono" id="agPrompt" rows={9} value={draft.prompt} placeholder="Describe the agent's persona, how it should behave, and its boundaries…" onChange={(e) => setDraft((d) => { d.prompt = e.target.value; })} />
          <div className="hint">This is the agent's standing persona — rehydrated on every wake. You can keep refining it later from the agent's page.</div>
        </div>
        <div className="field2">
          <div className="lab">Model <span className="req">*</span></div>
          <div className="models" id="agModels"><ModelCards models={f.models} selected={draft.model} onPick={(id) => setDraft((d) => { d.model = id; })} /></div>
        </div>
        <div className="field2" style={{ marginBottom: 6 }}>
          <div className="lab"><span>First task</span><span className="opt">optional</span></div>
          <div className="hint" style={{ marginTop: 0, marginBottom: 9 }}>Give the agent something to pick up — choose an existing ready task or describe one. You can also leave this empty and just brainstorm.</div>
          <div className="firsttask">
            <div className="ftmode" id="ftMode">
              <button data-mode="pick" className={draft._firstMode === "pick" ? "on" : ""} onClick={() => setDraft((d) => { d._firstMode = "pick"; })}><Icon name="tasks" cls="" />Pick existing task</button>
              <button data-mode="describe" className={draft._firstMode === "describe" ? "on" : ""} onClick={() => setDraft((d) => { d._firstMode = "describe"; })}><Icon name="plus" cls="" />Describe a task</button>
              <button data-mode="none" className={draft._firstMode === "none" ? "on" : ""} onClick={() => setDraft((d) => { d._firstMode = "none"; })}><Icon name="clock" cls="" />Not yet</button>
            </div>
            <div className="ftbody" id="ftBody">{ftBody}</div>
          </div>
        </div>
      </div>
      <div className="form-actions">
        <button className="btn ghost" data-go="fork" onClick={() => f.go("fork")}>Back</button>
        <span className="grow"></span>
        <span className="note">You're the authority — creating an agent doesn't wake it.</span>
        <button className="btn" id="agCreate" disabled={busy} onClick={() => void submitAgent()}><Icon name="check" cls="" />Create {first ? "agent" : ""}</button>
      </div>
    </div>
  );
}

/* ---- 3a · AGENT CREATED ----------------------------------------------------- */
function StepAgentCreated({ f }: { f: Flow }) {
  const alias = f.S.lastAgentAlias;
  const a = alias ? (f.snap?.agents ?? []).find((x) => x.alias === alias) || null : null;
  const fRef = useRef(f);
  fRef.current = f;

  // Defensive ghost guard (#140): if the celebrated agent vanished from server
  // truth (e.g. retired in another tab), drop the stale reference and fall back
  // to the fork instead of a phantom "is ready" card.
  const missing = !alias || !a;
  useEffect(() => {
    if (!missing) return;
    const cur = fRef.current;
    if (!cur.S.lastAgentAlias) { cur.go("fork"); return; }
    cur.update((s) => { s.lastAgentAlias = null; });
    cur.go("fork");
  }, [missing]);
  if (!alias || !a) return null;

  const role = a.role;
  const model = a.model || "—";

  // Path G roster walk: after each agent, drive the operator to the NEXT proposed
  // agent (re-using this same success → create-agent loop), then to the queued tasks.
  const walk = f.S._walk;
  const nextAgent = walk && walk.idx < walk.agents.length ? walk.agents[walk.idx] : null;
  const standaloneLeft = walk && walk.standalone ? walk.standalone.length : 0;

  // walk: seed the NEXT proposed agent into the existing create-agent form.
  const wnNext = () => {
    if (!nextAgent) return;
    f.update((s) => { s._agentDraft = walkAgentToDraft(nextAgent, f.defaultModel); });
    f.go("create-agent");
  };
  // walk: push the proposed standalone tasks into the queue, hand off to the
  // existing create-tasks POST loop, and end the walk.
  const wnTasks = () => {
    f.update((s) => {
      const w = s._walk;
      if (!w) return;
      const have = new Set(s.tasks.map((t) => t.title + "\n" + t.dod));
      w.standalone.forEach((t) => {
        const k = t.title + "\n" + t.dod;
        if (!have.has(k)) { s.tasks.push({ title: t.title, dod: t.dod }); have.add(k); }
      });
      s._walk = null;
    });
    f.go("create-tasks");
  };

  let walkBlock: ReactNode = null;
  if (walk && nextAgent) {
    walkBlock = (
      <div className="walknext">
        <div className="wn-prog"><Icon name="spark" cls="" /><span>{walk.idx} of {walk.agents.length} agents created — keep going through your roster.</span></div>
        <button className="btn" id="wnNext" onClick={wnNext}><Icon name="agents" cls="" />Next: create {nextAgent.name} <Icon name="arrow" cls="" /></button>
      </div>
    );
  } else if (walk && standaloneLeft) {
    walkBlock = (
      <div className="walknext">
        <div className="wn-prog"><Icon name="check" cls="" /><span>All {walk.agents.length} proposed agents created. {standaloneLeft} proposed task{standaloneLeft === 1 ? "" : "s"} left to add.</span></div>
        <button className="btn" id="wnTasks" onClick={wnTasks}><Icon name="tasks" cls="" />Add your {standaloneLeft} proposed task{standaloneLeft === 1 ? "" : "s"} <Icon name="arrow" cls="" /></button>
      </div>
    );
  } else if (walk) {
    walkBlock = (
      <div className="walknext done">
        <div className="wn-prog"><Icon name="check" cls="" /><span>Your proposed roster is live — agents created and tasks queued. You're set up.</span></div>
        <a className="btn" href="/"><Icon name="home" cls="" />Go to dashboard <Icon name="arrow" cls="" /></a>
      </div>
    );
  }

  return (
    <div className="ob created">
      <div className="seal"><Icon name="check" cls="" /></div>
      <div className="eyebrow">Agent created</div>
      <h1>{alias} is ready.</h1>
      <p className="lede">Your teammate is standing by — idle until you give it work. The best first move is to think out loud with it.</p>

      <div className="agentcard">
        <Avatar alias={alias} kind="ai" size="lg" />
        <div className="ac-meta">
          <h3>{alias} <KindBadge kind="ai" /></h3>
          <div className="role">{role}</div>
          <div className="chips"><Pill status={a.status} /><span className="tag model">{model}</span></div>
        </div>
      </div>

      <div className="brainstorm">
        <div className="bh"><span className="bic"><Icon name="requests" cls="" /></span><h3>Brainstorm the plan with {alias}</h3></div>
        <div className="bb">
          <p>Open a conversation and think through what you're building. {alias} will help you break it into tasks and <b>propose the rest of the team</b> for your approval. You stay in command the whole way.</p>
          <a className="btn" href={"/agents?agent=" + encodeURIComponent(alias)}><Icon name="requests" cls="" />Open conversation with {alias} <Icon name="arrow" cls="" /></a>
        </div>
      </div>

      <div className="held"><Icon name="clock" cls="" /><span>Assigning tasks to agents is coming soon (needs the B5 assign endpoint). For now, {alias} picks up any initial task you gave it.</span></div>

      {walkBlock}

      <div className="secondary">
        <a data-go="create-agent" onClick={() => f.go("create-agent")}><Icon name="plus" cls="" />Create another agent</a>
        <a data-go="create-tasks" onClick={() => f.go("create-tasks")}><Icon name="tasks" cls="" />Add tasks</a>
        <a href="/"><Icon name="home" cls="" />Go to dashboard</a>
      </div>
    </div>
  );
}

/* ---- 3b · CREATE TASKS (queue locally, then POST each as standalone ready) -- */
function StepCreateTasks({ f }: { f: Flow }) {
  const [title, setTitle] = useState("");
  const [dod, setDod] = useState("");
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const addTask = () => {
    const t = (title || "").trim();
    const d = (dod || "").trim();
    if (!t || !d) { f.toast("Title and definition of done are required", "bad"); return; }
    f.update((s) => { s.tasks.push({ title: t, dod: d }); });
    setTitle("");
    setDod("");
    titleRef.current?.focus();
    f.toast("Task added", "ok");
  };

  const cont = async () => {
    // Path B: persist EVERY queued task as a real standalone (ready/unassigned)
    // task so an agent can pick it up via the work loop — never silently drop
    // the queue (review P2). The create-agent step can then optionally pick one
    // of them as the agent's initial_task.
    if (f.S.tasks.length) {
      setBusy(true);
      const h = actingHuman(f.snap);
      const remaining: QueuedTask[] = [];
      for (const t of f.S.tasks) {
        const res = await postJSON(
          "/api/containers/" + encodeURIComponent(String(f.cid)) + "/tasks",
          { title: t.title, definition_of_done: t.dod, created_by_agent_id: h ? h.id : undefined },
        );
        if (!res.ok) remaining.push(t);
      }
      const created = f.S.tasks.length - remaining.length;
      f.update((s) => { s.tasks = remaining; });
      f.toast(
        remaining.length
          ? created + " created, " + remaining.length + " failed — retry the rest"
          : created + " task" + (created === 1 ? "" : "s") + " created",
        remaining.length ? "bad" : "ok",
      );
      setBusy(false);
      if (remaining.length) return; // stay on the step so they can retry
      f.update((s) => { s._agentDraft = null; }); // fresh create-agent draft
      await f.refreshAnd("create-agent"); // snapshot now has the new tasks → pickable
      return;
    }
    f.update((s) => { s._agentDraft = null; });
    f.go("create-agent");
  };

  return (
    <div className="ob">
      <div className="form-h">
        <span className="fic" style={{ background: "var(--violet-soft)", borderColor: "var(--violet-line)", color: "var(--violet)" }}><Icon name="tasks" cls="" /></span>
        <div><h2>Add your first tasks</h2><p>Capture the work as tasks — each with a clear definition of done. Next, create an agent and these become its first task.</p></div>
      </div>

      <div id="tqWrap">
        {f.S.tasks.length ? (
          <div className="taskqueue">
            {f.S.tasks.map((t, i) => (
              <div className="tq" key={i}>
                <span className="num">{i + 1}</span>
                <div className="grow"><div className="tt">{t.title}</div><div className="dod">{t.dod}</div></div>
                <button className="del" data-del={i} title="Remove" onClick={() => f.update((s) => { s.tasks.splice(i, 1); })}><Icon name="x" cls="" /></button>
              </div>
            ))}
          </div>
        ) : (
          <div className="none" style={{ marginBottom: 18, padding: 22 }}>No tasks yet — add your first one below.</div>
        )}
      </div>

      <div className="taskform">
        <div className="tf-h"><Icon name="plus" cls="" />New task</div>
        <div className="field2">
          <div className="lab">Title <span className="req">*</span></div>
          <input className="ipt" id="tkTitle" ref={titleRef} value={title} placeholder="e.g. Persist + expose worker output" autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field2" style={{ marginBottom: 8 }}>
          <div className="lab">Definition of done <span className="req">*</span></div>
          <textarea className="txa" id="tkDod" rows={2} value={dod} placeholder="The unambiguous finish line — how you'll know it's done." onChange={(e) => setDod(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") addTask(); }} />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}><button className="btn subtle" id="tkAdd" onClick={addTask}><Icon name="plus" cls="" />Add task</button></div>
      </div>

      <div className="form-actions">
        <button className="btn ghost" data-go="fork" onClick={() => f.go("fork")}>Back</button>
        <span className="grow"></span>
        <span className="note" id="tkCount">{f.S.tasks.length ? f.S.tasks.length + " task" + (f.S.tasks.length === 1 ? "" : "s") + " queued" : "Add at least one task"}</span>
        <button className="btn" id="tkContinue" disabled={busy} onClick={() => void cont()}><Icon name="agents" cls="" />Continue — create an agent <Icon name="arrow" cls="" /></button>
      </div>
    </div>
  );
}

/* ====================================================================== */
/*  PATH G — AI roster proposal (goal → stream → editable roster → walk)    */
/* ====================================================================== */

/* ---- G1 · describe the goal ------------------------------------------------ */
function StepProposeGoal({ f }: { f: Flow }) {
  const pr = f.S._propose || { goal: "", dialogue: [] };
  const [err, setErr] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const t = setTimeout(() => taRef.current && taRef.current.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const goGo = () => {
    const g = (pr.goal || "").trim();
    if (!g) { taRef.current?.focus(); setErr(true); return; }
    f.update((s) => {
      const p = s._propose || (s._propose = { goal: "", dialogue: [] });
      p.goal = g;
      p.dialogue = [];
    });
    f.go("propose-stream");
  };

  return (
    <div className="ob">
      <div className="form-h">
        <span className="fic"><Icon name="spark" cls="" /></span>
        <div>
          <h2>Tell me what you're building</h2>
          <p>One or two sentences is plenty. I'll propose a starting team — agents with system prompts and their first tasks — for you to review and edit. Nothing is created until you approve it.</p>
        </div>
      </div>
      <div className="card pad">
        <div className="field2" style={{ marginBottom: 6 }}>
          <div className="lab">Your project goal <span className="req">*</span></div>
          <textarea
            className="txa" id="gGoal" ref={taRef} rows={4} value={pr.goal}
            placeholder="e.g. Improve my app's onboarding — I want fewer drop-offs on first run and a clearer first-task experience."
            style={err ? { borderColor: "var(--danger-line)" } : undefined}
            onChange={(e) => {
              setErr(false);
              f.update((s) => {
                const p = s._propose || (s._propose = { goal: "", dialogue: [] });
                p.goal = e.target.value;
              });
            }}
          />
          <div className="hint">Vague is fine — I may ask 1–3 quick questions to narrow it before proposing.</div>
        </div>
      </div>
      <div className="form-actions">
        <button className="btn ghost" data-go="fork" onClick={() => f.go("fork")}>Back</button>
        <span className="grow"></span>
        <span className="note">I propose; you decide. You can edit everything next.</span>
        <button className="btn" id="gGo" onClick={goGo}><Icon name="spark" cls="" />Propose my roster</button>
      </div>
    </div>
  );
}

/* ---- G2 · stream the proposal (thinking → clarify | roster | error) --------- */
type StreamTurn =
  | { kind: "clarify"; questions: ClarifyQuestion[] }
  | { kind: "error"; err: ProposeError }
  | null;

function StepProposeStream({ f }: { f: Flow }) {
  const [nonce, setNonce] = useState(0); // bump to (re)start the stream — vanilla re-entered the step
  const [acc, setAcc] = useState("");
  const [done, setDone] = useState(false);
  const [turn, setTurn] = useState<StreamTurn>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const accRef = useRef("");
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const fRef = useRef(f);
  fRef.current = f;

  useEffect(() => {
    const cur = fRef.current;
    const pr = cur.S._propose;
    if (!pr || !pr.goal) { cur.go("propose-goal"); return; }
    accRef.current = "";
    setAcc("");
    setDone(false);
    setTurn(null);
    setAnswers([]);
    // Open the SSE stream (fetch + ReadableStream — EventSource is GET-only, the
    // contract is POST+SSE). The abort runs on unmount/restart, which covers the
    // vanilla go()-navigation abort.
    const abort = startPropose(
      { cid: cur.cid, goal: pr.goal, dialogue: pr.dialogue || [] },
      {
        onThinking: (d) => { accRef.current += d; setAcc(accRef.current); },
        onClarify: (questions) => { setDone(true); setTurn({ kind: "clarify", questions: (questions || []).slice(0, 3) }); },
        onRoster: (payload) => {
          fRef.current.update((s) => { s._roster = normalizeRoster(payload, fRef.current.defaultModel); });
          fRef.current.go("propose-roster");
        },
        onError: (err) => { setDone(true); setTurn({ kind: "error", err }); },
      },
      { demo: !!pr.demo, defaultModel: cur.defaultModel },
    );
    return () => { try { abort(); } catch { /* already stopped */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [acc]);

  const pr = f.S._propose;
  if (!pr || !pr.goal) return null;

  /* clarify turn: collect answers into the dialogue, then re-ask */
  const collect = () => {
    if (!turn || turn.kind !== "clarify") return;
    const qs = turn.questions;
    fRef.current.update((s) => {
      const p = s._propose || (s._propose = { goal: "", dialogue: [] });
      p.dialogue = p.dialogue || [];
      qs.forEach((q, i) => {
        const a = (answers[i] || "").trim();
        p.dialogue.push({ role: "assistant", content: q.prompt || "" });
        p.dialogue.push({ role: "user", content: a || "(no preference)" });
      });
    });
    setNonce((n) => n + 1);
  };
  const skip = () => {
    fRef.current.update((s) => {
      const p = s._propose || (s._propose = { goal: "", dialogue: [] });
      p.dialogue = p.dialogue || [];
      p.dialogue.push({ role: "user", content: "(skip clarifying — propose your best roster now)" });
    });
    setNonce((n) => n + 1);
  };
  /* error turn: retry, feeding the server's invalid_goal feedback back in */
  const retry = () => {
    if (!turn || turn.kind !== "error") return;
    const err = turn.err;
    fRef.current.update((s) => {
      const p = s._propose;
      if (p && err && err.code === "invalid_goal" && err.message) {
        p.dialogue = p.dialogue || [];
        p.dialogue.push({ role: "user", content: "(Previous roster proposal failed validation on the server: " + err.message + ". Please revise the roster and avoid that issue.)" });
      }
    });
    setNonce((n) => n + 1);
  };

  let turnEl: ReactNode = null;
  if (turn && turn.kind === "clarify") {
    turnEl = (
      <div className="clarify">
        <div className="cl-h"><Icon name="requests" cls="" /><span>A couple of quick questions</span></div>
        {turn.questions.map((q, i) => (
          <div className="field2" style={{ marginBottom: 13 }} key={i}>
            <div className="lab">{q.prompt}</div>
            <input
              className="ipt" data-qid={q.id || ""} data-qprompt={q.prompt || ""}
              placeholder="Your answer — or leave blank" autoComplete="off"
              value={answers[i] || ""}
              onChange={(e) => setAnswers((arr) => { const n = arr.slice(); n[i] = e.target.value; return n; })}
            />
          </div>
        ))}
        <div className="cl-actions">
          <button className="btn subtle" id="clSkip" onClick={skip}>Skip — just propose</button>
          <button className="btn" id="clGo" onClick={collect}><Icon name="arrow" cls="" />Continue</button>
        </div>
      </div>
    );
  } else if (turn && turn.kind === "error") {
    const code = (turn.err && turn.err.code) || "model_error";
    const msg = (turn.err && turn.err.message) || ERR_COPY[code] || ERR_COPY.model_error;
    const retryable = code !== "roster_truncated";
    turnEl = (
      <div className="perror">
        <div className="pe-h"><Icon name="shield" cls="" /><span>Couldn't propose a roster</span></div>
        <p>{msg}</p>
        <div className="pe-actions">
          {retryable && <button className="btn subtle" id="peRetry" onClick={retry}><Icon name="refresh" cls="" />Retry</button>}
          <a className="btn ghost" data-go="propose-goal" onClick={() => f.go("propose-goal")}>Edit goal</a>
          <a className="btn ghost" data-go="fork" onClick={() => f.go("fork")}>Set up by hand instead</a>
        </div>
      </div>
    );
  }

  return (
    <div className="ob propose">
      <div className="form-h">
        <span className="fic"><Icon name="spark" cls="" /></span>
        <div>
          <h2>Designing your roster…</h2>
          <p className="gp-goal">“{trunc(pr.goal, 160)}”</p>
        </div>
      </div>
      <div className="card pad">
        <div className={"thinking" + (done ? " done" : "")} id="pThink">
          <div className="th-h"><Icon name="live" cls="" /><span>Thinking</span><span className="dots"><i></i><i></i><i></i></span></div>
          <pre className="th-body" id="pThinkBody" ref={bodyRef}>{acc}</pre>
        </div>
        <div id="pTurn">{turnEl}</div>
      </div>
      <div className="form-actions">
        <button className="btn ghost" id="pStop" onClick={() => f.go("propose-goal")}><Icon name="stop" cls="" />Stop</button>
        <span className="grow"></span>
        <span className="note">Streaming from the onboarding model</span>
      </div>
    </div>
  );
}

/* ---- G3 · review + edit the proposed roster, then commit (the walk) --------- */
function StepProposeRoster({ f }: { f: Flow }) {
  const r = f.S._roster;
  const bad = !r || !r.agents || !r.agents.length;
  const fRef = useRef(f);
  fRef.current = f;
  useEffect(() => { if (bad) fRef.current.go("propose-goal"); }, [bad]);
  if (bad || !r) return null;

  const agentNames = r.agents.map((a) => a.name).filter(Boolean);

  const delAgent = (i: number) => f.update((s) => {
    const rr = s._roster;
    if (!rr) return;
    const gone = rr.agents.splice(i, 1)[0];
    // drop now-dangling assignees + kickoffs that pointed at the removed agent
    if (gone) rr.tasks.forEach((t) => { if (t.assignee === gone.name) { t.assignee = null; t.is_kickoff = false; } });
  });

  const commit = () => {
    // normalize the edited roster once more (drop empties / fix refs), then start the walk.
    const clean = normalizeRoster(
      { rationale: r.rationale, agents: r.agents.map((a) => ({ name: a.name, role: a.role, charter: a.charter, model_hint: a.model })), tasks: r.tasks },
      f.defaultModel,
    );
    if (!clean.agents.length) { f.toast("Add at least one agent (name, role, prompt) before creating", "bad"); return; }
    const walk = rosterToWalk(clean);
    f.update((s) => {
      s._walk = walk;
      s._agentDraft = walkAgentToDraft(walk.agents[0], f.defaultModel);
    });
    f.go("create-agent");
  };

  return (
    <div className="ob wide">
      <div className="form-h">
        <span className="fic"><Icon name="spark" cls="" /></span>
        <div>
          <h2>Your proposed roster</h2>
          <p>Review and edit anything — names, prompts, models, tasks, who owns what. Nothing is created until you choose to. You'll confirm each agent in the create form before it's committed.</p>
        </div>
      </div>
      {r.rationale ? <div className="rationale"><Icon name="spark" cls="" /><span>{r.rationale}</span></div> : null}

      <div className="rsec-h">
        <Icon name="agents" cls="" /><span>Agents</span><span className="grow"></span>
        <button className="addrow" id="rAddAgent" onClick={() => f.update((s) => { s._roster?.agents.push({ name: "", role: "", charter: "", model: f.defaultModel }); })}><Icon name="plus" cls="" />Add agent</button>
      </div>
      <div className="rgrid" id="rAgents">
        {r.agents.map((a, i) => (
          <div className="rcard" data-aidx={i} key={i}>
            <div className="rc-h">
              <Avatar alias={a.name || "?"} kind="ai" size="sm" />
              <div className="grow">
                <input className="ipt rc-name" data-aidx={i} value={a.name} placeholder="Agent name" autoComplete="off" spellCheck={false} onChange={(e) => f.update((s) => { if (s._roster) s._roster.agents[i].name = e.target.value; })} />
                <input className="ipt rc-role" data-aidx={i} value={a.role} placeholder="Role — e.g. Builder · implementation" autoComplete="off" onChange={(e) => f.update((s) => { if (s._roster) s._roster.agents[i].role = e.target.value; })} />
              </div>
              <button className="rdel" data-adel={i} title="Remove agent" onClick={() => delAgent(i)}><Icon name="x" cls="" /></button>
            </div>
            <textarea className="txa mono rc-charter" data-aidx={i} rows={5} value={a.charter} placeholder="System prompt / charter" onChange={(e) => f.update((s) => { if (s._roster) s._roster.agents[i].charter = e.target.value; })} />
            <div className="rc-models" data-aidx={i}><ModelCards models={f.models} selected={a.model} onPick={(id) => f.update((s) => { if (s._roster) s._roster.agents[i].model = id; })} /></div>
          </div>
        ))}
      </div>

      <div className="rsec-h" style={{ marginTop: 24 }}>
        <Icon name="tasks" cls="" /><span>Tasks</span><span className="grow"></span>
        <button className="addrow" id="rAddTask" onClick={() => f.update((s) => { s._roster?.tasks.push({ title: "", definition_of_done: "", assignee: null, depends_on: [], protocol: null, is_kickoff: false }); })}><Icon name="plus" cls="" />Add task</button>
      </div>
      <div className="rtasks" id="rTasks">
        {r.tasks.length ? r.tasks.map((t, i) => (
          <div className="rtask" data-tidx={i} key={i}>
            <div className="rt-top">
              <input className="ipt rt-title" data-tidx={i} value={t.title} placeholder="Task title" autoComplete="off" onChange={(e) => f.update((s) => { if (s._roster) s._roster.tasks[i].title = e.target.value; })} />
              <button className="rdel" data-tdel={i} title="Remove task" onClick={() => f.update((s) => { s._roster?.tasks.splice(i, 1); })}><Icon name="x" cls="" /></button>
            </div>
            <textarea className="txa rt-dod" data-tidx={i} rows={2} value={t.definition_of_done} placeholder="Definition of done" onChange={(e) => f.update((s) => { if (s._roster) s._roster.tasks[i].definition_of_done = e.target.value; })} />
            <div className="rt-meta">
              <label className="rt-assign">Assignee{" "}
                <select
                  className="sel rt-assignee" data-tidx={i} value={t.assignee || ""}
                  onChange={(e) => f.update((s) => {
                    if (!s._roster) return;
                    const tt = s._roster.tasks[i];
                    tt.assignee = e.target.value || null;
                    if (!tt.assignee) tt.is_kickoff = false; // standalone tasks can't be a kickoff
                  })}
                >
                  <option value="">Unassigned (standalone)</option>
                  {agentNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="rt-kick">
                <input
                  type="checkbox" className="rt-kickoff" data-tidx={i} checked={!!t.is_kickoff} disabled={!t.assignee}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    f.update((s) => {
                      if (!s._roster) return;
                      const tt = s._roster.tasks[i];
                      if (checked && tt.assignee) { // one kickoff per assignee — clear the others
                        s._roster.tasks.forEach((o, j) => { if (j !== i && o.assignee === tt.assignee) o.is_kickoff = false; });
                        tt.is_kickoff = true;
                      } else tt.is_kickoff = false;
                    });
                  }}
                />{" "}First task (kickoff)
              </label>
              {(t.depends_on || []).length ? <span className="rt-dep"><Icon name="link" cls="" />after: {t.depends_on.join(", ")}</span> : null}
              {t.protocol ? <span className="rt-proto"><Icon name="flag" cls="" />protocol</span> : null}
            </div>
          </div>
        )) : (
          <div className="none" style={{ padding: 18 }}>No tasks proposed — add one, or create agents and add work later.</div>
        )}
      </div>

      <div className="form-actions">
        <button className="btn ghost" data-go="propose-goal" onClick={() => f.go("propose-goal")}><Icon name="arrow" cls="" />Back</button>
        <span className="grow"></span>
        <span className="note">Kickoff tasks become each agent's first task; the rest become ready tasks.</span>
        <button className="btn" id="rCommit" onClick={commit}><Icon name="check" cls="" />Looks good — create the team</button>
      </div>
    </div>
  );
}
