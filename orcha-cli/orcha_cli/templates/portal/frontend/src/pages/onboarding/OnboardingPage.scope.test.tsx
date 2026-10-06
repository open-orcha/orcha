/**
 * QA 11 (arch §4): the onboarding draft is per project. If the resolved cid
 * changes while the page is mounted, the page re-boots from THAT project's
 * saved draft and never writes project A's draft under project B's key.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { scopedKey } from "./logic";

const ctx = vi.hoisted(() => ({
  value: {
    snap: null as unknown,
    cid: "A" as string | null,
    multi: true,
    refresh: async () => {},
  },
}));

vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ctx.value,
  actingHuman: () => null,
  setActingHuman: () => {},
}));
vi.mock("../../shell/Shell", () => ({
  Shell: ({ children, crumbs }: { children: ReactNode; crumbs?: { label: ReactNode }[] }) => (
    <div><div data-testid="crumbs">{(crumbs ?? []).map((c) => String(c.label)).join(" / ")}</div>{children}</div>
  ),
}));
vi.mock("../../components/ui", () => ({
  Avatar: () => null, Icon: () => null, KindBadge: () => null, OrcaMark: () => null, Pill: () => null,
  useToast: () => () => {},
}));
vi.mock("../../api/client", () => ({
  getJSON: async () => ({ models: [], default: null }),
  sendJSON: async () => ({}),
}));

import { OnboardingPage } from "./OnboardingPage";

const snapFor = (id: string) => ({
  container: { id }, agents: [{ id: "h", alias: "op", kind: "human", status: "idle" }], tasks: [], requests: [],
});

beforeEach(() => {
  localStorage.clear();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => cleanup());

describe("OnboardingPage project scope", () => {
  it("a cid switch while mounted re-boots from the new project's draft and never copies A's draft into B", async () => {
    localStorage.setItem(scopedKey("A"), JSON.stringify({
      step: "create-tasks", tasks: [{ title: "A-only task", dod: "d" }], lastAgentAlias: null, _agentDraft: null,
    }));
    ctx.value = { ...ctx.value, cid: "A", snap: snapFor("A") };
    const view = render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
    expect(await screen.findByText("Add your first tasks")).toBeInTheDocument();

    // project switch: cid is B but the snapshot is still A's for a moment
    ctx.value = { ...ctx.value, cid: "B", snap: snapFor("A") };
    await act(async () => { view.rerender(<MemoryRouter><OnboardingPage /></MemoryRouter>); });
    expect(localStorage.getItem(scopedKey("B"))).toBeNull(); // nothing of A's written under B

    ctx.value = { ...ctx.value, cid: "B", snap: snapFor("B") };
    await act(async () => { view.rerender(<MemoryRouter><OnboardingPage /></MemoryRouter>); });
    expect(await screen.findByText(/set up your first team/)).toBeInTheDocument(); // B's fresh flow → fork
    expect(screen.queryByText("Add your first tasks")).toBeNull();
    const b = JSON.parse(localStorage.getItem(scopedKey("B")) || "{}");
    expect(b.step).toBe("fork");
    expect(JSON.stringify(b)).not.toContain("A-only task");
    // A's draft is untouched
    expect(localStorage.getItem(scopedKey("A"))).toContain("A-only task");
  });

  it("header crumbs never repeat the section: 'Setup' adds no extra crumb (project / Setup, not Setup / Setup)", async () => {
    ctx.value = { ...ctx.value, cid: "A", snap: snapFor("A") };
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
    expect(await screen.findByText(/set up your first team/)).toBeInTheDocument();
    expect(screen.getByTestId("crumbs")).toHaveTextContent(/^$/);
  });

  it("?new=1 keeps exactly one 'New agent' crumb", async () => {
    ctx.value = { ...ctx.value, cid: "A", snap: snapFor("A") };
    render(<MemoryRouter initialEntries={["/onboarding?new=1"]}><OnboardingPage /></MemoryRouter>);
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("crumbs")).toHaveTextContent(/^New agent$/));
  });

  it("welcome prefills the signed-in account name instead of asking 'who are you?' again", async () => {
    ctx.value = {
      ...ctx.value, cid: "A",
      snap: { container: { id: "A", name: "fresh-project" }, agents: [], tasks: [], requests: [] },
      identity: { alias: "hussein", github_login: "husseinmohamed" },
    } as typeof ctx.value;
    render(<MemoryRouter><OnboardingPage /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Join fresh-project" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your name in this project")).toHaveValue("hussein");
    expect(screen.getByRole("button", { name: /Join/ })).toBeInTheDocument();
  });
});
