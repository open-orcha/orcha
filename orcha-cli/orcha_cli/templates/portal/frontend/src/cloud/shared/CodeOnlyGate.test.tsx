/**
 * codeOnly() — /code and /github in General mode show a calm notice, not a working code
 * page (general-mode U04). Code mode, and an unreadable mode, render the real page.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetProjectModeCache, saveProjectMode } from "../../lib/projectMode";
import { codeOnly } from "./CodeOnlyGate";

vi.mock("../../state/SnapshotProvider", () => ({ useSnapshot: () => ({ cid: "c1" }) }));
vi.mock("../../shell/Shell", () => ({
  Shell: ({ title, children }: { title: string; children: ReactNode }) => <main data-title={title}>{children}</main>,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetProjectModeCache(); });

function stubMode(mode: string | null, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push((init?.method || "GET") + " " + String(u));
    if (init?.method === "PUT") mode = JSON.parse(String(init.body)).mode; // the server's state moves with the PUT
    const m = mode;
    const body = status === 200 ? { container_id: "c1", mode: m, dod_presets: [], template_key: null, template_name: null, last_applied_at: null }
      : { detail: "Not Found" };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const FakeCode = () => <div>REAL CODE PAGE</div>;
const FakeGh = () => <div>REAL GITHUB PAGE</div>;

describe("codeOnly route guard", () => {
  it("General mode: /code shows the calm General-mode notice with a Settings link, never the code page", async () => {
    stubMode("general");
    const Guarded = codeOnly("code", FakeCode);
    const { container } = render(<Guarded />);
    expect(screen.queryByText("REAL CODE PAGE")).toBeNull(); // no flash while the mode loads
    expect(await screen.findByText("This project is in General mode")).toBeTruthy();
    expect(container.textContent).toContain("Switch to Code mode in Settings to use Code");
    const link = screen.getByRole("link", { name: /Work type settings/ });
    expect(link.getAttribute("href")).toContain("/settings");
    expect(link.getAttribute("href")).toContain("#tab=general");
    expect(screen.queryByText("REAL CODE PAGE")).toBeNull();
  });

  it("General mode: /github is guarded the same way", async () => {
    stubMode("general");
    const Guarded = codeOnly("github", FakeGh);
    const { container } = render(<Guarded />);
    expect(await screen.findByText("This project is in General mode")).toBeTruthy();
    expect(container.textContent).toContain("to use GitHub");
    expect(container.querySelector("main")?.getAttribute("data-title")).toBe("GitHub");
    expect(screen.queryByText("REAL GITHUB PAGE")).toBeNull();
  });

  it("Code mode renders the real page", async () => {
    stubMode("code");
    const Guarded = codeOnly("code", FakeCode);
    render(<Guarded />);
    expect(await screen.findByText("REAL CODE PAGE")).toBeTruthy();
    expect(screen.queryByText("This project is in General mode")).toBeNull();
  });

  it("an older server without /project-profile (404) falls back to the page — Code is the default", async () => {
    stubMode(null, 404);
    const Guarded = codeOnly("github", FakeGh);
    render(<Guarded />);
    expect(await screen.findByText("REAL GITHUB PAGE")).toBeTruthy();
  });

  it("switching the mode live flips the guard without a reload (General → Code)", async () => {
    stubMode("general");
    const Guarded = codeOnly("code", FakeCode);
    render(<Guarded />);
    expect(await screen.findByText("This project is in General mode")).toBeTruthy();
    await act(async () => { await saveProjectMode("c1", "code", null); });
    expect(await screen.findByText("REAL CODE PAGE")).toBeTruthy();
  });
});
