/**
 * "Start from a template": gallery → choose → review (server preview) → apply →
 * result; the stale-plan 409; the authority gates (viewer; manage_agents without
 * manage_autonomy); ProjectModeSection's mode switch.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../../components/ui";
import { extensions, type Identity } from "../../../extensions";
import { SnapshotProvider } from "../../../state/SnapshotProvider";
import { resetIdentity } from "../../../cloud/identity";
import { resetProjectModeCache } from "../../../lib/projectMode";
import { SETTINGS_GRANT_REASON } from "../../settings/grantAuthority";
import { TemplateApplyFlow, defaultSelection } from "./TemplateApplyFlow";
import { ProjectModeSection } from "./ProjectModeSection";
import { applyLabel, prettyRoutineTitle, type TemplateFull, type TemplatePlan } from "./templatesApi";

interface Call { url: string; method: string; body: any }
let calls: Call[] = [];
let mode = "code";
let applyMode: "ok" | "stale" | "partial" = "ok";
const HUMAN = { id: "h1", alias: "kedar", kind: "human", status: "active" };
const ORIG_IDENTITY = extensions.identity;
const ORIG_TRUSTED = extensions.identityTrusted;

const FULL: TemplateFull = {
  key: "marketing-team", version: 1, name: "Marketing team", mode: "general",
  summary: "Plan campaigns, write content.",
  roles: [
    { key: "lead", alias: "marketing-lead", role: "Marketing lead", reports_to: null, prompt: "You are the Marketing lead…" },
    { key: "content", alias: "content-writer", role: "Content writer", reports_to: "lead", prompt: "You are the Content writer…" },
  ],
  routines: [{ key: "content-calendar", title: "Content calendar {{date}}", description: "d", definition_of_done: "dod", cron: "0 9 * * 1", assignee: "lead", priority: 100 }],
  dod_presets: [{ key: "blog-post", label: "Blog post", text: "800 words" }],
  objective_examples: ["Launch the new tier", "Double organic traffic"],
};

function planFor(body: any, fp = "fp-1"): TemplatePlan {
  const roles = FULL.roles.filter((r) => (body.roles ?? FULL.roles.map((x) => x.key)).includes(r.key));
  return {
    template: { key: FULL.key, version: 1, name: FULL.name, mode: "general" },
    agents: roles.map((r) => ({ key: r.key, alias: r.alias, role: r.role, action: "create", reason: null })),
    reporting: roles.map((r) => ({ alias: r.alias, reports_to: r.reports_to ? "marketing-lead" : "kedar" })),
    routines: (body.routines ?? ["content-calendar"]).map((k: string) => ({
      key: k, title: "Content calendar {{date}}", definition_of_done: "dod", cron: "0 9 * * 1", timezone: body.timezone,
      schedule_text: "Every Monday at 09:00", assignee_alias: "marketing-lead", assignee_note: null, enabled: body.enable_routines,
      action: "create", reason: null })),
    mode: { from: "code", to: body.set_mode ? "general" : "code", change: !!body.set_mode },
    dod_presets: body.dod_presets ? [{ key: "blog-post", name: "Blog post", body: "800 words", action: "create", reason: null }] : [],
    objective: body.objective ? { from: null, to: body.objective } : null,
    counts: { agents_to_create: roles.length, routines_to_create: (body.routines ?? ["x"]).length, dod_presets_to_add: body.dod_presets ? 1 : 0, skipped: 0 },
    plan_fingerprint: fp,
  };
}

function install() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1") return res({ container: { id: "c1", name: "Orcha", status: "active" }, agents: [HUMAN], tasks: [], requests: [] });
    if (url.startsWith("/api/me")) return res({ identity: null, trusted: false });
    if (url === "/api/prefs") return res({ prefs: null });
    if (url === "/api/containers/c1/project-profile") {
      if (method === "PUT") mode = body.mode;
      return res({ container_id: "c1", mode, dod_presets: [], template_key: null, template_name: null, last_applied_at: null });
    }
    if (url === "/api/project-templates") {
      return res({ modes: ["code", "general"], templates: [
        { key: "software-team", version: 1, name: "Software team", mode: "code", summary: "Engineers.", roles: [{ key: "lead", alias: "tech-lead", role: "Tech lead" }], routine_count: 2, dod_preset_count: 3, objective_examples: [] },
        { key: "marketing-team", version: 1, name: "Marketing team", mode: "general", summary: "Plan campaigns, write content.", roles: FULL.roles, routine_count: 1, dod_preset_count: 1, objective_examples: FULL.objective_examples },
      ] });
    }
    if (url === "/api/project-templates/marketing-team") return res(FULL);
    if (url === "/api/containers/c1/templates/marketing-team/preview") return res(planFor(body));
    if (url === "/api/containers/c1/templates/marketing-team/apply") {
      if (applyMode === "stale") {
        applyMode = "ok";
        const fresh = planFor(body, "fp-2");
        fresh.agents[0] = { ...fresh.agents[0], action: "reuse", reason: "already on the roster — kept as is" };
        fresh.counts.agents_to_create -= 1;
        return res({ detail: { message: "the project changed since this preview", plan: fresh } }, 409);
      }
      const failed = applyMode === "partial";
      return res({
        application_id: "a1", ok: !failed, template: { key: "marketing-team", version: 1, name: "Marketing team", mode: "general" },
        result: {
          agents: [{ alias: "marketing-lead", status: "created" }, { alias: "content-writer", status: "created" }],
          reporting: [], dod_presets: [{ name: "Blog post", status: "created" }],
          routines: [failed ? { title: "Content calendar {{date}}", status: "failed", reason: "schedule refused" }
            : { title: "Content calendar {{date}}", status: "created", enabled: false }],
          mode: body.set_mode ? { from: "code", to: "general" } : null, objective: body.objective ?? null,
          failures: failed ? ["routine Content calendar {{date}}: schedule refused"] : [],
        },
      }, 201);
    }
    return res({});
  }));
}

function asIdentity(id: Identity | null, trusted = true) {
  extensions.identity = async () => id;
  extensions.identityTrusted = () => trusted;
}

function renderFlow(props: Partial<Parameters<typeof TemplateApplyFlow>[0]> = {}) {
  const onDone = vi.fn();
  render(
    <ToastProvider><SnapshotProvider><MemoryRouter>
      <TemplateApplyFlow cid="c1" onDone={onDone} {...props} />
    </MemoryRouter></SnapshotProvider></ToastProvider>,
  );
  return { onDone };
}

const post = (suffix: string) => calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));

beforeEach(() => {
  localStorage.clear();
  resetIdentity();
  resetProjectModeCache();
  extensions.identity = undefined;
  extensions.identityTrusted = undefined;
  mode = "code";
  applyMode = "ok";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  extensions.identity = ORIG_IDENTITY;
  extensions.identityTrusted = ORIG_TRUSTED;
});

async function pickMarketing() {
  fireEvent.click(await screen.findByRole("button", { name: /Marketing team/ }));
  await screen.findByRole("heading", { name: "Marketing team" });
}

describe("TemplateApplyFlow", () => {
  it("pure: routine tokens read as placeholders", () => {
    expect(prettyRoutineTitle("Report {{date}} at {{ time }}")).toBe("Report ‹date› at ‹time›");
    expect(prettyRoutineTitle("{{unknown}}")).toBe("{{unknown}}");
  });

  it("pure: applyLabel states the exact consequence; defaults select everything", () => {
    expect(applyLabel({ agents_to_create: 5, routines_to_create: 2, dod_presets_to_add: 4, skipped: 0 })).toBe("Create 5 agents, 2 routines and 4 presets");
    expect(applyLabel({ agents_to_create: 1, routines_to_create: 0, dod_presets_to_add: 0, skipped: 3 })).toBe("Create 1 agent");
    expect(applyLabel({ agents_to_create: 0, routines_to_create: 0, dod_presets_to_add: 0, skipped: 3 })).toBe("Apply template");
    const d = defaultSelection(FULL, "code");
    expect(d).toMatchObject({ roles: ["lead", "content"], routines: ["content-calendar"], enable_routines: false, set_mode: true, dod_presets: true, objective: null });
    expect(defaultSelection(FULL, "general").set_mode).toBe(false);
  });

  it("gallery → choose → review → apply, creating nothing before the confirm", async () => {
    install();
    const { onDone } = renderFlow();
    const gallery = await screen.findByRole("list", { name: "Templates" });
    expect(within(gallery).getByText("Software team")).toBeInTheDocument();
    expect(within(gallery).getByText(/2 agents · 1 routine · 1 done-criteria presets/)).toBeInTheDocument();
    await pickMarketing();
    // objective example fills the field
    fireEvent.click(screen.getByRole("button", { name: "Launch the new tier" }));
    expect((document.getElementById("tplObjective") as HTMLTextAreaElement).value).toBe("Launch the new tier");
    // drop the content writer
    fireEvent.click(document.querySelector('[data-role="content"]') as HTMLInputElement);
    expect(screen.getByText("Created paused — turn them on in Routines.")).toBeInTheDocument();
    expect((document.getElementById("tplMode") as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect((document.getElementById("tplReview") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(document.getElementById("tplReview") as HTMLElement); });
    // review = the server's plan
    await screen.findByRole("heading", { name: "Review: Marketing team" });
    const pv = post("/preview")[0].body;
    expect(pv).toMatchObject({ roles: ["lead"], routines: ["content-calendar"], enable_routines: false, set_mode: true, dod_presets: true, objective: "Launch the new tier", actor_agent_id: "h1" });
    expect(post("/apply")).toHaveLength(0);
    expect(document.querySelector('[data-plan-agent="marketing-lead"]')).toHaveTextContent("reports to kedar");
    expect(document.querySelector('[data-plan-agent="content-writer"]')).toBeNull();
    expect(document.querySelector('[data-plan-mode="general"]')).toHaveTextContent("Code → General");
    const apply = await screen.findByRole("button", { name: "Create 1 agent, 1 routine and 1 preset" });
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(apply); });
    await screen.findByRole("heading", { name: "Marketing team applied" });
    expect(post("/apply")[0].body).toMatchObject({ confirm: true, plan_fingerprint: "fp-1", roles: ["lead"], set_mode: true, actor_agent_id: "h1" });
    expect(screen.getByText("Content calendar ‹date› (paused)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a stale review is replaced by the server's fresh plan, and nothing is applied until confirmed again", async () => {
    install();
    applyMode = "stale";
    renderFlow({ initialKey: "marketing-team" });
    await screen.findByRole("heading", { name: "Marketing team" });
    await waitFor(() => expect((document.getElementById("tplReview") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(document.getElementById("tplReview") as HTMLElement); });
    const first = await screen.findByRole("button", { name: "Create 2 agents, 1 routine and 1 preset" });
    await waitFor(() => expect((first as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(first); });
    expect(await screen.findByText(/The project changed since you opened this review/)).toBeInTheDocument();
    expect(document.querySelector('[data-plan-agent="marketing-lead"]')).toHaveAttribute("data-action", "reuse");
    const again = screen.getByRole("button", { name: "Create 1 agent, 1 routine and 1 preset" });
    await act(async () => { fireEvent.click(again); });
    await screen.findByRole("heading", { name: "Marketing team applied" });
    expect(post("/apply").map((c) => c.body.plan_fingerprint)).toEqual(["fp-1", "fp-2"]);
  });

  it("a partial failure is shown, not hidden", async () => {
    install();
    applyMode = "partial";
    renderFlow({ initialKey: "marketing-team" });
    await screen.findByRole("heading", { name: "Marketing team" });
    await waitFor(() => expect((document.getElementById("tplReview") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(document.getElementById("tplReview") as HTMLElement); });
    const btn = await screen.findByRole("button", { name: /^Create/ });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(btn); });
    await screen.findByRole("heading", { name: "Marketing team applied with problems" });
    expect(screen.getByRole("alert")).toHaveTextContent("1 item failed — everything else was created");
    expect(document.querySelector('[data-status="failed"]')).toHaveTextContent("schedule refused");
  });

  it("a viewer can look and review but never apply", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderFlow({ initialKey: "marketing-team" });
    await screen.findByRole("heading", { name: "Marketing team" });
    await act(async () => { fireEvent.click(document.getElementById("tplReview") as HTMLElement); });
    const btn = await screen.findByRole("button", { name: /^Create/ });
    await waitFor(() => expect(document.getElementById("tplDenied")).toHaveTextContent("Your role is viewer (read-only)"));
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(post("/apply")).toHaveLength(0);
  });

  it("manage_agents without manage_autonomy: the mode stays, and set_mode is never sent", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_agents"] });
    renderFlow({ initialKey: "marketing-team" });
    await screen.findByRole("heading", { name: "Marketing team" });
    await waitFor(() => expect(document.getElementById("tplModeDenied")).toHaveTextContent(SETTINGS_GRANT_REASON.manage_autonomy));
    expect(document.getElementById("tplMode")).toBeNull();
    await act(async () => { fireEvent.click(document.getElementById("tplReview") as HTMLElement); });
    await screen.findByRole("heading", { name: "Review: Marketing team" });
    expect(post("/preview")[0].body.set_mode).toBe(false);
  });

  it("Review is disabled when nothing at all is picked", async () => {
    install();
    mode = "general";
    renderFlow({ initialKey: "marketing-team" });
    await screen.findByRole("heading", { name: "Marketing team" });
    for (const el of document.querySelectorAll<HTMLInputElement>("[data-role],[data-routine]")) fireEvent.click(el);
    fireEvent.click(document.getElementById("tplPresets") as HTMLElement);
    await waitFor(() => expect((document.getElementById("tplReview") as HTMLButtonElement).disabled).toBe(true));
  });
});

describe("ProjectModeSection", () => {
  function renderSection() {
    render(<ToastProvider><SnapshotProvider><MemoryRouter><ProjectModeSection cid="c1" /></MemoryRouter></SnapshotProvider></ToastProvider>);
  }

  it("an owner switches the work type with one PUT", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "owner", grants: [] });
    renderSection();
    const general = await screen.findByRole("radio", { name: "General" });
    await waitFor(() => expect((general as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("radio", { name: "Code" })).toHaveAttribute("aria-checked", "true");
    await act(async () => { fireEvent.click(general); });
    await waitFor(() => expect(screen.getByRole("radio", { name: "General" })).toHaveAttribute("aria-checked", "true"));
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { url: "/api/containers/c1/project-profile", method: "PUT", body: { mode: "general", actor_agent_id: "h1" } },
    ]);
    expect(await screen.findByText("Switched to General — Code and GitHub tabs are hidden.")).toBeInTheDocument();
  });

  it("a viewer sees it locked and nothing is written", async () => {
    install();
    asIdentity({ agent_id: "h1", alias: "kedar", member_role: "viewer", grants: [] });
    renderSection();
    const general = await screen.findByRole("radio", { name: "General" });
    await waitFor(() => expect((general as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(general);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect((document.getElementById("setApplyTemplate") as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the template dialog for an existing project", async () => {
    install();
    renderSection();
    const btn = await screen.findByRole("button", { name: "Apply a template…" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog", { name: "Apply a template" });
    expect(await within(dlg).findByRole("list", { name: "Templates" })).toBeInTheDocument();
  });
});
