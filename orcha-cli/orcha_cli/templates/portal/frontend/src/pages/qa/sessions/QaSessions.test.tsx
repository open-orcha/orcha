/** The Sessions view against a stubbed API: the faces of a running session, Stop, the drafting view. */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../../../components/ui";
import { QaSessions } from "../QaSessions";
import type { QaNav } from "../QaPage";
import type { QaAuthority } from "../authority";

const HUMAN: QaAuthority = { can: true, reason: null, human: { id: "h1" } } as unknown as QaAuthority;
const NOBODY: QaAuthority = { can: false, reason: "Only a person can do this", human: null } as unknown as QaAuthority;

const base = { id: "s1", kind: "explore", platform: "ios", task_id: null, agent_id: "a1", agent_alias: "forge", device_name: "iPhone 17 Pro", app_id: "com.acme", status: "running", budget_minutes: 20, goal: "Look at sign-up", report_md: null, started_at: "2026-11-04T10:00:00Z", ended_at: null, last_seen_at: null };

let detail: Record<string, unknown>;
let steps: unknown[];
let calls: { url: string; method: string; body: unknown }[];

function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  steps = [];
  detail = { ...base, walks: [], findings: [], drafts: [], verdicts: [], steps_count: 0 };
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.split("?")[0];
    if (path === "/api/qa/sessions/s1" && method === "PATCH") {
      detail = { ...detail, status: "cancelled", ended_at: "2026-11-04T10:02:00Z" };
      return jsonRes(detail);
    }
    if (path === "/api/qa/sessions/s1/keep") return jsonRes(detail);
    if (path === "/api/qa/sessions/s1/again") return jsonRes({ id: "s2", task_id: "t9", session_id: "s2" }, 201);
    if (path === "/api/qa/sessions/s1") return jsonRes(detail);
    if (path === "/api/qa/sessions/s1/steps") return jsonRes({ steps });
    if (path === "/api/containers/c1/qa/sessions") return jsonRes({ sessions: [detail] });
    if (path === "/api/containers/c1/qa/session-digests") return jsonRes({ digests: {} });
    if (path === "/api/containers/c1/qa/map") return jsonRes({ features: [{ key: "a", last_explored_at: "2026-11-01T00:00:00Z" }, { key: "b", last_explored_at: null }], nodes: [], edges: [], last_build: null });
    return jsonRes({});
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(params: Record<string, string>, auth: QaAuthority = HUMAN) {
  const runQa = vi.fn();
  const set = vi.fn();
  const nav = { platform: "ios", get: (k: string) => params[k] ?? null, set, nonce: 0, refresh: vi.fn(), runQa, auth } as unknown as QaNav;
  render(
    <ToastProvider>
      <MemoryRouter>
        <QaSessions cid="c1" nav={nav} auth={auth} />
      </MemoryRouter>
    </ToastProvider>,
  );
  return { runQa, set };
}

const page = () => waitFor(() => { const el = document.querySelector<HTMLElement>("[data-exploration-detail]"); expect(el).not.toBeNull(); return el!; });

describe("what a person keeps", () => {
  it("shows a queued session waiting for its agent, with its place in line", async () => {
    detail = { ...detail, queued_at: "2026-11-04T10:00:00Z", queue: { position: 2, waiting: "forge" } };
    mount({ session: "s1" });
    const p = await page();
    expect(p).toHaveAttribute("data-detail-face", "queued");
    expect(within(p).getAllByText("Waiting for forge").length).toBeGreaterThan(0);
    expect(within(p).getByText(/Number 2 in line/)).toBeInTheDocument();
    expect(within(p).getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("renames in place, a person's call", async () => {
    detail = { ...detail, status: "done", ended_at: "2026-11-04T10:02:00Z" };
    mount({ session: "s1" });
    const p = await page();
    fireEvent.click(within(p).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(p).getByRole("textbox", { name: "Exploration name" }), { target: { value: "Sign in pass" } });
    fireEvent.submit(within(p).getByRole("textbox", { name: "Exploration name" }).closest("form") as HTMLFormElement);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/api/qa/sessions/s1/keep") && (c.body as { name?: string }).name === "Sign in pass")).toBe(true));
    expect(await within(p).findByText("Sign in pass")).toBeInTheDocument();
  });

  it("gives no one but a person the rename", async () => {
    detail = { ...detail, status: "done", ended_at: "2026-11-04T10:02:00Z" };
    mount({ session: "s1" }, { ...HUMAN, can: false, human: null, reason: "Only a person" } as QaAuthority);
    const p = await page();
    expect(within(p).getByRole("button", { name: "Rename" })).toBeDisabled();
  });
});

describe("the home", () => {
  it("shows the live expedition, the figures and the way to start", async () => {
    const { runQa } = mount({});
    const hero = await waitFor(() => { const el = document.querySelector<HTMLElement>("[data-exploration-hero]"); expect(el).not.toBeNull(); return el!; });
    expect(within(hero).getByText("Reading now")).toBeInTheDocument();
    expect(hero.querySelector("[data-explore-stat='features']")?.textContent).toMatch(/1\s*of\s*2/);
    fireEvent.click(within(hero).getByRole("button", { name: /New exploration/ }));
    expect(runQa).toHaveBeenCalledWith("explore");
    fireEvent.click(hero.querySelector<HTMLElement>("[data-quick-start='map']")!);
    expect(runQa).toHaveBeenCalledWith("map");
  });

  it("teaches an empty project, with starting work a person's call", async () => {
    detail = { ...detail, id: "other", platform: "web" };
    mount({}, NOBODY);
    const hero = await waitFor(() => { const el = document.querySelector<HTMLElement>("[data-exploration-empty]"); expect(el).not.toBeNull(); return el!; });
    expect(hero.textContent).toMatch(/Not explored yet/);
    expect(screen.getByRole("button", { name: /New exploration/ })).toBeDisabled();
  });

  it("narrows the history with ?kind= and keeps it in the URL", async () => {
    detail = { ...detail, status: "done", ended_at: "2026-11-04T10:02:00Z" };
    const { set } = mount({ kind: "map" });
    await screen.findByText("No exploration matches these filters.");
    fireEvent.click(screen.getByRole("button", { name: /Clear/ }));
    expect(set).toHaveBeenCalledWith({ kind: null, session: null });
  });
});

describe("a running session", () => {
  it("studies until the briefing lands, then shows the charter and its findings", async () => {
    steps = [{ seq: 1, kind: "screen", args: { title: "Welcome", anchors: ["Sign in"], texts: ["Hello there, nice to see you"] }, frame_id: "fr1", screen_key: "home" }];
    mount({ session: "s1" });
    const p = await page();
    expect(p).toHaveAttribute("data-detail-face", "study");
    expect(within(p).getByText("Reading the app")).toBeInTheDocument();
    expect(await within(p).findByText("Welcome")).toBeInTheDocument();
    expect(p.querySelector("[data-work-status='running']")?.textContent).toBe("Reading");
    expect(p.querySelector("[data-phase='read']")).toHaveAttribute("data-phase-state", "active");
    cleanup();

    detail = { ...detail, briefing: { app_summary: "Notes" }, charter: [{ id: "m1", title: "Try sign-up", why: "Main door", status: "active" }, { id: "m2", title: "Try reset", why: "Risky", status: "active" }], findings: [{ id: "f1", severity: "major", title: "Save does nothing", status: "open", frame_ids: [] }], steps_count: 4 };
    mount({ session: "s1" });
    const q = await page();
    expect(q).toHaveAttribute("data-detail-face", "explore");
    expect(q.querySelector("[data-charter-item='m1']")).toHaveAttribute("aria-current", "step");
    expect(q.querySelector("[data-charter-item='m2']")).toHaveAttribute("data-charter-status", "planned");
    expect(q.querySelector("[data-budget-bar]")).not.toBeNull();
    expect(within(q).getByText("Save does nothing")).toBeInTheDocument();
    expect(within(q).getByText("4 steps · 1 finding")).toBeInTheDocument();
  });

  it("reads the session again while it runs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount({ session: "s1" });
    const p = await page();
    expect(p).toHaveAttribute("data-detail-face", "study");
    detail = { ...detail, briefing: { app_summary: "Notes" } };
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(document.querySelector("[data-exploration-detail]")).toHaveAttribute("data-detail-face", "explore"));
  });

  it("stops on a person's word, and only theirs", async () => {
    mount({ session: "s1" });
    const p = await page();
    fireEvent.click(within(p).getByRole("button", { name: "Stop" }));
    const dlg = await screen.findByRole("dialog", { name: "Stop this exploration?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Stop exploration" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/qa/sessions/s1", body: { status: "cancelled", actor_agent_id: "h1" } }));
    await waitFor(() => expect(document.querySelector("[data-exploration-detail]")).toHaveAttribute("data-detail-face", "ended"));
    expect(screen.getByText("This exploration was stopped")).toBeInTheDocument();
    cleanup();

    detail = { ...detail, status: "running", ended_at: null };
    mount({ session: "s1" }, NOBODY);
    const q = await page();
    expect(within(q).getByRole("button", { name: "Stop" })).toBeDisabled();
  });
});

describe("the other kinds", () => {
  it("runs a finished session again in its series, and moves to the queued one", async () => {
    detail = { ...detail, kind: "map", status: "done", ended_at: "2026-11-04T10:02:00Z" };
    const { set } = mount({ session: "s1" });
    const p = await page();
    fireEvent.click(within(p).getByRole("button", { name: "Run again" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ session: "s2" }));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/qa/sessions/s1/again"))).toBe(true);
  });

  it("shows a check run's verdicts", async () => {
    detail = { ...detail, kind: "check", status: "done", ended_at: "2026-11-04T10:02:00Z", verdicts: [{ id: "v1", session_id: "s1", scenario_id: "sc1", scenario_name: "Sign in", criterion_index: 0, verdict: "fail", note: "No email", frame_ids: [], created_at: "" }] };
    mount({ session: "s1" });
    const p = await page();
    expect(within(p).getByText("Criterion 1: Fail")).toBeInTheDocument();
    expect(within(p).getByText("Sign in")).toBeInTheDocument();
  });

  it("is the drafting page for a drafting session, with its drafts reviewed in place", async () => {
    detail = { ...detail, kind: "draft", status: "done", ended_at: "2026-11-04T10:02:00Z", drafts: [{ id: "d1", name: "Sign in with email", status: "draft", category: "Auth", description: "Signs in", criteria: ["It works", "It stays"], feedback: [], created_at: "2026-11-04T10:00:00Z" }, { id: "d2", name: "Reset", status: "validated", category: "Auth", description: null, criteria: ["It works", "It stays"], feedback: [], created_at: "2026-11-04T10:01:00Z" }] };
    const { runQa } = mount({ session: "s1" });
    const name = await screen.findByRole("heading", { name: "Draft scenarios" });
    expect(name).toBeInTheDocument();
    expect(document.querySelector("[data-drafting-counts]")?.textContent).toBe("2 drafted · 1 accepted");
    expect(document.querySelector("[data-draft-edit]")).toHaveAttribute("href", "/qa?view=scenarios&scenario=d1");
    fireEvent.click(screen.getByRole("button", { name: /Run what you accepted/ }));
    expect(runQa).toHaveBeenCalledWith("check", null, expect.objectContaining({ scenarioIds: expect.any(Array) }));
  });
});
