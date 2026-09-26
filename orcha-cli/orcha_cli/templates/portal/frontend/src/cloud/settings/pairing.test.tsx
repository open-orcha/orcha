/**
 * Pairing entry points — the topbar PairingButton opens the PairingModal as a
 * document.body PORTAL (the topbar's backdrop-filter would otherwise trap the
 * fixed overlay mid-page: no centering, no backdrop), and the settings
 * PairingSection renders the PairingPanel INLINE so the QR auto-loads the
 * moment the tab opens — no button press. fetch is stubbed; snapshot flows
 * through the real SnapshotProvider, matching MembersPage.test.tsx style.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";
import { PairingButton, PairingSection } from "./pairing";

interface Call { url: string; method: string }

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

const payload = {
  baseUrl: "http://192.168.1.20:80",
  humanAgentId: "h1",
  humanAgentAlias: "kedar",
  qrSvg: "<svg></svg>",
  shortCode: "ABCD-1234",
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

function stubFetch(): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET" });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
    if (url.startsWith("/api/containers/c1/pairing")) return json(payload);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount(el: ReactElement) {
  return render(
    <ToastProvider>
      <SnapshotProvider>{el}</SnapshotProvider>
    </ToastProvider>,
  );
}

describe("pairing entry points (shared PairingPanel/PairingModal reuse)", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("topbar button renders the vanilla markup and opens the modal (cid-scoped pairing GET)", async () => {
    const calls = stubFetch();
    mount(<PairingButton />);
    const btn = await screen.findByRole("button", { name: /Pair phone/ });
    expect(btn.id).toBe("pairPhoneBtn");
    expect(btn.className).toBe("btn sm subtle pair-top");
    expect(btn.getAttribute("title")).toBe("Pair a phone with this Orcha");
    // no modal until the button is pressed
    expect(screen.queryByText("Pair your phone")).not.toBeInTheDocument();
    // cid resolves async (SnapshotProvider) — wait for the loaded container
    await vi.waitFor(() => {
      fireEvent.click(btn);
      expect(screen.getByText("Pair your phone")).toBeInTheDocument();
    });
    // the payload comes from the PATH-cid pairing endpoint of the LOADED container
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers/c1/pairing")).toBe(true);
    // vanilla topbar open passes no opts.name — no "Project:" line
    expect(screen.queryByText(/Project:/)).not.toBeInTheDocument();
  });

  it("the modal is PORTAL'd to document.body (never trapped inside the topbar's containing block)", async () => {
    stubFetch();
    const { container } = mount(<PairingButton />);
    const btn = await screen.findByRole("button", { name: /Pair phone/ });
    await vi.waitFor(() => {
      fireEvent.click(btn);
      expect(screen.getByText("Pair your phone")).toBeInTheDocument();
    });
    // proper overlay chrome, mounted directly under <body> — NOT under the
    // launcher's subtree (the topbar), so .overlay's position:fixed dims and
    // centers against the viewport.
    const overlay = document.body.querySelector(":scope > .overlay.show");
    expect(overlay).not.toBeNull();
    expect(container.querySelector(".overlay")).toBeNull();
    const modal = overlay!.querySelector(".modal.pair-modal");
    expect(modal).not.toBeNull();
    expect(modal!.getAttribute("role")).toBe("dialog");
    expect(modal!.getAttribute("aria-modal")).toBe("true");
    // outside-click (on the backdrop) closes
    fireEvent.click(overlay!);
    expect(screen.queryByText("Pair your phone")).not.toBeInTheDocument();
    // reopen, then Escape closes
    fireEvent.click(btn);
    expect(screen.getByText("Pair your phone")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Pair your phone")).not.toBeInTheDocument();
  });

  it("settings card auto-loads the pairing panel INLINE: QR + countdown on tab open, no button", async () => {
    const calls = stubFetch();
    mount(<PairingSection />);
    expect(await screen.findByText("Phone pairing")).toBeInTheDocument();
    // the panel loads by itself once the cid resolves — code + QR inline
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers/c1/pairing")).toBe(true);
    expect(document.querySelector("#pairingCard .pair-qr")).not.toBeNull();
    expect(document.querySelector("#pairingCard .pair-grid")).not.toBeNull();
    // countdown chip ticking against the payload expiry
    expect(document.querySelector("#pairCountdown")).not.toBeNull();
    expect(screen.getByText(/expires in/)).toBeInTheDocument();
    // honest network copy (non-cloud test origin)
    expect(screen.getByText("Your phone talks directly to this computer on your network. Nothing goes through the cloud.")).toBeInTheDocument();
    // in-page card body — no launcher button, no modal chrome
    expect(screen.queryByRole("button", { name: /Pair phone/ })).not.toBeInTheDocument();
    expect(document.querySelector(".overlay")).toBeNull();
    expect(screen.queryByText("Pair your phone")).not.toBeInTheDocument();
  });
});
