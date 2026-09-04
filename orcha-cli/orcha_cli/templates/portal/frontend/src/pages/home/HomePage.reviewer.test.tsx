/**
 * HomePage — collab v1 verify-card de-emphasis (port of the cloud vanilla
 * home-state.js renderQueue rule): a verify card whose task carries an
 * owner-assigned reviewer that is NOT the acting human renders de-emphasized
 * (.aq.verify.other-review) with a "review: <login>" chip; the reviewer,
 * owners, and open backends (no member_role — permissive) see it normally.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { HomePage } from "./HomePage";

/* eslint-disable @typescript-eslint/no-explicit-any */
function rawSnap(opts: {
  actorRole?: string | null; // h1 (kedar, the acting human) member_role; undefined = omit (open)
  reviewerId?: string | null; // reviewer_agent_id on the verify task
}) {
  const agents: any[] = [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "h2", alias: "sam", kind: "human", status: "idle", github_login: "sam-gh" },
    { id: "a1", alias: "forge", kind: "ai", status: "working", model: "claude" },
  ];
  if (opts.actorRole !== undefined) {
    agents[0].member_role = opts.actorRole;
    agents[1].member_role = "member";
  }
  const task: any = {
    id: "t1", title: "Ship the feature", status: "needs_verification",
    assignees: ["forge"], definition_of_done: "It works end to end",
    created_at: "2026-08-01T00:00:00Z", started_at: "2026-08-01T00:00:00Z",
  };
  if (opts.reviewerId !== undefined) {
    task.reviewer_agent_id = opts.reviewerId;
    task.reviewer = opts.reviewerId
      ? opts.reviewerId === "h2"
        ? { agent_id: "h2", alias: "sam", github_login: "sam-gh" }
        : { agent_id: "h1", alias: "kedar", github_login: null }
      : null;
  }
  return {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents,
    tasks: [task],
    requests: [],
  };
}

function stubFetch(snapshot: unknown) {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(snapshot);
    return json({});
  }) as unknown as typeof fetch;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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

const card = () => document.querySelector(".aq.verify");

describe("HomePage verify-card de-emphasis (collab v1)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("someone else's review + member actor -> de-emphasized with a review chip", async () => {
    stubFetch(rawSnap({ actorRole: "member", reviewerId: "h2" }));
    mount();
    await screen.findByText("review: sam-gh");
    await waitFor(() => expect(card()!.classList.contains("other-review")).toBe(true));
    expect(document.querySelector(".tag.review-for")).toBeTruthy();
  });

  it("the assigned reviewer sees the card normally", async () => {
    stubFetch(rawSnap({ actorRole: "member", reviewerId: "h1" }));
    mount();
    await screen.findByText("Verify task");
    expect(card()!.classList.contains("other-review")).toBe(false);
    expect(screen.queryByText(/^review:/)).not.toBeInTheDocument();
  });

  it("owners see every card normally", async () => {
    stubFetch(rawSnap({ actorRole: "owner", reviewerId: "h2" }));
    mount();
    await screen.findByText("Verify task");
    expect(card()!.classList.contains("other-review")).toBe(false);
    expect(screen.queryByText(/^review:/)).not.toBeInTheDocument();
  });

  it("open backends (no member_role) never de-emphasize — permissive fallback", async () => {
    stubFetch(rawSnap({ reviewerId: "h2" }));
    mount();
    await screen.findByText("Verify task");
    expect(card()!.classList.contains("other-review")).toBe(false);
    expect(screen.queryByText(/^review:/)).not.toBeInTheDocument();
  });

  it("no reviewer fields at all (open snapshot) -> plain verify card", async () => {
    stubFetch(rawSnap({}));
    mount();
    await screen.findByText("Verify task");
    expect(card()!.classList.contains("other-review")).toBe(false);
    expect(screen.queryByText(/^review:/)).not.toBeInTheDocument();
  });
});
