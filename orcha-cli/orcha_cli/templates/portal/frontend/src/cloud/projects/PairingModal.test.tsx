/**
 * PairingPanel V2 states: a warning offers a real "Check again" (re-runs the
 * cid-scoped GET), the choose-human state is a plain labelled select, and the
 * expiry line is neutral (amber only in its last 30 s).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairingPanel, pairingErrorView } from "./PairingModal";

function stub(responses: { status: number; body: unknown }[]) {
  const calls: string[] = [];
  let i = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("PairingPanel", () => {
  it("a warning has a Check again button that re-requests pairing", async () => {
    const calls = stub([
      { status: 409, body: { detail: { reachable: false, reason: "no_lan_address", title: "Phones can't reach this Embodent yet", message: "No LAN address" } } },
      { status: 200, body: { baseUrl: "http://10.0.0.2:8765", shortCode: "ABC-123", expiresAt: new Date(Date.now() + 5 * 60e3).toISOString(), humanAgentAlias: "kedar" } },
    ]);
    render(<PairingPanel cid="c1" identity={null} />);
    fireEvent.click(await screen.findByRole("button", { name: /Check again/ }));
    await waitFor(() => expect(calls.filter((u) => u.startsWith("/api/containers/c1/pairing")).length).toBe(2));
    expect(await screen.findByText("ABC-123")).toBeInTheDocument();
    const exp = document.getElementById("pairCountdown")!;
    expect(exp.className).not.toMatch(/s-warn|is-urgent/); // neutral with minutes left
  });

  it("choose_human renders a labelled select (no warning chrome) and pairs as the chosen human", async () => {
    const calls = stub([
      { status: 400, body: { detail: { reason: "choose_human", humans: [{ id: "h1", alias: "kedar" }, { id: "h2", alias: "sam" }] } } },
      { status: 200, body: { shortCode: "XYZ", expiresAt: new Date(Date.now() + 20e3).toISOString() } },
    ]);
    render(<PairingPanel cid="c1" identity={null} />);
    const sel = await screen.findByLabelText("Pair as");
    expect(document.querySelector(".pair-warning")).toBeNull();
    fireEvent.change(sel, { target: { value: "h2" } });
    await waitFor(() => expect(calls).toContain("/api/containers/c1/pairing?human_agent_id=h2"));
    await screen.findByText("XYZ");
    // last 30 s: amber
    await waitFor(() => expect(document.getElementById("pairCountdown")!.className).toMatch(/is-urgent/));
  });

  it("DP-ERR-1: a 403 reads 'no access' — no reachability title, no Wi-Fi hint, no retry; the raw text only under Details", async () => {
    stub([{ status: 403, body: { detail: "your GitHub account ('stranger') is not a member of this project — ask an owner for an invite" } }]);
    render(<PairingPanel cid="c1" identity={null} />);
    expect(await screen.findByText("You don't have access to pair a phone for this project.")).toBeInTheDocument();
    expect(screen.queryByText(/Phones can't reach/)).toBeNull();
    expect(screen.queryByText(/same Wi-Fi/)).toBeNull();
    expect(screen.queryByRole("button", { name: /again/ })).toBeNull();
    const det = document.querySelector("#pairBody details")!;
    expect(det).not.toHaveAttribute("open");
    expect(det.textContent).toMatch(/HTTP 403 · your GitHub account/);
  });

  it("DP-ERR-1: 404 / 503 / network never show the raw detail as the message (no internal host leak)", async () => {
    stub([{ status: 503, body: { detail: "project database unreachable: connection refused (host data-ingestion-pipeline-v2-db:5432)" } }]);
    render(<PairingPanel cid="c1" identity={null} />);
    expect(await screen.findByText("Couldn't load the pairing code")).toBeInTheDocument();
    expect(document.querySelector(".pair-warning > p")!.textContent).not.toMatch(/data-ingestion|5432/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText(/same Wi-Fi/)).toBeNull();
    expect(pairingErrorView(404, "mock: not implemented /api/containers/x/pairing")).toMatchObject({ title: "Project not found", retry: false, wifiHint: false });
    expect(pairingErrorView(null, null, "Failed to fetch")).toMatchObject({ title: "Couldn't load the pairing code", retry: true, details: "Failed to fetch" });
    // the no_human 409 keeps its own title and no Wi-Fi hint
    expect(pairingErrorView(409, { reachable: false, reason: "no_human", title: "No human can pair this phone", message: "Add a human" }))
      .toMatchObject({ title: "No human can pair this phone", wifiHint: false });
  });

  it("shell r2: 'Pairing as' shows the GitHub login (old-UI parity) with the project alias muted beside it", async () => {
    stub([{ status: 200, body: { baseUrl: "http://10.0.0.2:8765", shortCode: "QQ-1", expiresAt: new Date(Date.now() + 5 * 60e3).toISOString(), humanAgentAlias: "hussein" } }]);
    render(<PairingPanel cid="c1" identity={{ github_login: "husseinmohamed" }} />);
    await screen.findByText("QQ-1");
    const idn = document.querySelector("#pairBody .pair-identity")!;
    expect(idn.querySelector(".gh-login")!.textContent).toBe("husseinmohamed");
    expect(idn.querySelector(".pair-alias")!.textContent).toBe("· hussein");
  });

  it("shell r2: no duplicate alias when the alias equals the login", async () => {
    stub([{ status: 200, body: { shortCode: "QQ-2", expiresAt: new Date(Date.now() + 5 * 60e3).toISOString(), humanAgentAlias: "tomas-v" } }]);
    render(<PairingPanel cid="c1" identity={{ github_login: "tomas-v" }} />);
    await screen.findByText("QQ-2");
    expect(document.querySelector("#pairBody .gh-login")!.textContent).toBe("tomas-v");
    expect(document.querySelector("#pairBody .pair-alias")).toBeNull();
  });
});
