/**
 * Parity e2e-permissions-7 / SG-09 / SG-10 + wave-4 picker items:
 *  · someone who can't change the icon (viewer, non-member, member without
 *    manage_autonomy, offline) is told why — no grid, no PUT, no silent revert;
 *  · a trust-off save is attributed to the acting human (actor_agent_id);
 *  · Icons tab: a glyph pick keeps the picker open so a colour can follow, and a
 *    colour with no glyph yet says what to do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";

const ctx = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ctx.value,
  actingHuman: (snap: { agents?: { id: string; kind: string }[] } | null) => snap?.agents?.find((a) => a.kind === "human") ?? null,
}));

import { ProjectIconPicker } from "./EmojiPicker";
import * as icons from "../../cloud/projects/projectIcons";
import { resetIconAccess } from "../../cloud/projects/iconAccess";

const SNAP = { container: { id: "c1", name: "Website" }, agents: [{ id: "11111111-1111-4111-8111-111111111111", alias: "kedar", kind: "human" }] };
const base = { snap: SNAP, identity: null, identityTrusted: false, identityPending: false, identityUnverified: false, connection: "live" };

let puts: { url: string; body: Record<string, unknown> }[] = [];
function stub(me: unknown) {
  puts = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/me")) return { ok: true, status: 200, json: async () => me } as unknown as Response;
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push({ url, body });
      return { ok: true, status: 200, json: async () => ({ icon: body.icon }) } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

function Harness({ cid, onClose = () => {} }: { cid: string; onClose?: () => void }) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (<><button ref={anchor}>anchor</button><ProjectIconPicker cid={cid} name="Website" anchor={anchor} open onClose={onClose} /></>);
}

beforeEach(() => { ctx.value = { ...base }; });
afterEach(() => { cleanup(); localStorage.clear(); icons._resetProjectIconsForTests(); resetIconAccess(); vi.restoreAllMocks(); });

describe("ProjectIconPicker — gated like PUT /icon", () => {
  it("viewer on the current project: says why, offers no grid, sends nothing", async () => {
    stub({});
    ctx.value = { ...base, identity: { agent_id: "v1", member_role: "viewer" }, identityTrusted: true };
    render(<Harness cid="c1" />);
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("You can't change this project's icon.");
    expect(note).toHaveTextContent("Your role is viewer (read-only)");
    expect(document.querySelector("[data-cell]")).toBeNull();
    expect(puts).toHaveLength(0);
  });

  it("member without manage_autonomy on ANOTHER project (asked via /api/me?cid=): says it needs the grant", async () => {
    stub({ identity: { agent_id: "m1", member_role: "member", grants: ["manage_keys"] }, trusted: true });
    render(<Harness cid="c2" />);
    expect(await screen.findByRole("note")).toHaveTextContent(/Autonomy permission/);
    expect((global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe("/api/me?cid=c2");
  });

  it("a trusted non-member of another project is refused with the non-member reason", async () => {
    stub({ identity: null, trusted: true });
    render(<Harness cid="c2" />);
    expect(await screen.findByRole("note")).toHaveTextContent(/not a member/);
  });

  it("offline on the current project: read-only with the offline reason", async () => {
    stub({});
    ctx.value = { ...base, connection: "offline" };
    render(<Harness cid="c1" />);
    expect(await screen.findByRole("note")).toHaveTextContent(/Offline/);
  });

  it("member WITH manage_autonomy gets the full picker", async () => {
    stub({});
    ctx.value = { ...base, identity: { agent_id: "m1", member_role: "member", grants: ["manage_autonomy"] }, identityTrusted: true };
    render(<Harness cid="c1" />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(document.querySelector("[data-cell]")).not.toBeNull();
  });

  it("trust off: the save carries the acting human as actor_agent_id (audit is not 'system')", async () => {
    stub({});
    render(<Harness cid="c1" />);
    fireEvent.click(document.querySelector<HTMLElement>("[data-cell]")!);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toBe("/api/containers/c1/icon");
    expect(puts[0].body.actor_agent_id).toBe(SNAP.agents[0].id);
  });
});

describe("ProjectIconPicker — Icons tab: glyph, then colour, in one visit", () => {
  it("a glyph pick saves and stays open; a colour after it saves {glyph, color}; swatches are named", async () => {
    stub({});
    const onClose = vi.fn();
    render(<Harness cid="c1" onClose={onClose} />);
    const dlg = screen.getByRole("dialog");
    fireEvent.click(within(dlg).getByRole("tab", { name: "Icons" }));
    // no glyph yet: the colour row says what a colour needs
    expect(within(dlg).getByText("Pick an icon to apply this colour.")).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "database" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dlg).queryByText("Pick an icon to apply this colour.")).toBeNull();
    const blue = within(dlg).getByRole("radio", { name: "Blue" });
    expect(blue).toHaveAttribute("title", "Blue");
    fireEvent.click(blue);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].body.icon).toEqual({ kind: "glyph", value: "database", color: 7 });
    expect(icons.projectIcons().c1).toEqual({ kind: "glyph", value: "database", color: 7 });
  });
});
