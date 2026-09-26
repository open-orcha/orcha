/**
 * GitHubAccessSection — the three states (App managed / PAT configured / not
 * configured) plus the PUT/DELETE/test wiring, mirroring
 * ProviderKeysSection.test.tsx's harness: fetch stubbed, snapshot flows
 * through the real SnapshotProvider + mapSnapshot.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";
import { GitHubAccessSection } from "./GitHubAccessSection";

interface Call { url: string; method: string; body: unknown }

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

function stubFetch(overrides: { pat?: unknown; repos?: unknown; test?: unknown } = {}): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
    if (url === "/api/github/repos") return json(overrides.repos ?? { available: false, repos: [] });
    if (url === "/api/containers/c1/settings/github-pat/test")
      return json(overrides.test ?? { ok: true, login: "kedar-gh" });
    if (url === "/api/containers/c1/settings/github-pat" && method === "GET")
      return json(overrides.pat ?? { configured: false, source: null, masked: null, set_at: null });
    if (url === "/api/containers/c1/settings/github-pat") return json({ ok: true });
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <GitHubAccessSection />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("GitHubAccessSection", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("App managed: shows the managed banner and collapses the PAT section", async () => {
    stubFetch({ repos: { available: true, source: "app", repos: [] } });
    mount();
    expect(await screen.findByText("GitHub App installation (managed)")).toBeInTheDocument();
    expect(document.querySelector("#ga-pat-details")).not.toBeNull();
    expect(screen.getByText(/Personal access token settings/)).toBeInTheDocument();
  });

  it("App managed stays inert when repos is unavailable with source pat (not app-managed)", async () => {
    stubFetch({ repos: { available: true, source: "pat", repos: [] } });
    mount();
    await waitFor(() => expect(screen.queryByText("GitHub App installation (managed)")).not.toBeInTheDocument());
  });

  it("local-only availability (source null, no token) is NOT app-managed — the PAT input stays visible", async () => {
    // A token-less stack with a mounted local tree returns available:true via the
    // prepended "local" repo entry and source:null. That must not paint the managed
    // banner or collapse the PAT section — it's exactly the stack that needs a token.
    stubFetch({ repos: { available: true, source: null, repos: [{ full_name: "local" }] } });
    mount();
    await waitFor(() => expect(screen.queryByText("GitHub App installation (managed)")).not.toBeInTheDocument());
    expect(document.querySelector("#ga-pat-details")).toBeNull();
    expect(await screen.findByPlaceholderText(/Paste a GitHub personal access token/)).toBeInTheDocument();
  });

  it("PAT configured (db): masked value, set_at, Test/Replace/Remove", async () => {
    stubFetch({
      pat: { configured: true, source: "db", masked: "ghp_...abcd", set_at: new Date().toISOString() },
    });
    mount();
    expect(await screen.findByText("Personal access token configured")).toBeInTheDocument();
    expect(screen.getByText("ghp_...abcd")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replace token/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Test$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste a new token to replace…")).toBeInTheDocument();
  });

  it("PAT configured (env): shadow message, no Replace/Remove, env hint shown", async () => {
    stubFetch({ pat: { configured: true, source: "env", masked: "ghp_...envv", set_at: null } });
    mount();
    expect(await screen.findByText(/using ORCHA_GITHUB_PAT from the environment/)).toBeInTheDocument();
    expect(screen.getByText("ghp_...envv")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Replace token/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/ORCHA_GITHUB_PAT/).length).toBeGreaterThan(0);
  });

  it("Not configured: paste field, Create-a-token link, Save + Test-before-save", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("No personal access token configured.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "create a token" });
    expect(link).toHaveAttribute("href", "https://github.com/settings/tokens");
    const codes = [...document.querySelectorAll(".sc-hint code")].map((c) => c.textContent);
    expect(codes).toContain("repo");
    expect(codes).toContain("gh auth token | pbcopy");
    expect(screen.getByPlaceholderText("Paste a GitHub personal access token…")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /Save token/ });
    const test = screen.getByRole("button", { name: /^Test$/ });
    expect(save).toBeDisabled();
    expect(test).toBeDisabled();
  });

  it("Save PUTs {token, actor_agent_id} to …/settings/github-pat (byte-exact body)", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("No personal access token configured.");
    fireEvent.change(screen.getByPlaceholderText("Paste a GitHub personal access token…"), {
      target: { value: "ghp_newtoken123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save token/ }));
    await waitFor(() => {
      const put = calls.find((c) => c.url === "/api/containers/c1/settings/github-pat" && c.method === "PUT");
      expect(put).toBeTruthy();
      expect(put!.body).toEqual({ token: "ghp_newtoken123", actor_agent_id: "h1" });
    });
    await waitFor(() => {
      const gets = calls.filter((c) => c.url === "/api/containers/c1/settings/github-pat" && c.method === "GET");
      expect(gets.length).toBeGreaterThan(1);
    });
  });

  it("Test POSTs to …/github-pat/test — pasted token rides in the body, stored token omits it", async () => {
    const calls = stubFetch({
      pat: { configured: true, source: "db", masked: "ghp_...abcd", set_at: null },
      test: { ok: true, login: "kedar-gh" },
    });
    mount();
    await screen.findByText("Personal access token configured");
    fireEvent.click(screen.getByRole("button", { name: /^Test$/ }));
    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/containers/c1/settings/github-pat/test" && c.method === "POST");
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ actor_agent_id: "h1" });
    });
    const result = await waitFor(() => {
      const el = document.querySelector(".sc-result.ok");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(within(result).getByText(/Token is valid/)).toBeInTheDocument();
  });

  it("Test with a failing token toasts and renders the fail detail", async () => {
    stubFetch({
      pat: { configured: true, source: "db", masked: "ghp_...abcd", set_at: null },
      test: { ok: false, detail: "Bad credentials" },
    });
    mount();
    await screen.findByText("Personal access token configured");
    fireEvent.click(screen.getByRole("button", { name: /^Test$/ }));
    const result = await waitFor(() => {
      const el = document.querySelector(".sc-result.err");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(within(result).getByText("Bad credentials")).toBeInTheDocument();
  });

  it("Remove DELETEs …/settings/github-pat with {actor_agent_id} after confirm", async () => {
    const calls = stubFetch({ pat: { configured: true, source: "db", masked: "ghp_...abcd", set_at: null } });
    mount();
    await screen.findByText("Personal access token configured");
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    // confirm modal
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Remove token/ }));
    await waitFor(() => {
      const del = calls.find((c) => c.url === "/api/containers/c1/settings/github-pat" && c.method === "DELETE");
      expect(del).toBeTruthy();
      expect(del!.body).toEqual({ actor_agent_id: "h1" });
    });
  });
});
