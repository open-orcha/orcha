/** Settings › Devices & pairing › Signed-in devices — GET list + DELETE revoke. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { DEVICE_SIGNIN_UNAVAILABLE, DeviceTokensSection, deviceKind, revokeFailure } from "./DeviceTokens";

interface Call { url: string; method: string }
function stub(tokens: unknown, status = 200): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method });
    const data = method === "DELETE" ? { revoked: true } : { tokens };
    return { ok: status < 400, status, json: async () => data } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}
const mount = () => render(<ToastProvider><DeviceTokensSection /></ToastProvider>);

describe("DeviceTokensSection", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("lists the caller's device tokens and revokes one after confirmation", async () => {
    const calls = stub([
      { id: "t1", label: "iOS device", created_at: new Date().toISOString(), last_used_at: null },
      { id: "t2", label: "Desktop app", created_at: new Date().toISOString(), last_used_at: new Date().toISOString() },
    ]);
    mount();
    expect(await screen.findByText("iOS device")).toBeInTheDocument();
    expect(screen.getByText(/never used/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke iOS device" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/device-tokens/t1")).toBe(true));
    await waitFor(() => expect(screen.queryByText("iOS device")).not.toBeInTheDocument());
    expect(screen.getByText("Desktop app")).toBeInTheDocument();
  });

  it("shows an empty state and an error state with Retry", async () => {
    stub([]);
    mount();
    expect(await screen.findByText(/No phones or desktop apps/)).toBeInTheDocument();
    cleanup();
    const calls = stub(null, 500);
    mount();
    expect(await screen.findByText(/Couldn't load your signed-in devices/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBe(2));
  });

  it("deviceKind names unlabeled tokens honestly", () => {
    expect(deviceKind(null).name).toBe("Unnamed device");
    expect(deviceKind("Desktop app").icon).toBe("sidebar");
    expect(deviceKind("iOS device").icon).toBe("phone");
  });

  it("DEV-REVOKE-ERR: a failed revoke is words, never a status code; a 404 drops the row", async () => {
    expect(revokeFailure(403).text).toBe("Only the device's owner or a project owner can revoke it.");
    expect(revokeFailure(500).text).toBe("Couldn't revoke the device. Try again.");
    expect(revokeFailure(404)).toEqual({ text: "That device was already signed out.", tone: "warn", drop: true });
    const calls: Call[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || "GET";
      calls.push({ url: String(input), method });
      if (method === "DELETE") return { ok: false, status: 404, json: async () => ({ detail: "device token t1 not found" }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ tokens: [{ id: "t1", label: "iOS device", created_at: null, last_used_at: null }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke iOS device" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("That device was already signed out.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke iOS device" })).toBeNull());
    expect(document.body.textContent).not.toMatch(/\(404\)|not found/);
  });

  it("DEV-SELFHOST: a 403 list (no verified GitHub identity) is the unavailable note, not an error with Retry", async () => {
    stub(null, 403);
    mount();
    expect(await screen.findByText(DEVICE_SIGNIN_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });
});
