/**
 * Parity r3 extra: on /projects with ZERO memberships there is no project to ask
 * /api/me about, so nothing knew there was a sign-in and Sign out was nowhere.
 * The empty state offers it when oauth2-proxy confirms a session
 * (GET /oauth2/userinfo); a self-host portal (no proxy) shows no Sign out.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { _resetProjectsForTests } from "../../state/projects";
import { resetIdentity } from "../identity";
import { ProjectsPage } from "./ProjectsPage";
import * as prefs from "./prefs";

vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ snap: null, cid: null, multi: false, refresh: async () => {} }),
  actingHuman: () => null,
  setActingHuman: () => {},
}));
vi.mock("../../state/attention", () => ({
  useAttention: () => ({ items: [], count: null, partial: false, followUps: [], readOnly: false }),
}));

const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
let userinfo: Response | null = null;
let calls: string[] = [];

beforeEach(() => {
  localStorage.clear();
  prefs._resetForTests();
  _resetProjectsForTests();
  resetIdentity();
  userinfo = null;
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "/oauth2/userinfo") return userinfo ?? json({ detail: "Not Found" }, 404);
    if (url === "/api/prefs") return json({ prefs: null });
    if (url === "/api/containers") return json({ containers: [] });
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const mount = () => render(<ToastProvider><MemoryRouter><ProjectsPage /></MemoryRouter></ToastProvider>);

describe("zero memberships: Sign out stays reachable", () => {
  it("signed in via the proxy → the empty state links Sign out", async () => {
    userinfo = json({ user: "stranger-x", email: "x@example.com" });
    mount();
    await screen.findByText("No projects yet");
    const out = await screen.findByRole("link", { name: "Sign out" });
    expect(out.getAttribute("href")).toBe("/oauth2/sign_out?rd=%2Fwelcome");
    expect(screen.getAllByRole("button", { name: "New project" }).length).toBeGreaterThan(0);
  });
  it("self-host (userinfo 404 / HTML) → no Sign out", async () => {
    mount();
    await screen.findByText("No projects yet");
    await waitFor(() => expect(calls).toContain("/oauth2/userinfo"));
    expect(screen.queryByRole("link", { name: "Sign out" })).toBeNull();
  });
  it("an SPA HTML fallback (200, not JSON) is not a session", async () => {
    userinfo = { ok: true, status: 200, json: async () => { throw new Error("html"); } } as unknown as Response;
    mount();
    await screen.findByText("No projects yet");
    await waitFor(() => expect(calls).toContain("/oauth2/userinfo"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("link", { name: "Sign out" })).toBeNull();
  });
});
