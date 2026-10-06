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
 *
 * V2 "Linear pop" (D5-D12): the setup progress lives in the panel's pill row
 * (`<Shell toolbar>`) as honest step glyphs; each step is a calm, centred
 * column with a Display title, one flat card and compact controls built from
 * the shared primitives (Avatar / StatusIcon / Chip / FilterPills /
 * GroupHeader / WorkedFor). One primary action per view, no coloured
 * stripes, no hero sections. `/onboarding?new=1` renders as "Agents › New
 * agent" (no setup stepper; Cancel returns to /agents).
 */
import {
  Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode, type Ref, type TextareaHTMLAttributes,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getJSON } from "../../api/client";
import { Icon, useToast } from "../../components/ui";
import { Button, ButtonLink, IconButton } from "../../components/primitives/Button";
import { Avatar, HelpTip, MenuButton, type MenuItemSpec } from "../../components/primitives";
import { StatusGlyph, StatusIcon } from "../../components/primitives";
import { Chip } from "../../components/primitives";
import { FilterPills } from "../../components/primitives";
import { GroupHeader } from "../../components/primitives";
import { WorkedFor, formatDuration } from "../../components/primitives";
import { trunc } from "../../lib/format";
import { withCid } from "../../lib/scope";
import { Shell } from "../../shell/Shell";
import { PageToolbar, scrollMainTo } from "../../shell/PageChrome";
import { actingHuman, setActingHuman, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent, Snapshot, Task } from "../../types";
import {
  AGENT_STEPS, CONCIERGE_TEMPLATE, RAIL, type Walk,
  agentCreateDenial, renameRosterAgent, taskCreateDenial, taskBatchFailCopy, FORK_VIEWER_REASON, commitLabel, createdLede, forkCounts, groupModels, loadState, modelLabel, normalizeModels, normalizeRoster, postJSON, proposeErrorCopy, railKeyFor, reconcileDemoFlag, reconcileGhost,
  resumeStep, rosterToWalk, saveState, startPropose, walkAgentToDraft,
  type AgentDraft, type ClarifyQuestion, type ModelInfo, type OnbState, type ProposeError, type QueuedTask,
} from "./logic";
import { PAGE_CSS } from "./pageCss";
import { TemplateStep } from "./templates/TemplateStep";

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
  adding: boolean; // "+ New agent" (?new=1) — a single agent, not the setup flow
  /** the signed-in account's name (cloud identity), if any — prefills "Name yourself" */
  accountName: string | null;
  /** why this identity may NOT add agents (viewer / no manage_agents grant), else null */
  agentDenied: string | null;
  /** why this identity may NOT add tasks (viewer), else null */
  tasksDenied: string | null;
  /** end setup on the project Overview (cid kept) */
  toOverview: () => void;
}

/** the create-agent fields submit requires, in on-screen order */
type AgentField = "alias" | "role" | "prompt" | "desc";
export function missingAgentFields(d: AgentDraft): AgentField[] {
  const out: AgentField[] = [];
  if (!(d.alias || "").trim()) out.push("alias");
  if (!(d.role || "").trim()) out.push("role");
  if (!(d.prompt || "").trim()) out.push("prompt");
  // "Describe one" picked but left empty: say so instead of silently creating
  // the agent with no first task (review r2).
  if (d._firstMode === "describe" && !(d._desc || "").trim()) out.push("desc");
  return out;
}

export function OnboardingPage() {
  const { snap, cid, multi, refresh, identity } = useSnapshot();
  const toast = useToast() as unknown as (msg: string, kind?: string) => void;
  const location = useLocation();
  const [S, setS] = useState<OnbState>(() => loadState(cid, multi));
  const scopeRef = useRef<{ cid: string | null; multi: boolean }>({ cid, multi });
  scopeRef.current = { cid, multi };
  // Booted FOR a project: a cid switch while mounted re-boots from THAT
  // project's saved draft instead of carrying project A's state into B (QA 11).
  const [bootedCid, setBootedCid] = useState<string | null | undefined>(undefined);
  // the project the in-memory draft (SRef) was loaded for
  const loadedCidRef = useRef<string | null>(cid);
  const booted = bootedCid !== undefined && bootedCid === cid;
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  // entered via "+ New agent" (?new=1 / ?step=create-agent) — not persisted
  const [newAgentEntry, setNewAgentEntry] = useState(false);

  // Mutable mirror so sequential update() calls in one handler read their own
  // writes (the vanilla code mutated a single S object + save()).
  const SRef = useRef(S);
  SRef.current = S;

  const update = useCallback((fn: (s: OnbState) => void) => {
    const next = JSON.parse(JSON.stringify(SRef.current)) as OnbState;
    fn(next);
    // persist per project, on the same events the vanilla page saves — but never
    // while the in-memory draft still belongs to a previously booted project.
    if (loadedCidRef.current === scopeRef.current.cid) saveState(next, scopeRef.current.cid, scopeRef.current.multi);
    SRef.current = next;
    setS(next);
  }, []);

  // scroll-to-top belongs to an explicit STEP CHANGE, not to render() itself —
  // a re-render of the current step never jumps the page (vanilla bug 3). On
  // wide layouts the content scrolls INSIDE the D5 panel, so scrollMainTo picks
  // the right scroller (panel or window). A live propose SSE stream is aborted
  // on navigation via StepProposeStream's effect cleanup.
  const go = useCallback((step: string) => {
    update((s) => { s.step = step; });
    scrollMainTo(0);
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
    // wait for THIS project's snapshot after a switch (never boot B from A's snapshot)
    const snapCid = snap.container?.id;
    if (cid && snapCid != null && String(snapCid) !== String(cid)) return;
    // query params live in the hash route (/onboarding?new=1) or the real URL.
    const qp = (k: string): string | null => {
      const h = new URLSearchParams(location.search).get(k);
      return h != null ? h : new URLSearchParams(window.location.search).get(k);
    };
    const agents = snap.agents || [];
    const hasOp = agents.some((a) => a.kind === "human");
    const wantsNew = (qp("new") === "1" || qp("step") === "create-agent") && hasOp;
    // the cid is resolved by now: adopt THIS project's saved draft (never another's)
    SRef.current = loadState(cid, multi);
    loadedCidRef.current = cid;
    update((s) => {
      // Reconcile against server truth FIRST (#140 ghost reconcile).
      const rec = reconcileGhost(s, agents.map((a) => a.alias));
      s.step = rec.step;
      s.lastAgentAlias = rec.lastAgentAlias;
      // DEV-ONLY ?demo=1 — reconciled from the live URL every boot (never sticky).
      reconcileDemoFlag(s, qp("demo") === "1");
      // "+ New agent" deep-link (?new=1 or ?step=create-agent).
      if ((qp("new") === "1" || qp("step") === "create-agent") && hasOp) s.step = "create-agent";
      // "Start from a template" deep link (general-mode-templates)
      else if (qp("step") === "template" && hasOp) s.step = "template";
      else s.step = resumeStep(s.step, hasOp); // skip welcome if a human exists
    });
    setNewAgentEntry(wantsNew);
    setBootedCid(cid);
  }, [snap, booted, update, location.search, cid, multi]);

  /* ---- resolve models once on boot (GET /api/models, vanilla init()) ----- */
  useEffect(() => {
    getJSON<{ models?: unknown; default?: string }>("/api/models").then((d) => {
      if (d && Array.isArray(d.models)) {
        const ms = normalizeModels(d.models);
        setModels(ms);
        const dm = d.default || (ms[0] && ms[0].id) || null;
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
  // the project's ROOT task (its objective) is never pickable work (P-10)
  const readyTasks = (snap?.tasks ?? []).filter((t) => t.status === "ready" && !t.is_root && !(t.assignees || []).length);
  // "+ New agent" stays a single-agent flow only while no roster walk is running
  const adding = newAgentEntry && !S._walk && (S.step === "create-agent" || S.step === "agent-created");

  const accountName = (identity && (identity.alias || identity.github_login)) || null;
  const agentDenied = agentCreateDenial(identity);
  const tasksDenied = taskCreateDenial(identity);
  const navigate = useNavigate();
  const toOverview = useCallback(() => {
    navigate(cid && multi ? withCid("/", cid) : "/");
  }, [navigate, cid, multi]);
  const flow: Flow = { S, update, go, refreshAnd, toast, cid, snap, models, defaultModel, op, first, readyTasks, adding, accountName, agentDenied, tasksDenied, toOverview };
  // "+ New agent" for someone who can't add agents: a read-only page, never a
  // form that ends in a 403 (e2e-permissions-14).
  const lockedNew = newAgentEntry && !!agentDenied && S.step !== "agent-created";

  return (
    <Shell
      page={adding || lockedNew ? "agents" : "onboarding"}
      title={adding || lockedNew ? "Agents" : "Setup"}
      crumbs={adding || lockedNew ? [{ label: "New agent" }] : []}
      toolbar={booted && !adding && !lockedNew ? <GuideRail step={S.step} walk={S._walk} /> : undefined}
    >
      <style>{PAGE_CSS}</style>
      {booted && (
        <div className={"ob-page" + (adding || lockedNew ? " is-adding" : "")}>
          <div id="obMain">
            {agentDenied && AGENT_STEPS.indexOf(S.step) >= 0
              ? <AgentsLocked reason={agentDenied} adding={newAgentEntry} onBack={() => go("fork")} />
              : <StepView f={flow} />}
          </div>
        </div>
      )}
    </Shell>
  );
}

/* ---- read-only: this identity can't add agents (viewer / no grant) --------- */
function AgentsLocked({ reason, adding, onBack }: { reason: string; adding: boolean; onBack: () => void }) {
  return (
    <div className="ob" id="obLocked">
      <StepHead title="You can't add agents to this project">{reason}.</StepHead>
      <div className="form-actions">
        {adding
          ? <ButtonLink variant="secondary" icon="agents" to="/agents">Back to Agents</ButtonLink>
          : <Button variant="secondary" className="ob-back" icon="arrow" data-go="fork" onClick={onBack}>Back</Button>}
      </div>
    </div>
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
    case "template": return (
      <TemplateStep cid={f.cid} denied={f.agentDenied} onBack={() => f.go("fork")}
        onFinished={() => { void f.refreshAnd("fork").then(f.toOverview); }} />
    );
    case "welcome":
    default: return <StepWelcome f={f} />;
  }
}

/* ---- setup progress: the panel's pill row (same rail on every step) --------
 * Honest progress: done = green check glyph, current = in-progress glyph in a
 * filled pill, upcoming = empty ring. During a roster walk the Create step
 * says exactly where the walk is ("agent 2 of 4"), never a fake percentage. */
function railDetail(step: string, walk: Walk | null | undefined): string | null {
  if (!walk || !walk.agents.length) return null;
  const n = walk.agents.length;
  if (step === "create-agent") return "agent " + Math.min(walk.idx + 1, n) + " of " + n;
  if (step === "agent-created") return walk.idx + " of " + n + " created";
  return null;
}

function GuideRail({ step, walk }: { step: string; walk?: Walk | null }) {
  const curKey = railKeyFor(step);
  const idx = Math.max(0, RAIL.findIndex((r) => r.key === curKey));
  const detail = railDetail(step, walk);
  return (
    <PageToolbar
      label="Setup"
      className="ob-progress"
      // nothing to skip to before an operator exists
      end={step !== "welcome" ? <a className="ob-skip" href="/">Skip to Overview <Icon name="arrow" cls="" /></a> : null}
    >
      <nav className={"guide-rail" + (detail ? " has-detail" : "")} aria-label="Setup progress">
        <span className="v2-sr">Step {idx + 1} of {RAIL.length}</span>
        <ol className="steps">
          {RAIL.map((r, i) => (
            <Fragment key={r.key}>
              {i ? <li className="sep" aria-hidden="true" /> : null}
              <li className={"st " + (i < idx ? "done" : i === idx ? "cur" : "todo")} aria-current={i === idx ? "step" : undefined}>
                <StatusGlyph status={i < idx ? "completed" : i === idx ? "in_progress" : "ready"} size={14} />
                <span className="st-l">{r.label}</span>
                {i === idx && detail ? <span className="st-d">{detail}</span> : null}
                {i < idx ? <span className="v2-sr"> (done)</span> : null}
              </li>
            </Fragment>
          ))}
        </ol>
        <span className="st-n" aria-hidden="true">{idx + 1} / {RAIL.length}</span>
      </nav>
    </PageToolbar>
  );
}

/* ---- auto-growing textarea (no giant empty boxes; long text stays visible) - */
/* `clamp` (screen review r3, D12 "max 2 text lines per list item"): on phone
 * widths the CSS caps an UNFOCUSED field at that many lines; the field marks
 * itself data-over when its text runs longer so the CSS can fade the cut-off.
 * Tapping (focusing) it shows the whole text for editing. */
function AutoTextarea({ inputRef, minRows = 2, clamp, value, onBlur, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  inputRef?: Ref<HTMLTextAreaElement>; minRows?: number; clamp?: number;
}) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = own.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + 2 + "px";
    if (clamp) {
      const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
      const lh = cs ? parseFloat(cs.lineHeight) : NaN;
      const pad = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;
      const lines = Number.isFinite(lh) && lh > 0 ? Math.round((el.scrollHeight - pad) / lh) : 0;
      if (lines > clamp) el.dataset.over = "1";
      else delete el.dataset.over;
    }
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    const el = own.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fit(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea
      {...rest}
      value={value}
      rows={minRows}
      data-clamp={clamp || undefined}
      onBlur={(e) => { if (clamp) e.currentTarget.scrollTop = 0; onBlur?.(e); }}
      ref={(el) => {
        own.current = el;
        if (typeof inputRef === "function") inputRef(el);
        else if (inputRef) (inputRef as { current: HTMLTextAreaElement | null }).current = el;
      }}
    />
  );
}

/* ---- model picker: rounded radio pills grouped by provider ---------------- */
function ModelPicker({ models, selected, onPick, name }: { models: ModelInfo[]; selected: string | null; onPick: (id: string) => void; name: string }) {
  if (!models.length) return <div className="ob-muted" role="status">Loading models…</div>;
  const groups = groupModels(models);
  return (
    <div className="ob-models" role="radiogroup" aria-label="Model">
      {groups.map((g) => (
        <div className="ob-mgroup" key={g.provider}>
          {groups.length > 1 ? <div className="ob-mgroup-h">{g.provider}</div> : null}
          <div className="ob-mlist">
            {g.models.map((m) => (
              <label key={m.id} className={"ob-mopt" + (m.id === selected ? " on" : "")} data-model={m.id} title={m.id}>
                <input type="radio" name={name} value={m.id} checked={m.id === selected} onChange={() => onPick(m.id)} />
                <span className="ob-mdot" aria-hidden="true" />
                <span className="ob-mname">{modelLabel(m.id, models)}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- compact model dropdown for the roster review (one line per agent) ----
 * A ghost MenuButton sized to its content that shows the catalog's display
 * name ("Opus 5"), never a truncated raw id; the id lives in the tooltip. */
function ModelSelect({ models, value, onChange, idx }: { models: ModelInfo[]; value: string | null; onChange: (id: string) => void; idx: number }) {
  if (!models.length) return <span className="ob-muted">Loading models…</span>;
  const groups = groupModels(models);
  const items: (MenuItemSpec | "separator")[] = [];
  groups.forEach((g, gi) => {
    if (gi) items.push("separator");
    g.models.forEach((m, mi) => items.push({
      label: modelLabel(m.id, models), checked: m.id === value, onSelect: () => onChange(m.id),
      hint: groups.length > 1 && mi === 0 ? g.provider : undefined,
    }));
  });
  return (
    <span className="rc-model" data-aidx={idx}>
      <MenuButton
        variant="ghost" size="sm" menuLabel="Model" placement="bottom-end" className="ob-ddl"
        title={value ? "Model: " + value : undefined}
        value={value ? modelLabel(value, models) : "Choose a model"}
        items={items}
      />
    </span>
  );
}

/* ---- shared step header: Display title + one muted lede (the page's h1) --- */
function StepHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="form-h">
      <h1 className="v2-t-display">{title}</h1>
      {children ? <p className="v2-t-body-lg">{children}</p> : null}
    </div>
  );
}

/* ---- a quiet ⓘ that carries the explanation a line of copy used to (D12) --- */
const Help = ({ text }: { text: string }) => <HelpTip tip={text} />;

const OPERATOR_HELP = "Registers you as this project's operator — the standing human authority. Agents stop at needs verification; you decide.";

/* ---- 1 · WELCOME → register the operator (human) -------------------------- */
function StepWelcome({ f }: { f: Flow }) {
  // signed in (cloud)? the sidebar already says "Acting as <name>" — prefill that
  // name so this step reads as "join this project as <name>", not a second
  // "who are you?" (review: the name was asked while the account was known).
  const [name, setName] = useState(() => f.accountName || "");
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

  const known = !!f.accountName;
  const projectName = f.snap?.container?.name || null;
  return (
    <div className="ob welcome">
      <StepHead title={known && projectName ? <>Join {projectName}</> : "Welcome to Embodent"}>
        {known
          ? <>Signed in as <b>{f.accountName}</b>. Confirm the name you'll act under here.</>
          : "Agents do the work; nothing ships on their say-so."}
      </StepHead>
      <div className="ob-panel">
        <div className="field2 last">
          <div className="lab">
            <label htmlFor="opName">{known ? "Your name in this project" : "What should we call you?"}</label>
            <Help text={OPERATOR_HELP} />
          </div>
          <div className="ob-namerow">
            <input
              className={"ipt" + (err ? " invalid" : "")} id="opName" ref={inpRef} value={name}
              placeholder="Your name — e.g. dario" autoComplete="off" spellCheck={false} maxLength={40}
              aria-invalid={err || undefined} aria-describedby={err ? "opNameErr" : undefined}
              onChange={(e) => { setName(e.target.value); setErr(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            />
            <Button variant="primary" id="opGo" busy={busy} iconRight="arrow" onClick={() => void submit()}>{known ? "Join" : "Continue"}</Button>
          </div>
          {err ? <div className="hint err" id="opNameErr" role="alert">Enter a name to continue.</div> : null}
        </div>
      </div>
    </div>
  );
}

/* ---- 2 · THE FORK ---------------------------------------------------------- */
function StepFork({ f }: { f: Flow }) {
  const { agents: nAgents, tasks: nTasks } = forkCounts(f.snap);
  const denied = f.agentDenied;
  return (
    <div className="ob">
      <StepHead
        title={f.first
          ? <>Welcome{f.op && <>, {f.op.alias}</>}. Let's set up your first team.</>
          : <>Add to your team</>}
      >
        {f.first
          ? "Pick a starting point — you can do the others later."
          : <>This project has {nAgents} agent{nAgents === 1 ? "" : "s"} and {nTasks} task{nTasks === 1 ? "" : "s"}.</>}
      </StepHead>
      <div className="ob-panel ob-options">
        <div className="ob-opt is-rec">
          <span className="ob-opt-ic" aria-hidden="true"><Icon name="spark" cls="" /></span>
          <div className="ob-opt-b">
            <h2>Help me set this up <Chip size="sm" dot="accent">Recommended</Chip></h2>
            <p>Describe the project; AI proposes a team for you to approve.</p>
          </div>
          <Button
            variant="primary" icon="spark" data-go="propose-goal" disabled={!!denied}
            title={denied || undefined} aria-describedby={denied ? "obAgentDenied" : undefined}
            onClick={() => f.go("propose-goal")}
          >Propose my roster</Button>
        </div>
        <div className="ob-opt" id="obOptTemplate">
          <span className="ob-opt-ic" aria-hidden="true"><Icon name="grid" cls="" /></span>
          <div className="ob-opt-b">
            <h2>Start from a template</h2>
            <p>Software, marketing, operations, research or support — a starter team, routines and done-criteria you review first.</p>
          </div>
          <Button icon="grid" data-go="template" onClick={() => f.go("template")}>Browse templates</Button>
        </div>
        <div className="ob-opt">
          <span className="ob-opt-ic" aria-hidden="true"><Icon name="agents" cls="" /></span>
          <div className="ob-opt-b">
            <h2>{f.first ? "Create your first agent" : "Create an agent"}</h2>
            <p>{f.first ? <>A <b>concierge</b> to brainstorm the plan with is a good first move.</> : "A role, a model and a system prompt."}</p>
          </div>
          <Button
            icon="plus" data-go="create-agent" disabled={!!denied}
            title={denied || undefined} aria-describedby={denied ? "obAgentDenied" : undefined}
            onClick={() => f.go("create-agent")}
          >Create an agent</Button>
        </div>
        <div className="ob-opt">
          <span className="ob-opt-ic" aria-hidden="true"><Icon name="tasks" cls="" /></span>
          <div className="ob-opt-b">
            <h2>Add tasks first</h2>
            <p>Capture the work with a definition of done, then add agents.</p>
          </div>
          <Button
            icon="plus" data-go="create-tasks" disabled={!!f.tasksDenied}
            title={f.tasksDenied || undefined} aria-describedby={f.tasksDenied ? "obTasksDenied" : undefined}
            onClick={() => f.go("create-tasks")}
          >Add tasks</Button>
        </div>
      </div>
      {denied && f.tasksDenied
        ? <p className="ob-muted ob-denied" id="obAgentDenied" role="note"><span id="obTasksDenied">{FORK_VIEWER_REASON}.</span></p>
        : denied ? <p className="ob-muted ob-denied" id="obAgentDenied" role="note">{denied}.</p>
          : f.tasksDenied ? <p className="ob-muted ob-denied" id="obTasksDenied" role="note">{f.tasksDenied}.</p> : null}
    </div>
  );
}

/* ---- 3a · CREATE AGENT ----------------------------------------------------- */
function StepCreateAgent({ f }: { f: Flow }) {
  const draft = f.S._agentDraft;
  const [busy, setBusy] = useState(false);
  // inline validation: which required fields were empty on the last submit
  const [errs, setErrs] = useState<Partial<Record<AgentField, true>>>({});
  const fieldRefs = useRef<Partial<Record<AgentField, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const fRef = useRef(f);
  fRef.current = f;

  // restore an in-progress draft, else seed (concierge template for the first
  // agent) — vanilla seeds + saves on step render.
  useEffect(() => {
    const cur = fRef.current;
    if (!cur.S._agentDraft) {
      cur.update((s) => {
        s._agentDraft = {
          alias: cur.first ? "atlas" : "",
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
  const clearErr = (k: AgentField) => { if (errs[k]) setErrs((e) => { const n = { ...e }; delete n[k]; return n; }); };

  const submitAgent = async () => {
    if (!f.cid) { f.toast("No workspace found yet.", "danger"); return; }
    const alias = (draft.alias || "").trim();
    const role = (draft.role || "").trim();
    const prompt = (draft.prompt || "").trim();
    const missing = missingAgentFields(draft);
    if (missing.length) {
      // inline errors + aria-invalid on each empty field; focus the first one
      setErrs(Object.fromEntries(missing.map((k) => [k, true])) as Partial<Record<AgentField, true>>);
      fieldRefs.current[missing[0]]?.focus();
      return;
    }
    setErrs({});

    // O2: optional first task — an existing ready task picked (sent as
    // initial_task_id: the server validates it and makes it in_progress + the
    // agent working in ONE transaction, never a duplicate row — P-10/P-10c), or
    // a described one (sent as initial_task, which creates it).
    let initial_task: { title: string; definition_of_done: string } | null = null;
    const rts = f.readyTasks;
    const picked = draft._firstMode === "pick" && draft._pickId ? rts.find((x) => x.id === draft._pickId) : null;
    if (!picked && draft._firstMode === "describe" && (draft._desc || "").trim()) {
      const d = draft._desc.trim();
      // honor a proposal-supplied (or typed) title so a roster kickoff keeps its
      // name; an empty title falls back to the truncated dod.
      initial_task = { title: (draft._taskTitle || "").trim() || trunc(d, 60), definition_of_done: d };
    }

    const body: Record<string, unknown> = { alias, role, kind: "ai", prompt, model: draft.model || undefined };
    if (initial_task) body.initial_task = initial_task;
    if (picked) body.initial_task_id = picked.id;

    setBusy(true);
    const res = await postJSON<{ agent_id?: string }>("/api/containers/" + encodeURIComponent(f.cid) + "/agents", body);
    if (!res.ok) {
      setBusy(false);
      // a 409 from the picked-task lock (taken / no longer ready) says why
      f.toast("Create failed (" + res.status + ")" + (res.detail ? " — " + res.detail : ""), "danger");
      return;
    }
    setBusy(false);

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

  const errText = (k: AgentField, msg: string) => errs[k] ? <div className="hint err" id={"agErr-" + k}>{msg}</div> : null;
  const invalid = (k: AgentField) => ({
    "aria-invalid": errs[k] ? true : undefined,
    "aria-describedby": errs[k] ? "agErr-" + k : undefined,
  });

  let ftBody: ReactNode;
  if (draft._firstMode === "pick") {
    // the ready list is LIVE from the snapshot (reflects tasks created earlier in
    // this flow); selection is by task ID, not a positional index (review #4).
    const rtsLive = f.readyTasks;
    ftBody = rtsLive.length ? (
      <div className="picklist" role="radiogroup" aria-label="Existing ready task">
        {rtsLive.map((t) => (
          <label key={t.id} className={"pl" + (draft._pickId === t.id ? " on" : "")} data-pickid={t.id}>
            <input type="radio" name="ftPick" checked={draft._pickId === t.id} onChange={() => setDraft((d) => { d._pickId = t.id; })} />
            <span className="grow"><span className="t1">{t.title}</span>{t.definition_of_done ? <span className="t2">{trunc(t.definition_of_done, 90)}</span> : null}</span>
          </label>
        ))}
      </div>
    ) : (
      <div className="ob-muted">No ready unassigned tasks. Switch to <b>Describe one</b>, or leave it for now.</div>
    );
  } else if (draft._firstMode === "describe") {
    ftBody = (
      <>
        <div className="field2 tight">
          <label className="lab" htmlFor="ftTitle"><span>Title</span>{walk ? null : <span className="opt">optional</span>}</label>
          <input
            className="ipt" id="ftTitle" value={draft._taskTitle || ""} autoComplete="off"
            placeholder="e.g. Stand up the migrations runner"
            onChange={(e) => setDraft((d) => { d._taskTitle = e.target.value; })}
          />
        </div>
        <div className="field2 tight last">
          <div className="lab">
            <label htmlFor="ftDesc">Done when <span className="req" aria-hidden="true">*</span></label>
            <Help text="The task's definition of done — the finish line the agent works toward. With no title, the task is named after its start." />
          </div>
          <AutoTextarea
            className={"txa" + (errs.desc ? " invalid" : "")} id="ftDesc" minRows={2} value={draft._desc}
            placeholder="e.g. Migrations run on boot without wiping the volume."
            {...invalid("desc")} inputRef={(el) => { fieldRefs.current.desc = el; }}
            onChange={(e) => { clearErr("desc"); setDraft((d) => { d._desc = e.target.value; }); }}
          />
          {errText("desc", "Say when the first task is done — or choose Not yet.")}
        </div>
      </>
    );
  } else {
    ftBody = <div className="ob-muted">No first task — brainstorm with it and create tasks together.</div>;
  }

  const title = walk ? <>Review &amp; create {draft.alias || "this agent"}</> : first ? "Create your first agent" : f.adding ? "New agent" : "Create an agent";
  const lede = walk
    ? <>From your proposed roster — edit anything before you create it.</>
    : first
      ? "Pre-filled as a concierge to brainstorm the plan with. Edit anything."
      : "Who they are, how they think, and what they pick up first.";

  return (
    <div className="ob">
      <StepHead title={title}>{lede}</StepHead>
      <div className="ob-panel">
        <div className="ob-row2">
          <div className="field2">
            <label className="lab" htmlFor="agName">Agent name <span className="req" aria-hidden="true">*</span></label>
            <input
              className={"ipt" + (errs.alias ? " invalid" : "")} id="agName" required value={draft.alias} placeholder="e.g. atlas, forge, vault"
              autoComplete="off" spellCheck={false} {...invalid("alias")} ref={(el) => { fieldRefs.current.alias = el; }}
              onChange={(e) => { clearErr("alias"); setDraft((d) => { d.alias = e.target.value; }); }}
            />
            {errText("alias", "Name the agent.")}
          </div>
          <div className="field2">
            <label className="lab" htmlFor="agRole">Role <span className="req" aria-hidden="true">*</span></label>
            <input
              className={"ipt" + (errs.role ? " invalid" : "")} id="agRole" required value={draft.role} placeholder="e.g. Concierge · planning & orchestration"
              autoComplete="off" {...invalid("role")} ref={(el) => { fieldRefs.current.role = el; }}
              onChange={(e) => { clearErr("role"); setDraft((d) => { d.role = e.target.value; }); }}
            />
            {errText("role", "Give it a role.")}
          </div>
        </div>
        <div className="field2">
          <div className="lab">
            <label htmlFor="agPrompt">System prompt <span className="req" aria-hidden="true">*</span></label>
            <Help text="The agent's standing persona — rehydrated on every wake. You can refine it later from the agent's page." />
            <span className="grow"></span>
            {first && (
              <Button
                variant="link" size="sm" icon="spark" id="agTemplate"
                onClick={() => { setDraft((d) => { d.prompt = CONCIERGE_TEMPLATE; }); f.toast("Concierge template applied — edit freely", "ok"); }}
              >Use the concierge template</Button>
            )}
          </div>
          <AutoTextarea
            className={"txa prompt" + (errs.prompt ? " invalid" : "")} id="agPrompt" required minRows={4} value={draft.prompt}
            placeholder="Describe the agent's persona, how it should behave, and its boundaries…"
            {...invalid("prompt")} inputRef={(el) => { fieldRefs.current.prompt = el; }}
            onChange={(e) => { clearErr("prompt"); setDraft((d) => { d.prompt = e.target.value; }); }}
          />
          {errText("prompt", "Write a system prompt — even one line.")}
        </div>
        <div className="field2" id="agModels">
          <div className="lab">Model <span className="req" aria-hidden="true">*</span></div>
          <ModelPicker name="agModel" models={f.models} selected={draft.model} onPick={(id) => setDraft((d) => { d.model = id; })} />
        </div>
        <div className="field2 last">
          <div className="lab"><span>First task</span><span className="opt">optional</span></div>
          <div className="firsttask">
            <FilterPills
              label="First task" size="sm" className="ftmode" value={draft._firstMode}
              onChange={(k) => { clearErr("desc"); setDraft((d) => { d._firstMode = k as AgentDraft["_firstMode"]; }); }}
              items={[
                // no count: next to a pill label it read as a step number
                { key: "pick", label: "Pick a task" },
                { key: "describe", label: "Describe one" },
                { key: "none", label: "Not yet" },
              ]}
            />
            <div className="ftbody" id="ftBody">{ftBody}</div>
          </div>
        </div>
      </div>
      <div className="form-actions">
        {f.adding
          ? <ButtonLink variant="ghost" to="/agents">Cancel</ButtonLink>
          : <Button variant="ghost" className="ob-back" icon="arrow" data-go="fork" onClick={() => f.go("fork")}>Back</Button>}
        <span className="note">Creating doesn't wake it.</span>
        <Button variant="primary" id="agCreate" icon="check" busy={busy} onClick={() => void submitAgent()}>Create {first ? "agent" : draft.alias.trim() || "agent"}</Button>
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
  // unknown model stays unknown — no "—" chip pretending to be a value
  const model = a.model || null;
  const modelName = model ? modelLabel(model, f.models) : null;

  // Path G roster walk: after each agent, drive the operator to the NEXT proposed
  // agent (re-using this same success → create-agent loop), then to the queued tasks.
  const walk = f.S._walk;
  const nextAgent = walk && walk.idx < walk.agents.length ? walk.agents[walk.idx] : null;
  const standaloneLeft = walk && walk.standalone ? walk.standalone.length : 0;
  // the walk's next step is the dominant action while a walk is running
  const walkLeads = !!(walk && (nextAgent || standaloneLeft));

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
      // the roster is finished: Continue lands on the Overview, not another
      // empty "Create an agent" form (P-27b).
      s._walkDone = true;
    });
    f.go("create-tasks");
  };

  let walkBlock: ReactNode = null;
  if (walk && nextAgent) {
    walkBlock = (
      <div className="walknext">
        <div className="wn-prog"><Icon name="spark" cls="" /><span>{walk.idx} of {walk.agents.length} agents created</span></div>
        <Button variant="primary" id="wnNext" icon="agents" iconRight="arrow" onClick={wnNext}>Next: create {nextAgent.name}</Button>
      </div>
    );
  } else if (walk && standaloneLeft) {
    walkBlock = (
      <div className="walknext">
        <div className="wn-prog"><Icon name="check" cls="" /><span>All {walk.agents.length} proposed agents created. {standaloneLeft} proposed task{standaloneLeft === 1 ? "" : "s"} left to add.</span></div>
        <Button variant="primary" id="wnTasks" icon="tasks" iconRight="arrow" onClick={wnTasks}>Add your {standaloneLeft} proposed task{standaloneLeft === 1 ? "" : "s"}</Button>
      </div>
    );
  } else if (walk) {
    walkBlock = (
      <div className="walknext done">
        <div className="wn-prog"><Icon name="check" cls="" /><span>Your roster is live — you're set up.</span></div>
        <ButtonLink href="/" icon="home" iconRight="arrow">Go to the project Overview</ButtonLink>
      </div>
    );
  }

  return (
    <div className="ob created">
      <StepHead title={<><StatusGlyph status="completed" size={20} className="ob-ok" />{alias} is ready</>}>
        {createdLede(alias, a.status, a.current_task?.title ?? null)}
      </StepHead>

      <div className="ob-panel">
        <div className="agentcard">
          <Avatar alias={alias} kind="ai" size={32} status={a.status} decorative />
          <div className="ac-meta">
            <h2>{alias} <span className="v2-sr">(AI agent)</span></h2>
            {role ? <div className="role">{role}</div> : null}
          </div>
          <div className="chips">
            <StatusIcon status={a.status} showLabel />
            {model ? <Chip size="sm" title={"Model: " + model}>{modelName}</Chip> : null}
          </div>
        </div>

        {walkBlock}

        <div className="brainstorm">
          <div className="bb">
            <h2>Brainstorm the plan with {alias}</h2>
            <p>{alias} helps break the work into tasks and proposes the rest of the team.</p>
          </div>
          <ButtonLink variant={walkLeads ? "secondary" : "primary"} icon="requests" iconRight="arrow" href={"/agents?agent=" + encodeURIComponent(alias)}>Open conversation with {alias}</ButtonLink>
        </div>

        <div className="held"><Icon name="tasks" cls="" /><span>More work for {alias}? Open a task and assign it from the task&#39;s detail. <a href="/tasks">Open Tasks</a></span></div>
      </div>

      <div className="secondary">
        <Button variant="ghost" icon="plus" data-go="create-agent" onClick={() => f.go("create-agent")}>Create another agent</Button>
        <Button variant="ghost" icon="tasks" data-go="create-tasks" onClick={() => f.go("create-tasks")}>Add tasks</Button>
        {f.adding
          ? <ButtonLink variant="ghost" icon="agents" to="/agents">Back to Agents</ButtonLink>
          : <ButtonLink variant="ghost" icon="home" href="/">Go to the project Overview</ButtonLink>}
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
      const failStatuses: number[] = [];
      for (const t of f.S.tasks) {
        const res = await postJSON(
          "/api/containers/" + encodeURIComponent(String(f.cid)) + "/tasks",
          { title: t.title, definition_of_done: t.dod, created_by_agent_id: h ? h.id : undefined },
        );
        if (!res.ok) { remaining.push(t); failStatuses.push(res.status); }
      }
      const created = f.S.tasks.length - remaining.length;
      f.update((s) => { s.tasks = remaining; });
      f.toast(
        remaining.length
          ? taskBatchFailCopy(created, remaining.length, failStatuses, f.tasksDenied)
          : created + " task" + (created === 1 ? "" : "s") + " created",
        remaining.length ? "bad" : "ok",
      );
      setBusy(false);
      if (remaining.length) return; // stay on the step so they can retry
      if (f.S._walkDone) { await finishWalk(); return; }
      f.update((s) => { s._agentDraft = null; }); // fresh create-agent draft
      await f.refreshAnd("create-agent"); // snapshot now has the new tasks → pickable
      return;
    }
    if (f.S._walkDone) { await finishWalk(); return; }
    f.update((s) => { s._agentDraft = null; });
    f.go("create-agent");
  };
  // P-27b: the roster walk is over — land on the project's Overview.
  const finishWalk = async () => {
    f.update((s) => { s._walkDone = false; s._agentDraft = null; s.step = "fork"; });
    f.toOverview();
  };
  const walkDone = !!f.S._walkDone;

  const n = f.S.tasks.length;
  return (
    <div className="ob">
      <StepHead title="Add your first tasks">Each with a clear definition of done; an agent picks them up next.</StepHead>
      {f.tasksDenied ? <p className="ob-muted ob-denied" id="obTasksDenied" role="note">{f.tasksDenied}.</p> : null}

      <div className="ob-panel">
        <div id="tqWrap">
          {n ? (
            <ol className="taskqueue" aria-label="Queued tasks">
              {f.S.tasks.map((t, i) => (
                <li className="tq" key={i}>
                  <span className="num" aria-hidden="true">{i + 1}</span>
                  <div className="grow"><div className="tt">{t.title}</div><div className="tq-dod">{t.dod}</div></div>
                  <IconButton icon="x" size="sm" label={"Remove " + t.title} data-del={i} onClick={() => f.update((s) => { s.tasks.splice(i, 1); })} />
                </li>
              ))}
            </ol>
          ) : (
            <div className="ob-muted tq-empty">No tasks yet — add your first one below.</div>
          )}
        </div>

        <div className="taskform">
          <div className="tf-h">New task</div>
          <div className="field2">
            <label className="lab" htmlFor="tkTitle">Title <span className="req" aria-hidden="true">*</span></label>
            <input className="ipt" id="tkTitle" ref={titleRef} value={title} placeholder="e.g. Persist + expose worker output" autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field2 tight">
            <label className="lab" htmlFor="tkDod">Definition of done <span className="req" aria-hidden="true">*</span></label>
            <AutoTextarea className="txa" id="tkDod" minRows={2} value={dod} placeholder="The unambiguous finish line — how you'll know it's done." onChange={(e) => setDod(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") addTask(); }} />
          </div>
          <div className="tf-actions"><span className="hint">⌘/Ctrl + Enter to add</span><Button id="tkAdd" icon="plus" onClick={addTask}>Add task</Button></div>
        </div>
      </div>

      <div className="form-actions">
        <Button variant="ghost" className="ob-back" icon="arrow" data-go="fork" onClick={() => f.go("fork")}>Back</Button>
        <span className="note" id="tkCount" aria-live="polite">{n ? n + " task" + (n === 1 ? "" : "s") + " queued" : "Nothing queued yet"}</span>
        <Button
          variant="primary" id="tkContinue" icon={walkDone ? "home" : "agents"} iconRight="arrow" busy={busy}
          disabled={!!f.tasksDenied && n > 0} title={f.tasksDenied && n > 0 ? f.tasksDenied : undefined}
          onClick={() => void cont()}
        >{walkDone ? "Continue — go to Overview" : "Continue — create an agent"}</Button>
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
      <StepHead title="Tell me what you're building">
        One or two sentences. I'll propose a team and first tasks; nothing is created until you approve.
      </StepHead>
      <div className="ob-panel">
        <div className="field2 last">
          <div className="lab">
            <label htmlFor="gGoal">Your project goal <span className="req" aria-hidden="true">*</span></label>
            <Help text="Vague is fine — I may ask 1–3 quick questions to narrow it before proposing." />
          </div>
          <AutoTextarea
            className={"txa" + (err ? " invalid" : "")} id="gGoal" inputRef={taRef} minRows={3} value={pr.goal}
            aria-invalid={err || undefined}
            placeholder="e.g. Improve my app's onboarding — I want fewer drop-offs on first run and a clearer first-task experience."
            onChange={(e) => {
              setErr(false);
              f.update((s) => {
                const p = s._propose || (s._propose = { goal: "", dialogue: [] });
                p.goal = e.target.value;
              });
            }}
          />
          {err ? <div className="hint err" role="alert">Describe your project in a sentence to continue.</div> : null}
        </div>
      </div>
      <div className="form-actions">
        <Button variant="ghost" className="ob-back" icon="arrow" data-go="fork" onClick={() => f.go("fork")}>Back</Button>
        <span className="note">You can edit everything next.</span>
        <Button variant="primary" id="gGo" icon="spark" onClick={goGo}>Propose my roster</Button>
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
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const fRef = useRef(f);
  fRef.current = f;
  // honest progress: real elapsed time of THIS stream attempt, frozen when it ends
  const [t0, setT0] = useState(() => Date.now());
  const [tNow, setTNow] = useState(() => Date.now());
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setTNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [done]);

  useEffect(() => {
    const cur = fRef.current;
    const pr = cur.S._propose;
    if (!pr || !pr.goal) { cur.go("propose-goal"); return; }
    accRef.current = "";
    setAcc("");
    setT0(Date.now());
    setTNow(Date.now());
    setDone(false);
    setTurn(null);
    setAnswers([]);
    // Open the SSE stream (fetch + ReadableStream — EventSource is GET-only, the
    // contract is POST+SSE). The abort runs on unmount/restart, which covers the
    // vanilla go()-navigation abort. The POST is deferred one macrotask so a
    // mount that is immediately torn down (React StrictMode's dev double-run,
    // or a quick Stop) never sends it — one click, one propose request.
    let abort: (() => void) | null = null;
    const startT = setTimeout(() => { abort = startPropose(
      { cid: cur.cid, goal: pr.goal, dialogue: pr.dialogue || [] },
      {
        onThinking: (d) => { accRef.current += d; setAcc(accRef.current); },
        onClarify: (questions) => { setTNow(Date.now()); setDone(true); setTurn({ kind: "clarify", questions: (questions || []).slice(0, 3) }); },
        onRoster: (payload) => {
          fRef.current.update((s) => { s._roster = normalizeRoster(payload, fRef.current.defaultModel, { aliases: true }); });
          fRef.current.go("propose-roster");
        },
        onError: (err) => { setTNow(Date.now()); setDone(true); setTurn({ kind: "error", err }); },
      },
      { demo: !!pr.demo, defaultModel: cur.defaultModel },
    ); }, 0);
    return () => {
      clearTimeout(startT);
      try { abort?.(); } catch { /* already stopped */ }
    };
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

  const elapsed = Math.max(0, tNow - t0);
  const dur = elapsed >= 1000 ? formatDuration(elapsed) : null; // never a fake "0 sec"

  let turnEl: ReactNode = null;
  let heading = "Designing your roster…";
  if (turn && turn.kind === "clarify") {
    heading = "A couple of quick questions";
    turnEl = (
      <div className="clarify">
        {turn.questions.map((q, i) => (
          <div className="field2" key={i}>
            <label className="lab" htmlFor={"clq" + i}>{q.prompt}</label>
            <input
              className="ipt" id={"clq" + i} data-qid={q.id || ""} data-qprompt={q.prompt || ""}
              placeholder="Your answer — or leave blank" autoComplete="off"
              value={answers[i] || ""}
              onChange={(e) => setAnswers((arr) => { const n = arr.slice(); n[i] = e.target.value; return n; })}
              onKeyDown={(e) => { if (e.key === "Enter" && i === turn.questions.length - 1) collect(); }}
            />
          </div>
        ))}
        <div className="cl-actions">
          <Button id="clSkip" onClick={skip}>Skip — just propose</Button>
          <Button variant="primary" id="clGo" iconRight="arrow" onClick={collect}>Continue</Button>
        </div>
      </div>
    );
  } else if (turn && turn.kind === "error") {
    heading = "Couldn't propose a roster";
    const { code, copy, detail } = proposeErrorCopy(turn.err);
    const retryable = code !== "roster_truncated";
    turnEl = (
      <div className="perror" role="alert">
        <div className="pe-msg"><Icon name="alert" cls="" /><p>{copy}</p></div>
        {detail ? <p className="pe-detail">Details: <code>{detail}</code></p> : null}
        <div className="pe-actions">
          <Button variant="ghost" data-go="fork" onClick={() => f.go("fork")}>Set up by hand instead</Button>
          <Button variant={retryable ? "secondary" : "primary"} icon="pencil" data-go="propose-goal" onClick={() => f.go("propose-goal")}>Edit goal</Button>
          {retryable && <Button variant="primary" icon="refresh" id="peRetry" onClick={retry}>Retry</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="ob propose">
      <StepHead title={heading}><span className="gp-goal">“{trunc(pr.goal, 160)}”</span></StepHead>
      <div className="ob-panel">
        {acc || !done ? (
          <div className={"thinking" + (done ? " done" : "")} id="pThink">
            <span className="v2-sr" role="status">{done ? "Finished thinking" : "Thinking"}</span>
            {/* Linear "Worked for 10 sec ▸": open while streaming, collapsed once done */}
            <WorkedFor
              key={done ? "done" : "live-" + nonce}
              running={!done}
              ms={elapsed}
              defaultOpen={!done}
              label={done
                ? (dur ? "Thought for " + dur : "Model reasoning")
                : <>Thinking{dur ? <span className="th-t"> · {dur}</span> : null}<span className="dots" aria-hidden="true"><i></i><i></i><i></i></span></>}
            >
              {acc ? <div className="th-body" id="pThinkBody" ref={bodyRef}>{acc}</div> : null}
            </WorkedFor>
          </div>
        ) : null}
        <div id="pTurn">{turnEl}</div>
      </div>
      {!done ? (
        <div className="form-actions">
          <Button variant="ghost" id="pStop" icon="stop" onClick={() => f.go("propose-goal")}>Stop</Button>
          <span className="note">Streaming from the onboarding model</span>
        </div>
      ) : null}
    </div>
  );
}

/* ---- G3 · review + edit the proposed roster, then commit (the walk) --------- */
function StepProposeRoster({ f }: { f: Flow }) {
  const r = f.S._roster;
  const bad = !r || !r.agents || !r.agents.length;
  const fRef = useRef(f);
  fRef.current = f;
  const [openAgents, setOpenAgents] = useState(true);
  const [openTasks, setOpenTasks] = useState(true);
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

  const setAssignee = (i: number, name: string | null) => f.update((s) => {
    if (!s._roster) return;
    const tt = s._roster.tasks[i];
    tt.assignee = name;
    if (!tt.assignee) tt.is_kickoff = false; // standalone tasks can't be a kickoff
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
      <StepHead title="Your proposed roster">
        Edit anything; you confirm each agent before it's created.
      </StepHead>
      {r.rationale ? <p className="rationale"><Icon name="spark" cls="" /><span>{r.rationale}</span></p> : null}

      <section className="ob-panel flush rsec" aria-label="Proposed agents">
        <GroupHeader
          level={2} title="Agents" count={r.agents.length} glyph={<Icon name="agents" cls="" />}
          open={openAgents} onToggle={() => setOpenAgents((o) => !o)} controls="rAgents"
          actions={<Button variant="ghost" size="sm" icon="plus" id="rAddAgent" onClick={() => { setOpenAgents(true); f.update((s) => { s._roster?.agents.push({ name: "", role: "", charter: "", model: f.defaultModel }); }); }}>Add agent</Button>}
        />
        <div id="rAgents" hidden={!openAgents}>
          {r.agents.map((a, i) => (
            <div className="rcard" data-aidx={i} key={i}>
              <Avatar alias={a.name || "?"} kind="ai" size={24} decorative />
              <div className="rc-body">
                <div className="rc-top">
                  <input className="ipt ghost rc-name" data-aidx={i} aria-label="Agent name" value={a.name} placeholder="Agent name" autoComplete="off" spellCheck={false} onChange={(e) => f.update((s) => { if (s._roster) renameRosterAgent(s._roster, i, e.target.value); })} />
                  <ModelSelect idx={i} models={f.models} value={a.model} onChange={(id) => f.update((s) => { if (s._roster) s._roster.agents[i].model = id; })} />
                </div>
                <AutoTextarea className="txa ghost rc-role" data-aidx={i} aria-label="Role" minRows={1} clamp={1} value={a.role} placeholder="Role — e.g. Builder · implementation" onChange={(e) => f.update((s) => { if (s._roster) s._roster.agents[i].role = e.target.value; })} />
                <AutoTextarea className="txa ghost rc-charter" data-aidx={i} aria-label="System prompt" minRows={1} clamp={2} value={a.charter} placeholder="System prompt / charter" onChange={(e) => f.update((s) => { if (s._roster) s._roster.agents[i].charter = e.target.value; })} />
              </div>
              <IconButton icon="x" size="sm" label={"Remove " + (a.name || "agent")} data-adel={i} onClick={() => delAgent(i)} />
            </div>
          ))}
        </div>
      </section>

      <section className="ob-panel flush rsec rtasks" aria-label="Proposed tasks">
        <GroupHeader
          level={2} title="Tasks" count={r.tasks.length} glyph={<Icon name="tasks" cls="" />}
          open={openTasks} onToggle={() => setOpenTasks((o) => !o)} controls="rTasks"
          actions={<Button variant="ghost" size="sm" icon="plus" id="rAddTask" onClick={() => { setOpenTasks(true); f.update((s) => { s._roster?.tasks.push({ title: "", definition_of_done: "", assignee: null, depends_on: [], protocol: null, is_kickoff: false }); }); }}>Add task</Button>}
        />
        <div id="rTasks" hidden={!openTasks}>
          {r.tasks.length ? r.tasks.map((t, i) => (
            <div className="rtask" data-tidx={i} key={i}>
              <div className="rt-top">
                <input className="ipt ghost rt-title" data-tidx={i} aria-label="Task title" value={t.title} placeholder="Task title" autoComplete="off" onChange={(e) => f.update((s) => { if (s._roster) s._roster.tasks[i].title = e.target.value; })} />
                <IconButton icon="x" size="sm" label={"Remove " + (t.title || "task")} data-tdel={i} onClick={() => f.update((s) => { s._roster?.tasks.splice(i, 1); })} />
              </div>
              <AutoTextarea className="txa ghost rt-dod" data-tidx={i} aria-label="Definition of done" minRows={1} value={t.definition_of_done} placeholder="Definition of done" onChange={(e) => f.update((s) => { if (s._roster) s._roster.tasks[i].definition_of_done = e.target.value; })} />
              <div className="rt-meta">
                <span className="rt-assign">
                  <MenuButton
                    variant="ghost" size="sm" menuLabel="Assignee" className="ob-ddl rt-assignee"
                    title={t.assignee ? "Assignee: " + t.assignee : "Unassigned — created as a ready, standalone task"}
                    value={t.assignee
                      ? <span className="rt-who"><Avatar alias={t.assignee} kind="ai" size={16} decorative />{t.assignee}</span>
                      : <span className="rt-who"><Icon name="person" cls="rt-noav" />Unassigned</span>}
                    items={[
                      { label: "Unassigned (standalone)", icon: "person", checked: !t.assignee, onSelect: () => setAssignee(i, null) },
                      ...(agentNames.length ? ["separator" as const] : []),
                      ...agentNames.map((n) => ({ label: n, checked: t.assignee === n, onSelect: () => setAssignee(i, n) })),
                    ]}
                  />
                </span>
                <label className="rt-kick" title={t.assignee ? "Make this " + t.assignee + "'s first task (kickoff)" : "Assign the task to make it a kickoff"}>
                  <input
                    type="checkbox" className="v2-checkbox v2-check-dot rt-kickoff" aria-label="First task (kickoff)" data-tidx={i} checked={!!t.is_kickoff} disabled={!t.assignee}
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
                  />Kickoff
                </label>
                {(t.depends_on || []).length ? <Chip size="sm" icon={<Icon name="link" cls="" />} title={"Depends on: " + t.depends_on.join(", ")}>after: {t.depends_on.join(", ")}</Chip> : null}
                {t.protocol ? <Chip size="sm" icon={<Icon name="flag" cls="" />}>protocol</Chip> : null}
              </div>
            </div>
          )) : (
            <div className="ob-muted rt-empty">No tasks proposed — add one, or create agents and add work later.</div>
          )}
        </div>
      </section>

      <div className="form-actions">
        <Button variant="ghost" className="ob-back" icon="arrow" data-go="propose-goal" onClick={() => f.go("propose-goal")}>Back</Button>
        <span className="note">Kickoffs become each agent's first task <Help text="Kickoff tasks become each agent's initial task; the rest are created as ready, unassigned tasks." /></span>
        <Button variant="primary" id="rCommit" icon="check" onClick={commit}>{commitLabel(r.agents.length)}</Button>
      </div>
    </div>
  );
}
