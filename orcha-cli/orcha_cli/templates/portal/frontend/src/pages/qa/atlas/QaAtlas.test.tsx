// @vitest-environment jsdom
/** The entry: the skeleton while it reads, the atlas the portal answers, a failed read and its Try
 * again, and the view the URL names. `orcha.fixture.json` is what `GET .../qa/atlas` answered. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const api = vi.hoisted(() => ({ getAtlas: vi.fn() }));
vi.mock("./atlasApi", () => api);

import type { QaNav } from "../QaPage";
import { seenCell, seenRows } from "./model";
import sample from "./orcha.fixture.json";
import { QaAtlas } from "./QaAtlas";
import { parseAtlas } from "./types";

function nav(search = "", over: Partial<QaNav> = {}): QaNav {
  const url = new URLSearchParams(search);
  return {
    platform: "ios",
    goBack: () => undefined,
    get: (k) => url.get(k),
    set: vi.fn(),
    nonce: 0,
    refresh: vi.fn(),
    runQa: vi.fn(),
    auth: { can: true, reason: null } as unknown as QaNav["auth"],
    ...over,
  };
}

const at = (search: string, n: QaNav) => (
  <MemoryRouter initialEntries={[`/qa?${search}`]}>
    <QaAtlas cid="c1" nav={n} />
  </MemoryRouter>
);

beforeEach(() => {
  api.getAtlas.mockReset();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

describe("QaAtlas", () => {
  it("shows its skeleton, then the atlas the portal answered", async () => {
    let answer: (v: unknown) => void = () => {};
    api.getAtlas.mockReturnValue(new Promise((r) => (answer = r)));
    const { container } = render(at("", nav()));
    expect(container.querySelector("[data-atlas-skeleton]")).not.toBeNull();
    await act(async () => answer(sample));
    expect(api.getAtlas).toHaveBeenCalledWith("c1", null, expect.anything());
    expect(container.querySelector("[data-atlas-skeleton]")).toBeNull();
    expect(container.querySelectorAll("[data-atlas-card]")).toHaveLength(2);
    expect(container.querySelector("[data-atlas-frame=shot] img")?.getAttribute("src")).toMatch(/^\/api\/qa\/frames\//);
    expect(container.textContent).toContain("Not compared yet");
  });

  it("opens the screen and the filters the URL names", async () => {
    api.getAtlas.mockResolvedValue(sample);
    const screen = (sample as { screens: { id: string; name: string }[] }).screens.find((s) => s.name === "Cart")!;
    const search = `screen=${screen.id}&filter=changed&since=2026-01-02`;
    const { container } = render(at(search, nav(search)));
    await act(async () => {});
    expect(api.getAtlas).toHaveBeenCalledWith("c1", "2026-01-02", expect.anything());
    expect(document.querySelector(`[data-atlas-detail="${screen.id}"]`)).not.toBeNull();
    expect(container.querySelector('[data-atlas-filter="changed"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("says when the atlas could not be read, and tries again", async () => {
    api.getAtlas.mockRejectedValueOnce(new Error("The portal did not answer"));
    const n = nav();
    const { container, rerender } = render(at("", n));
    await act(async () => {});
    expect(container.querySelector("[data-atlas-load-error]")?.textContent).toContain("The portal did not answer");
    fireEvent.click(container.querySelector("[data-atlas-load-error] button")!);
    expect(n.refresh).toHaveBeenCalled();
    api.getAtlas.mockResolvedValue(sample);
    await act(async () => rerender(at("", { ...n, nonce: 1 })));
    expect(container.querySelector("[data-atlas-load-error]")).toBeNull();
    expect(container.querySelectorAll("[data-atlas-card]")).toHaveLength(2);
  });
});

describe("Seen on with no word on light or dark", () => {
  const atlas = parseAtlas(sample);
  const cart = atlas.screens.find((s) => s.name === "Cart")!;
  const blind = { ...cart, seen_on: cart.seen_on.map((l) => ({ ...l, appearance: null })) };

  it("has one row per kind of device, and each cell its look", () => {
    const rows = seenRows(atlas, blind);
    expect(rows.map((r) => r.label)).toEqual(["Phone", "Tablet"]);
    expect(seenCell(blind, "ios", rows[0])?.frame_url).toMatch(/^\/api\/qa\/frames\//);
  });
});
