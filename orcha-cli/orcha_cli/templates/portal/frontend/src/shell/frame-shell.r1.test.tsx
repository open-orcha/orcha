/**
 * frame-shell polish round 1: global composer target, view-transition guard,
 * palette project avatars (D7/D13) + distinct Execution icon, and the header
 * overflow (⋯) menu at phone widths.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeTarget } from "./chrome";
import { guardViewTransition } from "./routes";
import { installBuiltinProviders } from "./search/builtin";
import { runProviders, type SearchContext } from "./search/providers";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { Shell } from "./Shell";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("global New task composer", () => {
  it("opens over the current route everywhere except /tasks (the page owns its composer)", () => {
    expect(composeTarget("/")).toBe("global");
    expect(composeTarget("/agents")).toBe("global");
    expect(composeTarget("/needs")).toBe("global");
    expect(composeTarget("/tasks")).toBe("tasks-page");
  });
});

describe("cross-document view transition guard", () => {
  it("observes every transition promise and skips when hidden", async () => {
    const rejected = () => { const p = Promise.reject(new Error("Transition was aborted because of invalid state")); return p; };
    const vt = { ready: rejected(), finished: rejected(), updateCallbackDone: rejected(), skipTransition: vi.fn() };
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    guardViewTransition(Object.assign(new Event("pagereveal"), { viewTransition: vt }), "hidden");
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
    expect(vt.skipTransition).toHaveBeenCalledTimes(1);
    const visible = { ready: Promise.resolve(), skipTransition: vi.fn() };
    guardViewTransition(Object.assign(new Event("pagereveal"), { viewTransition: visible }), "visible");
    expect(visible.skipTransition).not.toHaveBeenCalled();
    expect(() => guardViewTransition(new Event("pagereveal"))).not.toThrow();
  });
});

describe("palette builtin results", () => {
  installBuiltinProviders();
  const ctx = (over: Partial<SearchContext> = {}): SearchContext => ({
    snap: { container: { id: "c1", name: "orcha-web" } } as SearchContext["snap"],
    cid: "c1", multi: true, projectName: "orcha-web",
    projects: [{ id: "c1", name: "orcha-web", status: "active" }, { id: "c2", name: "mobile", status: "active" }] as SearchContext["projects"],
    actingHuman: { id: "h1", alias: "kedar", kind: "human" } as SearchContext["actingHuman"],
    embedded: false, openExecutionControls: () => {}, signal: new AbortController().signal, ...over,
  });

  it("project rows carry the container id as the avatar seed (same circle as the sidebar)", async () => {
    const { results } = await runProviders("", ctx());
    const proj = results.filter((r) => r.group === "Projects");
    expect(proj.map((r) => [r.avatar, r.avatarSeed])).toEqual([["orcha-web", "c1"], ["mobile", "c2"]]);
  });

  it("Execution controls no longer shares the Settings sliders icon; New task runs the global composer", async () => {
    const openCompose = vi.fn();
    const { results } = await runProviders("e", ctx({ openCompose }));
    const exec = results.find((r) => r.id === "exec");
    const settings = results.find((r) => r.id.startsWith("settings-"));
    expect(exec?.icon).not.toBe(settings?.icon ?? "sliders");
    const { results: empty } = await runProviders("", ctx({ openCompose }));
    const nt = empty.find((r) => r.id === "new-task")!;
    expect(nt.href).toBeUndefined();
    nt.run!();
    expect(openCompose).toHaveBeenCalled();
    const { results: noRun } = await runProviders("", ctx());
    expect(noRun.find((r) => r.id === "new-task")!.href).toBe("/tasks?new=1");
  });
});

describe("header overflow menu (phone widths)", () => {
  it("at 390 px the right cluster is exec dot + ⋯ + bell; ⋯ holds the primary action and search", async () => {
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return json({ container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", wakes_enabled: true }, agents: [], tasks: [], requests: [] });
      return json({});
    }) as unknown as typeof fetch;
    const prev = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    try {
      render(
        <ToastProvider><SnapshotProvider><MemoryRouter initialEntries={["/tasks"]}>
          <Shell page="tasks" title="Tasks" primaryAction={<button type="button">New task</button>}><div /></Shell>
        </MemoryRouter></SnapshotProvider></ToastProvider>,
      );
      await waitFor(() => expect(document.getElementById("execBtn")).toBeTruthy());
      expect(document.getElementById("topbar")!.className).toContain("is-d-overflow");
      expect(document.querySelector(".v2-header-primary")).toBeNull();
      fireEvent.click(document.getElementById("hdrMore")!);
      const menu = await screen.findByRole("dialog", { name: "More header actions" });
      expect(menu.textContent).toContain("New task");
      expect(menu.textContent).toContain("Search");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: prev });
    }
  });
});
