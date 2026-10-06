/** wave-4 Settings: one person, one colour — a human named by GitHub login
 *  (Members, GitHub) gets the same roster slot as by alias (sidebar footer). */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const roster = {
  agents: [
    { alias: "lead" }, { alias: "backend-dev" }, { alias: "hussein", github_login: "husseinmohamed" },
    { alias: "amina", github_login: "amina-yusuf-abdirahman" }, { alias: "qa-bot" },
    // a login equal to another actor's alias never steals that alias's slot
    { alias: "tomas", github_login: "lead" },
  ],
};
vi.mock("../../state/SnapshotProvider", () => ({ useSnapshot: () => ({ snap: roster }) }));

import { Avatar, rosterPaletteSlots } from "./Avatar";

afterEach(cleanup);
const bg = (el: Element) => (el as HTMLElement).style.background;

describe("D13 roster palette: GitHub login ↔ alias", () => {
  it("Members (alias = login, with photo fallback) and the sidebar footer (alias) paint the same colour", () => {
    const { container } = render(
      <>
        <Avatar alias="amina" kind="human" decorative />
        <Avatar alias="amina-yusuf-abdirahman" ghLogin="amina-yusuf-abdirahman" kind="human" decorative />
      </>,
    );
    const [a, b] = [...container.querySelectorAll(".v2-av")];
    expect(bg(a)).toBe(bg(b));
    expect(bg(a)).not.toBe("");
  });

  it("a login that is another actor's alias keeps that actor's slot", () => {
    const m = rosterPaletteSlots(roster.agents)!;
    expect(m.get("lead")).not.toBe(m.get("tomas"));
    expect(m.get("husseinmohamed")).toBe(m.get("hussein"));
  });
});
