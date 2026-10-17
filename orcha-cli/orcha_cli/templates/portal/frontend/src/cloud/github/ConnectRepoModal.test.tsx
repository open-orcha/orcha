/**
 * ConnectRepoModal — the two-section repo picker (Orcha Cloud local run,
 * Addendum 2). Renders "This machine" (the prepended local entry) and
 * "GitHub" (whatever the App/PAT listing sends) from a stubbed
 * /api/github/repos, PUTs the chosen binding, and shows the Settings hint
 * when no GitHub access is configured.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { ConnectRepoModal } from "./ConnectRepoModal";

interface Call { url: string; method: string; body: unknown }

function stubFetch(reposPayload: unknown, putStatus = 200): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/github/repos")) return json(reposPayload);
    if (url === "/api/containers/c1/github" && method === "PUT") return json({ repo: (init && JSON.parse(String(init.body)).repo) || null }, putStatus);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount(overrides: Partial<Parameters<typeof ConnectRepoModal>[0]> = {}) {
  const onClose = vi.fn();
  const onBound = vi.fn();
  render(
    <ToastProvider>
      <MemoryRouter>
        <ConnectRepoModal cid="c1" onClose={onClose} onBound={onBound} {...overrides} />
      </MemoryRouter>
    </ToastProvider>,
  );
  return { onClose, onBound };
}

describe("ConnectRepoModal", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the prepended local entry under 'This machine' with the folder caption", async () => {
    stubFetch({
      available: true,
      source: "pat",
      repos: [
        { full_name: "local", name: "acme-ehr", source_kind: "local" },
        { full_name: "acme/app", private: false, description: "the app" },
      ],
    });
    mount();
    expect(await screen.findByText("This machine")).toBeInTheDocument();
    expect(screen.getByText("acme-ehr")).toBeInTheDocument();
    expect(screen.getByText("Local git repository — works offline, no GitHub needed")).toBeInTheDocument();
    // GitHub section renders the rest of the list, local entry excluded from it
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("acme/app")).toBeInTheDocument();
    expect(screen.getByText("the app")).toBeInTheDocument();
  });

  it("offers NO local row when the backend has no local entry (would 400) — parity extra", async () => {
    stubFetch({ available: false, repos: [] });
    mount({ fallbackLocalName: "acme-ehr" });
    expect(await screen.findByText("No GitHub access configured yet.")).toBeInTheDocument();
    expect(screen.queryByText("This machine")).toBeNull();
    expect(screen.queryByText("acme-ehr")).toBeNull();
  });

  it("keeps the local row visible when the project is already bound local", async () => {
    stubFetch({ available: false, repos: [] });
    mount({ fallbackLocalName: "acme-ehr", currentRepo: "local" });
    expect(await screen.findByText("This machine")).toBeInTheDocument();
    expect(screen.getByText("acme-ehr").closest("button")!).toHaveTextContent("Connected");
  });

  it("choosing the local entry PUTs {repo: 'local'} and reports the binding", async () => {
    const calls = stubFetch({ available: true, repos: [{ full_name: "local", name: "acme-ehr", source_kind: "local" }] });
    const { onBound, onClose } = mount();
    await screen.findByText("This machine");
    fireEvent.click(screen.getByText("acme-ehr"));
    await waitFor(() => expect(onBound).toHaveBeenCalledWith("local"));
    const put = calls.find((c) => c.url === "/api/containers/c1/github" && c.method === "PUT");
    expect(put).toBeTruthy();
    expect(put!.body).toEqual({ repo: "local" });
    expect(onClose).toHaveBeenCalled();
  });

  it("choosing a GitHub repo PUTs {repo: 'owner/name'}", async () => {
    const calls = stubFetch({ available: true, source: "app", repos: [{ full_name: "acme/app" }] });
    const { onBound } = mount();
    await screen.findByText("acme/app");
    fireEvent.click(screen.getByText("acme/app"));
    await waitFor(() => expect(onBound).toHaveBeenCalledWith("acme/app"));
    const put = calls.find((c) => c.url === "/api/containers/c1/github" && c.method === "PUT");
    expect(put!.body).toEqual({ repo: "acme/app" });
  });

  it("no-token empty state deep-links Settings → Integrations (GH-035)", async () => {
    stubFetch({ available: false, repos: [] });
    mount();
    expect(await screen.findByText("No GitHub access configured yet.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Settings → Integrations" });
    expect(link.getAttribute("href")).toBe("/settings#tab=github-access");
  });

  it("a local-only listing (available:true, no source) still reads as no GitHub access", async () => {
    stubFetch({ available: true, repos: [{ full_name: "local", name: "w", source_kind: "local" }] });
    mount();
    expect(await screen.findByText("No GitHub access configured yet.")).toBeInTheDocument();
  });

  it("blockedReason disables every row and names why (e2e-permissions-16)", async () => {
    const calls = stubFetch({ available: true, source: "app", repos: [{ full_name: "local", name: "w", source_kind: "local" }, { full_name: "acme/app" }] });
    mount({ blockedReason: "Your role is viewer (read-only)" });
    await screen.findByText("acme/app");
    expect(screen.getByText(/Your role is viewer \(read-only\) — ask an owner/)).toBeInTheDocument();
    expect(screen.getByText("acme/app").closest("button")!).toBeDisabled();
    expect(screen.getByText("w").closest("button")!).toBeDisabled();
    fireEvent.click(screen.getByText("acme/app"));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a 422 array detail never toasts [object Object]", async () => {
    stubFetch({ available: true, source: "app", repos: [{ full_name: "acme/app" }] }, 422);
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/github/repos")) return { ok: true, status: 200, json: async () => ({ available: true, source: "app", repos: [{ full_name: "acme/app" }] }) } as unknown as Response;
      if (init?.method === "PUT") return { ok: false, status: 422, json: async () => ({ detail: [{ msg: "bad", type: "string_pattern_mismatch" }] }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    mount();
    fireEvent.click(await screen.findByText("acme/app"));
    expect(await screen.findByText("Couldn't connect the repo: That repository name isn't valid.")).toBeInTheDocument();
    expect(screen.queryByText(/object Object/)).toBeNull();
  });

  it("keeps the existing empty-state copy when a token IS configured but lists no repos", async () => {
    stubFetch({ available: true, source: "pat", repos: [] });
    mount();
    expect(await screen.findByText("No repositories found for the active GitHub access.")).toBeInTheDocument();
  });

  it("marks the currently-bound repo as Connected", async () => {
    stubFetch({ available: true, source: "app", repos: [{ full_name: "acme/app" }, { full_name: "acme/lib" }] });
    mount({ currentRepo: "acme/lib" });
    await screen.findByText("acme/lib");
    const row = screen.getByText("acme/lib").closest("button")!;
    expect(row).toHaveTextContent("Connected");
  });
});
