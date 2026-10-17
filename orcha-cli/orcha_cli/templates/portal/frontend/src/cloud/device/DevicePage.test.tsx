/**
 * DevicePage — the pairing-token mint contract (device_token_routes.py):
 * exactly one POST /api/device-tokens {label:"iOS device"} per page load, the
 * raw token surfaced for manual copy, and the 403 detail rendered with the
 * invite remedy. fetch is stubbed; matches foundation.test.ts style.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevicePage } from "./DevicePage";

interface Call { url: string; method: string; body: unknown }

function stubFetch(res: { status: number; data: unknown }): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return {
      ok: res.status < 400,
      status: res.status,
      json: async () => res.data,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("DevicePage (device-token mint)", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("POSTs /api/device-tokens with {label:'iOS device'} exactly once and shows the token", async () => {
    const calls = stubFetch({ status: 201, data: { token: "tok_abc123", agent_id: "h1", label: "iOS device" } });
    render(<DevicePage />);
    expect(screen.getByText("Minting a device token…")).toBeInTheDocument();
    expect(await screen.findByText("tok_abc123")).toBeInTheDocument();
    expect(screen.getByText("Device token minted — opening the Orcha mobile app…")).toBeInTheDocument();
    const mints = calls.filter((c) => c.url === "/api/device-tokens");
    expect(mints.length).toBe(1);
    expect(mints[0].method).toBe("POST");
    expect(mints[0].body).toEqual({ label: "iOS device" });
  });

  it("copy button writes the raw token to the clipboard", async () => {
    stubFetch({ status: 201, data: { token: "tok_abc123" } });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<DevicePage />);
    await screen.findByText("tok_abc123");
    fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
    expect(writeText).toHaveBeenCalledWith("tok_abc123");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("renders the 403 detail with the invite remedy (non-member caller)", async () => {
    stubFetch({ status: 403, data: { detail: "GitHub user 'x' is not a member of any project" } });
    render(<DevicePage />);
    // DEV-004: a fixed headline + guidance; the raw server text only inside Details
    expect(await screen.findByText("Your GitHub account isn't a member of this Embodent yet")).toBeInTheDocument();
    expect(screen.getByText("Ask an owner to invite you (Settings → Members & access), then try again.")).toBeInTheDocument();
    expect(document.querySelector(".device-err-more code")).toHaveTextContent("HTTP 403 · GitHub user 'x' is not a member of any project");
    expect(document.querySelector(".device-err-d")).not.toHaveTextContent(/GitHub user 'x'/);
    // no duplicate status line under the heading when the error block shows
    expect(document.querySelector("#status")).toBeNull();
    expect(screen.queryByText("Copy token")).not.toBeInTheDocument();
  });
});

describe("DevicePage (V2: client, retry, fallback copy)", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); window.history.replaceState(null, "", "/"); });

  it("?client=desktop labels the token 'Desktop app' and titles the page for the desktop app", async () => {
    window.history.replaceState(null, "", "/auth/device?client=desktop");
    const calls = stubFetch({ status: 201, data: { token: "tok_d" } });
    render(<DevicePage />);
    expect(screen.getByRole("heading", { name: "Sign in the desktop app" })).toBeInTheDocument();
    await screen.findByText("tok_d");
    expect(calls.find((c) => c.url === "/api/device-tokens")!.body).toEqual({ label: "Desktop app" });
  });

  it("stops claiming the app is opening after the grace period", async () => {
    stubFetch({ status: 201, data: { token: "tok_g" } });
    render(<DevicePage />);
    await screen.findByText("tok_g");
    expect(await screen.findByText("If the app didn’t open, copy the token below.", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("an error leads with a human sentence and offers Try again (which mints again)", async () => {
    const calls = stubFetch({ status: 403, data: { detail: "not a member of any project" } });
    render(<DevicePage />);
    expect(await screen.findByText("Your GitHub account isn't a member of this Embodent yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Embodent" })).toHaveAttribute("href", "/");
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/device-tokens").length).toBe(2));
    await screen.findByText("Your GitHub account isn't a member of this Embodent yet");
    expect(calls.filter((c) => c.url === "/api/device-tokens").length).toBe(2);
  });
});

describe("DevicePage mint failures (DEV-004 / DEV-SELFHOST)", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("a self-hosted portal (no verified GitHub identity) says 'Sign in with GitHub first', not 'not a member'", async () => {
    stubFetch({ status: 403, data: { detail: "device tokens require a verified GitHub identity (trusted proxy)" } });
    render(<DevicePage />);
    expect(await screen.findByText("Sign in with GitHub first")).toBeInTheDocument();
    expect(screen.queryByText(/isn't a member/)).toBeNull();
  });

  it("a server error gets fixed copy with the status only under Details", async () => {
    stubFetch({ status: 500, data: { detail: "psycopg.OperationalError: boom" } });
    render(<DevicePage />);
    expect(await screen.findByText("Couldn't create a sign-in token")).toBeInTheDocument();
    expect(document.querySelector(".device-err-d")).toHaveTextContent("Something went wrong on the server. Try again.");
    expect(document.querySelector(".device-err-more")).not.toHaveAttribute("open");
    expect(document.querySelector(".device-err-more code")).toHaveTextContent("HTTP 500");
  });
});
