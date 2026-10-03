/**
 * Onboarding wiring for "Start from a template": the fork offers it, the step
 * renders the flow for the project, Back returns to the fork, finishing lands on
 * the Overview, and /onboarding?step=template deep-links straight in.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { scopedKey } from "../logic";

const ctx = vi.hoisted(() => ({
  value: { snap: null as unknown, cid: "A" as string | null, multi: false, refresh: async () => {}, identity: null as unknown },
}));

vi.mock("../../../state/SnapshotProvider", () => ({
  useSnapshot: () => ctx.value,
  actingHuman: () => null,
  setActingHuman: () => {},
}));
vi.mock("../../../shell/Shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../../../components/ui", () => ({
  Avatar: () => null, Icon: () => null, KindBadge: () => null, OrcaMark: () => null, Pill: () => null,
  useToast: () => () => {},
}));
vi.mock("../../../api/client", () => ({
  getJSON: async () => ({ models: [], default: null }),
  sendJSON: async () => ({}),
}));
vi.mock("./TemplateApplyFlow", () => ({
  TemplateApplyFlow: ({ cid, onCancel, onDone, doneLabel }: { cid: string; onCancel: () => void; onDone: () => void; doneLabel: string }) => (
    <div data-testid="flow" data-cid={cid}>
      <button type="button" onClick={onCancel}>flow-cancel</button>
      <button type="button" onClick={onDone}>{doneLabel}</button>
    </div>
  ),
}));

import { OnboardingPage } from "../OnboardingPage";

const snap = { container: { id: "A" }, agents: [{ id: "h", alias: "op", kind: "human", status: "idle" }], tasks: [], requests: [] };

beforeEach(() => {
  localStorage.clear();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  ctx.value = { ...ctx.value, cid: "A", snap, identity: null };
});
afterEach(() => cleanup());

function renderAt(path = "/onboarding") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/" element={<div data-testid="overview">Overview</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("onboarding › Start from a template", () => {
  it("the fork offers templates; the step renders the flow; Back returns to the fork", async () => {
    renderAt();
    expect(await screen.findByRole("heading", { name: "Start from a template" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browse templates" }));
    expect(await screen.findByTestId("flow")).toHaveAttribute("data-cid", "A");
    expect(screen.getByRole("heading", { level: 1, name: "Start from a template" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(scopedKey("A")) || "{}").step).toBe("template");
    fireEvent.click(screen.getByRole("button", { name: "flow-cancel" }));
    expect(await screen.findByRole("button", { name: "Browse templates" })).toBeInTheDocument();
  });

  it("finishing refreshes and lands on the Overview, leaving the draft at the fork", async () => {
    const refresh = vi.fn(async () => {});
    ctx.value = { ...ctx.value, refresh };
    renderAt("/onboarding?step=template"); // deep link straight into the step
    expect(await screen.findByTestId("flow")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Go to Overview" })); });
    await waitFor(() => expect(screen.getByTestId("overview")).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(scopedKey("A")) || "{}").step).toBe("fork");
  });

  it("someone who can't add agents is told so on the step (they may still browse)", async () => {
    ctx.value = { ...ctx.value, identity: { agent_id: "h", alias: "op", member_role: "viewer", grants: [] } };
    renderAt("/onboarding?step=template");
    expect(await screen.findByTestId("flow")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/not apply one/);
  });
});
