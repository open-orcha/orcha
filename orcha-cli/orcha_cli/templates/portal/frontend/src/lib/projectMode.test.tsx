/**
 * Project mode helpers + the shared useProjectMode fetch (general-mode-templates).
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_ONLY_SECTIONS, PROJECT_MODE_EVENT, autonomyDescFor, autonomyLabelFor, isSectionHidden, modeWords, normalizeMode,
  projectModeState, resetProjectModeCache, saveProjectMode, sectionsForMode, useProjectMode,
} from "./projectMode";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetProjectModeCache(); });

const SECTIONS = ["home", "tasks", "routines", "agents", "org", "requests", "code", "github", "activity", "metrics"].map((key) => ({ key }));

describe("pure helpers", () => {
  it("normalizes anything unknown to code", () => {
    expect(normalizeMode("general")).toBe("general");
    expect(normalizeMode("code")).toBe("code");
    expect(normalizeMode(undefined)).toBe("code");
    expect(normalizeMode("GENERAL")).toBe("code");
  });

  it("General hides exactly the Code and GitHub tabs, keeping order", () => {
    expect(CODE_ONLY_SECTIONS).toEqual(["code", "github"]);
    expect(sectionsForMode(SECTIONS, "code")).toBe(SECTIONS);
    expect(sectionsForMode(SECTIONS, "general").map((s) => s.key)).toEqual(
      ["home", "tasks", "routines", "agents", "org", "requests", "activity", "metrics"]);
    expect(isSectionHidden("github", "general")).toBe(true);
    expect(isSectionHidden("github", "code")).toBe(false);
    expect(isSectionHidden("tasks", "general")).toBe(false);
  });

  it("relabels Build to PR as Execute only in General", () => {
    expect(autonomyLabelFor("pr", "Build to PR", "general")).toBe("Execute");
    expect(autonomyLabelFor("pr", "Build to PR", "code")).toBe("Build to PR");
    expect(autonomyLabelFor("plan", "Plan first", "general")).toBe("Plan first");
    expect(autonomyDescFor("pr", "opens a PR", "general")).toMatch(/deliverable/);
    expect(autonomyDescFor("pr", "opens a PR", "code")).toBe("opens a PR");
    expect(autonomyDescFor("full", "x", "general")).toMatch(/human still verifies/);
  });

  it("words work as deliverables in General", () => {
    expect(modeWords("general")).toMatchObject({ deliverable: "deliverable", execute: "Execute", changesTitle: "Deliverables" });
    expect(modeWords("code")).toMatchObject({ deliverable: "pull request", execute: "Build to PR" });
    // the task / verify view's run-diff wording (never "Code changes" in General)
    expect(modeWords("general")).toMatchObject({ runChanges: "Changes", noRunChanges: "No file changes" });
    expect(modeWords("code")).toMatchObject({ runChanges: "Code changes", noRunChanges: "No code diff" });
  });

  it("an unread project is code but not known", () => {
    expect(projectModeState("c1")).toEqual({ mode: "code", known: false, profile: null, error: null });
    expect(projectModeState(null).known).toBe(false);
  });
});

function Probe({ cid }: { cid: string | null }) {
  const m = useProjectMode(cid);
  return <span data-testid={"m-" + (cid || "none")}>{m.mode}:{m.known ? "known" : "unknown"}{m.error ? ":err" : ""}</span>;
}

function stubProfile(mode: string, status = 200) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const res = (d: unknown, s = 200) => ({ ok: s < 400, status: s, json: async () => d }) as unknown as Response;
    if (method === "PUT") mode = (body as { mode: string }).mode;
    if (status !== 200) return res({ detail: "nope" }, status);
    return res({ container_id: "c1", mode, dod_presets: [], template_key: null, template_name: null, last_applied_at: null });
  }));
  return calls;
}

describe("useProjectMode", () => {
  it("fetches once per project and shares the answer", async () => {
    const calls = stubProfile("general");
    render(<><Probe cid="c1" /><Probe cid="c1" /></>);
    await waitFor(() => expect(screen.getAllByText("general:known")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(calls[0].url).toBe("/api/containers/c1/project-profile");
  });

  it("a failed read stays code, flagged, never claimed", async () => {
    stubProfile("general", 404);
    render(<Probe cid="c1" />);
    await waitFor(() => expect(screen.getByTestId("m-c1")).toHaveTextContent("code:unknown:err"));
  });

  it("no cid: no fetch", () => {
    const calls = stubProfile("general");
    render(<Probe cid={null} />);
    expect(screen.getByTestId("m-none")).toHaveTextContent("code:unknown");
    expect(calls).toHaveLength(0);
  });

  it("saveProjectMode PUTs the acting human and updates every consumer", async () => {
    const calls = stubProfile("code");
    const seen: string[] = [];
    const onEvt = (e: Event) => seen.push(String((e as CustomEvent).detail?.cid));
    window.addEventListener(PROJECT_MODE_EVENT, onEvt);
    render(<Probe cid="c1" />);
    await waitFor(() => expect(screen.getByTestId("m-c1")).toHaveTextContent("code:known"));
    await act(async () => { await saveProjectMode("c1", "general", "h1"); });
    expect(calls.find((c) => c.method === "PUT")).toEqual({
      url: "/api/containers/c1/project-profile", method: "PUT", body: { mode: "general", actor_agent_id: "h1" },
    });
    await waitFor(() => expect(screen.getByTestId("m-c1")).toHaveTextContent("general:known"));
    expect(seen).toEqual(["c1"]);
    window.removeEventListener(PROJECT_MODE_EVENT, onEvt);
  });
});
