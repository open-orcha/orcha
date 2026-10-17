/**
 * Screen-quality round 1 (/requests):
 *  - D4 payloads are human-readable: never "[object Object]" or raw JSON.
 *  - Direction filter (?dir=in|out|agents), labelled status text on rows.
 *  - Truthful actions: Nudge only when an AI agent owns the next action,
 *    the answer composer replaces the action row, suggestions have one
 *    dominant action, convert defaults to the responder.
 *  - Future expiry reads "in 30m", not "just now".
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { OrchaRequest, Snapshot } from "../../types";
import { RequestsPage, relWhen, requestActions, _resetPendingAnswers } from "./RequestsPage";
import { payloadSearchText, payloadText, payloadTitle } from "./requestPayload";

const T0 = Date.now();
const iso = (minsFromNow: number) => new Date(T0 + minsFromNow * 60_000).toISOString();

const RAW = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "forge", kind: "ai", status: "idle" },
    { id: "a2", alias: "mira", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  ],
  tasks: [],
  requests: [
    { id: "r1", type: "question", status: "open", priority: 30, requester_id: "a1", target_id: "h1", created_at: iso(-60), expires_at: iso(30),
      payload: { question: "Ship on Friday?", context: "Release train is full", options: ["yes", "no"], meta: { deep: { deeper: 1 } } } },
    { id: "r2", type: "question", status: "answered", priority: 100, requester_id: "a2", target_id: "a1", created_at: iso(-50),
      payload: "Which parser?", response: { summary: "Use the fast one", verified: true }, responded_at: iso(-40) },
    { id: "r3", type: "question", status: "answered", priority: 100, requester_id: "h1", target_id: "a2", created_at: iso(-30),
      payload: "Status of the migration?", response: "Done", responded_at: iso(-20) },
    { id: "r4", type: "info", status: "open", priority: 20, requester_id: "a1", target_id: null, created_at: iso(-10),
      payload: "Agent suggestion: add an infra agent",
      detail: { proposed_alias: "infra", proposed_role: "Infra", rationale: "forge is overloaded" } },
  ],
};

let calls: { url: string; body: unknown }[] = [];
let loc = { search: "" };
beforeEach(() => {
  calls = [];
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init && typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response;
    if (url.startsWith("/api/containers/c1")) return { ok: true, status: 200, json: async () => RAW } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
});
afterEach(() => { _resetPendingAnswers(); cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function Probe() { loc = { search: useLocation().search }; return null; }
function mount(path = "/requests") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <RequestsPage />
          <Probe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const detail = () => document.querySelector("#detailMain") as HTMLElement;
const visibleText = (el: HTMLElement) => {
  const c = el.cloneNode(true) as HTMLElement;
  c.querySelectorAll("style").forEach((s) => s.remove());
  return c.textContent || "";
};

describe("payload helpers (D4)", () => {
  it("payloadText prefers the headline field and never returns JSON", () => {
    expect(payloadText({ question: "Q?", x: 1 })).toBe("Q?");
    expect(payloadText({ branch: "main", files: ["a", "b"], nested: { a: 1 }, none: null })).toBe("Branch: main · Files: a, b");
    expect(payloadText({ nested: { a: 1 } })).toBe("");
    expect(payloadText("plain")).toBe("plain");
    expect(payloadText(null)).toBe("");
    for (const v of [{ a: { b: 1 } }, [{ a: 1 }], { summary: "s" }]) {
      expect(payloadText(v)).not.toMatch(/[{}]|\[object Object\]/);
    }
  });
  it("payloadTitle falls back and shortens long prose at a sentence", () => {
    expect(payloadTitle({ nested: { a: 1 } }, "Info request")).toBe("Info request");
    const long = "Should we run the migration now? It touches a very large number of rows and needs a maintenance window soon.";
    expect(payloadTitle(long)).toBe("Should we run the migration now?");
    expect(payloadTitle("x".repeat(30) + " " + "y".repeat(120)).endsWith("…")).toBe(true);
  });
  it("search text covers nested values", () => {
    expect(payloadSearchText({ a: { b: ["needle"] } })).toContain("needle");
  });
});

describe("relWhen", () => {
  it("renders future times as 'in …' and past as relative", () => {
    expect(relWhen(new Date(Date.now() + 30 * 60_000 + 5000).toISOString()).text).toBe("in 30m");
    expect(relWhen(new Date(Date.now() + 3 * 3600_000 + 5000).toISOString()).text).toBe("in 3h");
    const past = relWhen(new Date(Date.now() - 2 * 3600_000).toISOString());
    expect(past.past).toBe(true);
    expect(past.text).toBe("2h ago");
  });
});

describe("requestActions (truthful gates)", () => {
  const snap = { agents: RAW.agents, tasks: [], requests: [] } as unknown as Snapshot;
  const h = RAW.agents[2] as unknown as Parameters<typeof requestActions>[2];
  const req = (o: Partial<OrchaRequest>) => ({ id: "x", type: "q", status: "open", from: "forge", to: "mira", requester_id: "a1", target_id: "a2", ...o }) as OrchaRequest;
  it("nudges only when an AI agent other than you owns the next action", () => {
    expect(requestActions(snap, req({}), h).nudge).toBe(true); // open → target mira (AI)
    expect(requestActions(snap, req({ to: "kedar", target_id: "h1" }), h).nudge).toBe(false); // addressed to you
    expect(requestActions(snap, req({ to: "human", target_id: null }), h).nudge).toBe(false); // escalated to a human
    expect(requestActions(snap, req({ status: "answered" }), h).nudge).toBe(true); // answered → requester forge (AI)
    expect(requestActions(snap, req({ status: "answered", from: "kedar", requester_id: "h1" }), h).nudge).toBe(false); // your own answered ask
    expect(requestActions(snap, req({ status: "rejected" }), h).nudge).toBe(false);
  });
  it("terminal requests offer nothing", () => {
    const a = requestActions(snap, req({ status: "converted_to_task" }), h);
    expect(a.close || a.answer || a.nudge).toBe(false);
  });
});

describe("RequestsPage round 1", () => {
  it("object payloads render as prose + fields, never [object Object] or JSON", async () => {
    mount("/requests?req=r1");
    await waitFor(() => expect(detail()).toBeTruthy());
    await waitFor(() => expect(detail().querySelector(".wk-dtitle")?.textContent).toBe("Ship on Friday?"));
    const txt = visibleText(detail());
    expect(txt).not.toContain("[object Object]");
    expect(txt).not.toMatch(/\{"/);
    expect(txt).toContain("Context");
    expect(txt).toContain("Release train is full");
    expect(within(detail()).getByText("Raw payload")).toBeInTheDocument(); // nested shape → collapsible raw block
    // rows use the headline, not JSON
    const row = document.querySelector('.qrow[data-id="r1"]') as HTMLElement;
    expect(row.textContent).toContain("Ship on Friday?");
    expect(row.textContent).not.toMatch(/\{"/);
    // object responses render as fields too
    fireEvent.click(document.querySelector('.qrow[data-id="r2"]') as HTMLElement);
    await waitFor(() => expect(visibleText(detail())).toContain("Use the fast one"));
    expect(visibleText(detail())).toContain("Verified");
  });

  it("future expiry reads 'in 30m' (not 'just now')", async () => {
    mount("/requests?req=r1");
    await waitFor(() => expect(detail()).toBeTruthy());
    await waitFor(() => expect(visibleText(detail())).toMatch(/Expires.*in (29|30)m/));
    expect(visibleText(detail())).not.toContain("just now");
  });

  it("rows carry the exact status on the glyph (tooltip + sr text) and the direction filter persists as ?dir=", async () => {
    mount();
    await waitFor(() => expect(document.querySelectorAll(".qrow")).toHaveLength(4));
    const r2 = document.querySelector('.qrow[data-id="r2"]') as HTMLElement;
    const st = r2.querySelector('.rq-side [data-status="answered"]') as HTMLElement;
    expect(st.getAttribute("title")).toBe("Answered");
    expect(st.textContent).toBe("Answered"); // visually hidden label
    expect(r2.querySelector(".rq-meta")?.textContent).not.toContain("Answered"); // not repeated on the muted line
    fireEvent.click(screen.getByRole("button", { name: /Direction/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /To you/ }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("dir")).toBe("in"));
    const ids = () => Array.from(document.querySelectorAll(".qrow")).map((r) => r.getAttribute("data-id"));
    await waitFor(() => expect(ids()).toEqual(expect.arrayContaining(["r1", "r4"])));
    expect(ids()).not.toContain("r2");
    expect(ids()).not.toContain("r3");
  });

  it("?dir=out and ?dir=agents split outgoing and agent-to-agent traffic", async () => {
    mount("/requests?dir=out");
    await waitFor(() => expect(Array.from(document.querySelectorAll(".qrow")).map((r) => r.getAttribute("data-id"))).toEqual(["r3"]));
    cleanup();
    mount("/requests?dir=agents");
    await waitFor(() => expect(Array.from(document.querySelectorAll(".qrow")).map((r) => r.getAttribute("data-id"))).toEqual(["r2"]));
  });

  it("the answer composer replaces the action row (no second Answer button)", async () => {
    mount("/requests?req=r1");
    fireEvent.click(await screen.findByRole("button", { name: /^Answer$/ }));
    expect(await screen.findByRole("button", { name: /Send answer/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Answer$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Close…/ })).toBeNull();
  });

  it("an agent suggestion has one dominant action; answer/close move to the overflow menu", async () => {
    mount("/requests?req=r4");
    const create = await screen.findByRole("button", { name: /Create agent…/ });
    expect(create.className).toContain("v2-btn-primary");
    expect(screen.queryByRole("button", { name: /^Answer$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Nudge/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More suggestion actions" }));
    expect(await screen.findByRole("menuitem", { name: /Answer with text…/ })).toBeInTheDocument();
    // wave-4: Refuse moved into ⋯ (only Reassign + Create stay inline)
    expect(screen.getByRole("menuitem", { name: /Refuse suggestion…/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Refuse…$/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /Close request…/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("convert defaults the assignee to the agent that answered", async () => {
    mount("/requests?req=r3");
    // an answered QUESTION offers "Turn into a task" (secondary; Resolve is primary)
    fireEvent.click(await screen.findByRole("button", { name: /Turn into a task/ }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe("mira");
    expect((within(dialog).getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("Status of the migration?");
  });

  it("the header carries no count fragment and never repeats the request title (D12)", async () => {
    mount("/requests?req=r3");
    await waitFor(() => expect(detail()).toBeTruthy());
    expect(screen.queryByText("2 open · 4 total")).toBeNull();
    await waitFor(() => expect(detail().querySelector(".wk-dtitle")?.textContent).toBe("Status of the migration?"));
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toContain("Requests");
    expect(crumbs.textContent).not.toContain("Status of the migration?");
    expect(crumbs.textContent).not.toMatch(/#r3/);
  });
});
