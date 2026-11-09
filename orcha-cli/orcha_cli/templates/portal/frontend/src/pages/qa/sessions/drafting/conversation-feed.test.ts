// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionExplorer } from "./lib/drafting-board";
import type { DraftingSession } from "./lib/types";
import { ConversationFeed } from "./conversation-feed";
import type { DraftingBoard } from "./use-drafting-board";

afterEach(cleanup);

// The drafter finished 43 s in, the explorer queued behind a busy iPhone.
const SESSION = {
  id: "d6694a41",
  status: "finished",
  explorer_status: "queued",
  pairing: "workflow",
  deadline_at: "2026-10-29T03:51:00.286Z",
  explorer_joined_at: null,
  note: null,
  updated_at: "2026-10-29T03:40:43.151Z",
} as DraftingSession;
const IPHONE: SessionExplorer = { id: "f64709f0", status: "queued", device: "iPhone 17 Pro", target_kind: "ios" };
const FEED = [{ id: "e1", seq: 1, kind: "status", actor: null, to: null, text: "Drafting finished: 0 criteria verified on screen, 0 unconfirmed, 6 code only", detail: null, thumb: null, at: "2026-10-29T03:40:43.151Z" }];

function board(session: DraftingSession, explorers: SessionExplorer[]): DraftingBoard {
  return { session, explorers, events: [], feed: FEED, plan: [], requests: [], waiting: 0, screens: 0, evidence: new Map() } as unknown as DraftingBoard;
}

const line = () => document.querySelector("[data-conversation-status]")?.textContent;

describe("ConversationFeed while the explorer waits for its device", () => {
  it("says the explorer waits for the named device, and stays live, until it joins", () => {
    render(createElement(ConversationFeed, { board: board(SESSION, [IPHONE]) }));
    expect(line()).toBe("Drafter done · the explorer is waiting for iPhone 17 Pro");
    expect(document.body.textContent).not.toContain("Explored and drafted");
    expect(document.querySelector("[data-conversation-feed] .animate-ping-slow")).not.toBeNull();
  });

  it("says Drafted together once the explorer joined and ended", () => {
    const done = { ...SESSION, explorer_status: "finished", explorer_joined_at: "2026-10-29T03:46:42.594Z" } as DraftingSession;
    render(createElement(ConversationFeed, { board: board(done, [{ ...IPHONE, status: "completed" }]) }));
    expect(line()).toBe("Explored and drafted.");
    expect(document.querySelector("[data-conversation-feed] .animate-ping-slow")).toBeNull();
  });

  it("names the device in the empty feed too", () => {
    const live = { ...SESSION, status: "live" } as DraftingSession;
    render(createElement(ConversationFeed, { board: { ...board(live, [IPHONE]), feed: [] } as DraftingBoard }));
    expect(document.body.textContent).toContain("The explorer starts when iPhone 17 Pro is free, with its full time");
  });
});
