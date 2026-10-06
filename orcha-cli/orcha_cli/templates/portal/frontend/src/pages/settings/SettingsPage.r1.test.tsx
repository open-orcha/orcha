/**
 * Settings — Linear review r1 fixes:
 *  - Execution › Notifier states the OBSERVED wake service with the SAME
 *    words as the header chip (execChipState, the shared notifierState()
 *    mapping): a stale last_wake_scan_at is "Not running", never "Running".
 *  - Integrations › Connected repository shows the bound repo (or "Not
 *    connected"), not a generic sentence.
 *  - The narrow-width section nav is a scrolling pill row, not a <select>.
 *  - Group explanations live behind a "?" tooltip (D12), one short line max.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { extensions } from "../../extensions";
import { execChipState } from "../../shell/Shell";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { SettingsPage } from "./SettingsPage";

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function installFetch(container: Record<string, unknown>) {
  const impl = async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1")
      return json({ container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", ...container }, agents: [], tasks: [], requests: [] });
    if (url.endsWith("/settings/models")) return json({ use_cases: [] });
    if (url.endsWith("/settings/providers")) return json({ providers: [] });
    if (url.endsWith("/settings/llm-key")) return json({ configured: false, masked: null, source: null });
    if (url === "/api/prefs") return json({ prefs: null });
    return json({});
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

function renderAt(hash: string) {
  window.history.replaceState(null, "", window.location.pathname + hash);
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const ORIGINAL_ROUTES = extensions.routes;
beforeEach(() => {
  localStorage.clear();
  delete extensions.settingsSections;
  delete extensions.settingsGeneral;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  extensions.routes = ORIGINAL_ROUTES;
});

describe("Execution › Notifier is truthful and matches the header chip", () => {
  it("a stale wake scan reads 'Not running' (never 'Running'), identical to execChipState", async () => {
    const c = { wakes_enabled: true, last_wake_scan_at: ago(12 * 60 * 1000) };
    installFetch(c);
    renderAt("#tab=execution");
    const val = await waitFor(() => {
      const el = document.querySelector("#setNotifierState");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(execChipState(c)).toBe("Not running");
    expect(val).toHaveTextContent(/^Not running$/);
    expect(screen.getByText(/On, but no wake scan in/)).toBeInTheDocument();
    expect(screen.queryByText(/^Running$/)).toBeNull();
  });

  it("no wake stamp at all reads 'No wake service'; a fresh one reads 'Running'", async () => {
    installFetch({ wakes_enabled: true, last_wake_scan_at: null });
    renderAt("#tab=execution");
    await waitFor(() => expect(document.querySelector("#setNotifierState")).toHaveTextContent("No wake service"));
    cleanup();
    installFetch({ wakes_enabled: true, last_wake_scan_at: ago(20 * 1000) });
    renderAt("#tab=execution");
    await waitFor(() => expect(document.querySelector("#setNotifierState")).toHaveTextContent(/^Running$/));
  });

  it("the independence explanation is a '?' tooltip, not a paragraph", async () => {
    installFetch({ wakes_enabled: true, last_wake_scan_at: null });
    renderAt("#tab=execution");
    const help = await screen.findByRole("button", { name: "About Notifier and autonomy" });
    expect(screen.queryByText(/pausing wakes never changes autonomy/)).toBeNull();
    fireEvent.focus(help);
    fireEvent.pointerEnter(help);
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent(/pausing wakes never changes autonomy/));
  });
});

describe("Integrations › Connected repository", () => {
  it("shows the bound repo slug", async () => {
    extensions.routes = [{ path: "/github", element: () => null }];
    installFetch({ github_repo: "acme/orcha-web" });
    renderAt("#tab=github-access");
    expect(await screen.findByText("acme/orcha-web")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open GitHub" })).toHaveAttribute("href", "/github");
  });

  it("says 'Not connected' with a connect link when no repo is bound", async () => {
    extensions.routes = [{ path: "/github", element: () => null }];
    installFetch({ github_repo: null });
    renderAt("#tab=github-access");
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect on GitHub" })).toHaveAttribute("href", "/github");
  });
});

describe("narrow-width section nav", () => {
  it("is a pill row (aria-current on the active one), never a native select", async () => {
    installFetch({});
    renderAt("#tab=interface");
    const pills = await waitFor(() => document.querySelector("#setSectionPills")!);
    expect(document.querySelector("select#setSectionSelect")).toBeNull();
    expect(pills.querySelector('[data-pill="interface"]')).toHaveAttribute("aria-current", "page");
    fireEvent.click(pills.querySelector('[data-pill="execution"]')!);
    expect(screen.getByRole("tab", { name: "Execution" })).toHaveAttribute("aria-selected", "true");
  });

  it("the nav cluster for project-scoped sections is named 'Project', not 'Workspace'", async () => {
    installFetch({});
    renderAt("");
    await screen.findByRole("tab", { name: "General" });
    const heads = Array.from(document.querySelectorAll(".set-nav-h")).map((h) => h.textContent);
    expect(heads[0]).toBe("Project");
    expect(heads).not.toContain("Workspace");
  });
});
