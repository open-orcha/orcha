/**
 * OnboardingPage — port-parity tests: first screen renders from an empty
 * workspace, the goal draft persists to the SAME localStorage key the vanilla
 * page uses, and an invalid_goal propose failure surfaces the retry path
 * (feeding the server's feedback back into the dialogue).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { KEY } from "./logic";
import { OnboardingPage } from "./OnboardingPage";

/* ---- fetch stub over the UNCHANGED backend contract ---------------------- */
let rawSnapshot: unknown;
let proposeCalls: number;

function jsonRes(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => data } as unknown as Response;
}

// A fake ReadableStream body yielding the given SSE frames then EOF — enough
// for startPropose's fetch-stream pump (getReader/read).
function sseBody(frames: string[]) {
  const enc = new TextEncoder();
  const chunks = frames.map((f) => enc.encode(f));
  let i = 0;
  return {
    getReader() {
      return {
        read: async () =>
          i < chunks.length
            ? { done: false as const, value: chunks[i++] }
            : { done: true as const, value: undefined },
        cancel: async () => {},
      };
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  proposeCalls = 0;
  rawSnapshot = { container: { id: "c1" }, agents: [], tasks: [], requests: [] };
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/onboarding/propose") {
      proposeCalls += 1;
      return {
        ok: true,
        status: 200,
        body: sseBody(['data:{"event":"error","code":"invalid_goal","message":"too vague"}\n\n']),
      } as unknown as Response;
    }
    if (url === "/api/models") return jsonRes({ models: [{ id: "m1", name: "Model One" }], default: "m1" });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/")) return jsonRes(rawSnapshot);
    return jsonRes({ detail: "not found" }, false, 404);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter>
          <OnboardingPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("OnboardingPage (vanilla onboarding.js parity)", () => {
  it("renders the welcome screen first in an empty workspace", async () => {
    renderPage();
    // boot waits on the first snapshot, then lands on welcome (no operator yet)
    expect(await screen.findByText("Claim the human authority")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Your name — e.g. Dario")).toBeInTheDocument();
    // welcome hides the guide rail (vanilla showRail = step !== "welcome")
    expect(screen.queryByText("Skip to dashboard")).not.toBeInTheDocument();
  });

  it("persists the goal draft to the same localStorage key as the classic page", async () => {
    // an operator exists → the flow resumes at the persisted propose-goal step
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({ step: "propose-goal" }));
    renderPage();

    const ta = await screen.findByPlaceholderText(/Improve my app's onboarding/);
    fireEvent.change(ta, { target: { value: "Build a docs site" } });

    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    expect(saved.step).toBe("propose-goal");
    expect(saved._propose?.goal).toBe("Build a docs site");
  });

  it("surfaces the retry path on an invalid_goal propose failure", async () => {
    rawSnapshot = {
      container: { id: "c1" },
      agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
      tasks: [], requests: [],
    };
    localStorage.setItem(KEY, JSON.stringify({
      step: "propose-goal",
      _propose: { goal: "Build a docs site", dialogue: [] },
    }));
    renderPage();

    // kick off the propose stream
    fireEvent.click(await screen.findByRole("button", { name: /Propose my roster/ }));

    // the stubbed backend answers with an invalid_goal error frame → error turn
    expect(await screen.findByText("Couldn't propose a roster")).toBeInTheDocument();
    expect(screen.getByText("too vague")).toBeInTheDocument();
    const retryBtn = screen.getByRole("button", { name: /Retry/ });
    expect(retryBtn).toBeInTheDocument();
    expect(proposeCalls).toBe(1);

    // retry feeds the server's feedback back into the dialogue and re-streams
    fireEvent.click(retryBtn);
    await waitFor(() => expect(proposeCalls).toBe(2));
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    const dialogue: { role: string; content: string }[] = saved._propose?.dialogue || [];
    expect(dialogue.some((d) =>
      d.role === "user" &&
      d.content.includes("failed validation on the server: too vague"),
    )).toBe(true);

    // the retried stream errors again → the retry path is still available
    expect(await screen.findByText("Couldn't propose a roster")).toBeInTheDocument();
  });
});
