/**
 * QA (S-12/S-13, brief §7): the Execution controls popover is keyboard-
 * operable — the Notifier switch and the three Autonomy levels are real
 * buttons; Tab reaches them, Enter/Space opens the same confirm as a click,
 * and the autonomy radiogroup uses a roving tabindex with Arrow/Home/End.
 * Also: identity pending / viewer role never act (no impersonation).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { extensions, type Identity } from "../extensions";
import { SnapshotProvider, _setActingIdentity, _setActingAuth } from "../state/SnapshotProvider";
import { HomePage } from "../pages/home/HomePage";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: true },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <HomePage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

async function openExecByKeyboard() {
  await waitFor(() => expect(document.getElementById("execBtn")).toBeTruthy());
  const btn = document.getElementById("execBtn") as HTMLButtonElement;
  btn.focus();
  fireEvent.click(btn); // Enter on a <button> activates it
  await waitFor(() => expect(document.getElementById("notifTop")).toBeTruthy());
}

describe("Execution controls — keyboard", () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => {
    cleanup(); vi.restoreAllMocks();
    delete extensions.identity;
    _setActingIdentity(null);
    _setActingAuth({ pending: false, trusted: false });
  });

  it("the Notifier switch is a focusable button; focus lands on it and Enter/Space opens the confirm", async () => {
    mount();
    await screen.findAllByText("Orcha");
    await openExecByKeyboard();
    const sw = document.querySelector('#notifTop [role="switch"]') as HTMLElement;
    expect(sw.tagName).toBe("BUTTON");
    await waitFor(() => expect(document.activeElement).toBe(sw)); // popover moves focus to its first control
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw); // native button: Enter/Space dispatch click
    expect(await screen.findByText("Pause all agent wakes?")).toBeInTheDocument();
  });

  it("autonomy levels: roving tabindex, arrows/Home/End move focus only, activation opens the confirm", async () => {
    mount();
    await screen.findAllByText("Orcha");
    await openExecByKeyboard();
    const radios = Array.from(document.querySelectorAll('#autTop [role="radio"]')) as HTMLButtonElement[];
    expect(radios.map((r) => r.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]); // only the active level is a Tab stop
    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[1]);
    expect(screen.queryByText(/Set autonomy to/)).toBeNull(); // moving focus never changes the level
    fireEvent.keyDown(radios[1], { key: "End" });
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(radios[2], { key: "Home" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.click(radios[2]);
    expect(await screen.findByText("Set autonomy to Full?")).toBeInTheDocument();
  });

  it("a viewer-role identity sees the controls disabled with the reason (no impersonation)", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "viewer" }) as Identity;
    mount();
    await screen.findAllByText("Orcha");
    await openExecByKeyboard();
    await waitFor(() => {
      const sw = document.querySelector('#notifTop [role="switch"]') as HTMLElement;
      expect(sw.getAttribute("aria-disabled")).toBe("true");
      expect(sw.getAttribute("title")).toBe("Your role is viewer (read-only)");
    });
    fireEvent.click(document.querySelector('#notifTop [role="switch"]')!);
    expect(screen.queryByText("Pause all agent wakes?")).toBeNull();
  });
});
