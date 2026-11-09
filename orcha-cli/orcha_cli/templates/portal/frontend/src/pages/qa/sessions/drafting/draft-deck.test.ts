// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement as h, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { QaAuthority } from "../../authority";
import type { Scenario } from "./lib/types";
import { DraftDeck } from "./draft-deck";

afterEach(cleanup);

const AUTH: QaAuthority = { can: true, human: { id: "h1" } as QaAuthority["human"], reason: null };
const READ_ONLY: QaAuthority = { can: false, human: null, reason: "View-only" };

function draft(id: string, name: string): Scenario {
  return {
    id,
    name,
    status: "draft",
    category: null,
    criteria: ["The booking shows on the calendar"],
    depends_on: [],
    tags: [],
    feedback: [],
    data: {},
    target_kind: null,
    created_at: "2026-10-05T10:00:00Z",
  } as unknown as Scenario;
}

/** The deck with a parent that marks an accepted draft validated, as the drafting page does. */
function Harness({ auth = AUTH }: { auth?: QaAuthority }) {
  const [drafts, setDrafts] = useState<Scenario[]>([
    draft("a", "Book a viewing for Saturday"),
    draft("b", "Cancel a viewing"),
    draft("c", "Reschedule a viewing"),
  ]);
  const accept = (id: string) => setDrafts((list) => list.map((d) => (d.id === id ? { ...d, status: "validated" } : d)));
  return h(DraftDeck, {
    drafts,
    pendingIds: new Set<string>(),
    errors: new Map(),
    feedbackDrafts: new Map(),
    onFeedbackChange: () => undefined,
    onRevise: () => undefined,
    onAccept: accept,
    onDiscard: () => undefined,
    onAcceptAll: () => undefined,
    onAcceptRemaining: () => undefined,
    recentlyUpdatedIds: new Set<string>(),
    initialView: "list",
    auth,
  });
}

const position = () => document.querySelector("[data-deck-position]")?.textContent;

describe("DraftDeck list view ", () => {
  it("counts accepted drafts as they are accepted in the list, and Cards opens on the next undecided one", () => {
    render(h(Harness));
    expect(position()).toBe("0 of 3 accepted");
    fireEvent.click(document.querySelector("[data-draft-card='a'] [data-draft-row]")!);
    fireEvent.click(document.querySelector("[data-draft-card='a'] [data-draft-list-accept]")!);
    expect(position()).toBe("1 of 3 accepted");
    fireEvent.click(screen.getByRole("button", { name: /Cards/ }));
    expect(position()).toBe("Reviewing 2 of 3");
  });

  it("leaves accepting and discarding to a person, by click and by key", () => {
    render(h(Harness, { auth: READ_ONLY }));
    fireEvent.click(screen.getByRole("button", { name: /Cards/ }));
    expect(document.querySelector<HTMLButtonElement>("[data-draft-accept]")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("[data-draft-discard]")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("[data-accept-all]")?.disabled).toBe(true);
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "d" });
    expect(document.querySelector("[data-draft-discard-armed]")).toBeNull();
    expect(position()).toBe("Reviewing 1 of 3");
  });
});
