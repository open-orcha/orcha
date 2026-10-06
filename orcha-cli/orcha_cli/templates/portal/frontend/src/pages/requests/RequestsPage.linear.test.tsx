/**
 * Linear Inbox layout (D5/D8/D10/D12) — pills + circular toolbar buttons,
 * two-line inbox items, the pager, the prose title/description split, chain +
 * activity as timelines, the decision card and the Composer answer flow.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { RequestsPage, _resetPendingAnswers } from "./RequestsPage";
import { splitHeadline } from "./requestPayload";

const T0 = Date.now();
const iso = (mins: number) => new Date(T0 + mins * 60_000).toISOString();

const RAW = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "forge", kind: "ai", status: "idle" },
    { id: "a2", alias: "mira", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  ],
  tasks: [],
  requests: [
    { id: "r1", type: "question", status: "open", priority: 3, requester_id: "a1", target_id: "h1", created_at: iso(-60),
      payload: "Should we ship on Friday? The release train is already full." },
    { id: "r2", type: "question", status: "answered", priority: 100, requester_id: "a2", target_id: "a1", created_at: iso(-50),
      parent_request_id: "r1", chain_depth: 1,
      payload: "Which parser?", response: "Use the fast one", responded_at: iso(-40) },
    { id: "r3", type: "info", status: "closed", priority: 100, requester_id: "a1", target_id: "a2", created_at: iso(-30),
      payload: "Old question", responded_at: iso(-20) },
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
const row = (id: string) => document.querySelector(`.qrow[data-id="${id}"]`) as HTMLElement;

describe("splitHeadline", () => {
  it("splits prose into a first-sentence title and the rest", () => {
    expect(splitHeadline("Should we ship on Friday? The train is full.")).toEqual({ title: "Should we ship on Friday?", rest: "The train is full." });
    expect(splitHeadline("One line, no stop")).toEqual({ title: "One line, no stop", rest: "" });
    expect(splitHeadline("## Plan\nstep one")).toEqual({ title: "Plan", rest: "step one" });
  });
  it("is null for objects, empty text and over-long first sentences", () => {
    expect(splitHeadline({ question: "Q?" })).toBeNull();
    expect(splitHeadline("   ")).toBeNull();
    expect(splitHeadline("x".repeat(240))).toBeNull();
  });
});

describe("Requests — Linear Inbox", () => {
  it("toolbar: filter pills carry counts; direction + sort are circular labelled buttons", async () => {
    mount();
    await waitFor(() => expect(document.querySelectorAll(".qrow")).toHaveLength(3));
    const pills = screen.getByRole("radiogroup", { name: "Filter requests" });
    const open = within(pills).getByRole("radio", { name: /^Open/ });
    expect(open.textContent).toBe("Open1");
    expect(within(pills).getByRole("radio", { name: /^All/ })).toHaveAttribute("aria-checked", "true");
    const dirBtn = screen.getByRole("button", { name: "Direction: All directions" });
    expect(dirBtn.className).toContain("v2-iconbtn");
    expect(screen.getByRole("button", { name: /^Sort: / }).className).toContain("v2-iconbtn");
    fireEvent.click(open);
    await waitFor(() => expect(new URLSearchParams(loc.search).get("filter")).toBe("open"));
    await waitFor(() => expect(document.querySelectorAll(".qrow")).toHaveLength(1));
  });

  it("inbox item: round avatar, headline, fully muted 'who → who · type' line, glyph + short age; no priority glyph", async () => {
    mount();
    await waitFor(() => expect(row("r1")).toBeTruthy());
    const r1 = row("r1");
    expect(r1.querySelector(".rq-av .v2-av")).toBeTruthy();
    expect(r1.querySelector(".rq-title")?.textContent).toBe("Should we ship on Friday?");
    expect(r1.querySelector(".rq-party")?.textContent).toBe("forge → you");
    // D10/D12: the meta line is fully muted — no coloured "you", no status word (the glyph carries it)
    expect(r1.querySelector(".rq-you")).toBeNull();
    expect(r1.querySelector("[class*='rq-tone-']")).toBeNull();
    expect(r1.querySelector(".rq-meta")?.textContent).toBe("forge → you· question");
    expect(r1.querySelector(".rq-side .v2-si")).toBeTruthy();
    expect(r1.querySelector('.rq-side [data-status="open"]')?.getAttribute("title")).toBe("Open");
    expect(r1.querySelector(".rq-age")?.textContent).toBe("1h");
    // Inbox rows carry no priority glyph (priority lives in Details)
    expect(r1.querySelector(".v2-prio, .rq-prio")).toBeNull();
    // two text lines max, no latest-activity line
    expect(r1.querySelectorAll(".wk-main > *")).toHaveLength(2);
  });

  it("detail: title once (prose split), pager navigates, header keeps Project / Requests", async () => {
    mount("/requests?req=r1");
    await waitFor(() => expect(detail()?.querySelector(".wk-dtitle")?.textContent).toBe("Should we ship on Friday?"));
    const desc = detail().querySelector(".payload") as HTMLElement;
    expect(desc.textContent).toContain("The release train is already full.");
    expect(desc.textContent).not.toContain("Should we ship on Friday?");
    const pager = within(detail()).getByRole("group", { name: /request 1 of 3/ });
    expect(pager.textContent).toContain("1 / 3");
    fireEvent.click(within(pager).getByRole("button", { name: "Next request" }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("req")).toBe("r2"));
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).not.toContain("Which parser?");
  });

  it("chain and activity render as timelines; the answer is a comment card", async () => {
    mount("/requests?req=r2");
    await waitFor(() => expect(detail()?.querySelector(".wk-dtitle")?.textContent).toBe("Which parser?"));
    const chain = within(detail()).getByRole("list", { name: "Request chain" });
    expect(chain.className).toContain("v2-tl");
    const cur = chain.querySelector('[aria-current="true"]') as HTMLElement;
    expect(cur.textContent).toContain("mira → forge");
    fireEvent.click(within(chain).getByRole("button", { name: /forge → you/ }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("req")).toBe("r1"));
  });

  it("activity: 'sent' event + answer card; closed shows a closed event and no decision card", async () => {
    mount("/requests?req=r2");
    await waitFor(() => expect(detail()?.querySelector(".wk-dtitle")).toBeTruthy());
    const act = within(detail()).getByRole("list", { name: "Request activity" });
    expect(act.textContent).toMatch(/mira\s*sent a question request to\s*forge/);
    const card = act.querySelector(".v2-tl-card") as HTMLElement;
    expect(card.textContent).toContain("answered");
    expect(card.querySelector(".answer")?.textContent).toContain("Use the fast one");
    fireEvent.click(row("r3"));
    await waitFor(() => expect(detail().querySelector(".wk-dtitle")?.textContent).toBe("Old question"));
    expect(within(detail()).getByRole("list", { name: "Request activity" }).textContent).toContain("Closed — no further action");
    expect(within(detail()).queryByRole("region", { name: "Your move" })).toBeNull();
  });

  it("decision card: one row, the acting-human boilerplate lives in a help tooltip", async () => {
    mount("/requests?req=r1");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "forge asks you" }));
    expect(card.className).toContain("is-inline");
    expect(card.textContent).not.toContain("every action is logged");
    expect(within(card).getByRole("img", { name: /Acting as kedar · every action is logged/ })).toBeTruthy();
    // the primary action is the last (right-most) button
    const btns = within(card).getAllByRole("button");
    expect(btns[btns.length - 1].textContent).toBe("Answer");
  });

  it("answering uses the Composer: Enter sends the exact respond body", async () => {
    mount("/requests?req=r1");
    fireEvent.click(await screen.findByRole("button", { name: /^Answer$/ }));
    const box = (await screen.findByPlaceholderText(/forge sees it verbatim/)) as HTMLTextAreaElement;
    expect(box.id).toBe("ansIn");
    expect(box.closest(".v2-composer")).toBeTruthy();
    fireEvent.change(box, { target: { value: "Yes, ship it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/requests/r1/respond");
      expect(c?.body).toEqual({ responder_agent_id: "h1", response: "Yes, ship it" });
    });
  });

  it("a filter that matches nothing leaves no unrelated request open", async () => {
    mount("/requests?q=zzzz");
    expect(await screen.findByText("No requests match")).toBeInTheDocument();
    expect(detail()).toBeNull();
  });

  it("Shift+Enter in the answer does not send", async () => {
    mount("/requests?req=r1");
    fireEvent.click(await screen.findByRole("button", { name: /^Answer$/ }));
    const box = (await screen.findByPlaceholderText(/forge sees it verbatim/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((x) => x.url === "/api/requests/r1/respond")).toBe(false);
  });
});
