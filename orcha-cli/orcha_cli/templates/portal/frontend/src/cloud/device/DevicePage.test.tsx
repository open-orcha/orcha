/**
 * DevicePage — the pairing-token mint contract (device_token_routes.py):
 * exactly one POST /api/device-tokens {label:"iOS device"} per page load, the
 * raw token surfaced for manual copy, and the 403 detail rendered with the
 * invite remedy. fetch is stubbed; matches foundation.test.ts style.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("Device token minted — opening the Orcha app…")).toBeInTheDocument();
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
    expect(await screen.findByText("Could not mint a device token.")).toBeInTheDocument();
    expect(screen.getByText(/is not a member of any project — your GitHub account must be a member/)).toBeInTheDocument();
    expect(screen.queryByText("Copy token")).not.toBeInTheDocument();
  });
});
