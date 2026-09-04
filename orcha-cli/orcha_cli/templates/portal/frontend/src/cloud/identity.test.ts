/**
 * identity.ts — the /api/me layer: exact fetch shape, single-flight per cid,
 * fail-open (401/404/network/bad JSON -> null identity, trust off), the
 * Extensions.identity seam, the acting-identity accessors, and the sign-out
 * account menu (vanilla app-shell.js actingMenuHtml parity).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensions } from "../extensions";
import type { Snapshot } from "../types";
import {
  accountMenu, actingGrant, actingOwner, fetchIdentity, fetchMe, memActor,
  resetIdentity, SIGN_OUT_HREF, viewerOnly, viewerRole, type Me,
} from "./identity";

const IDENT = {
  agent_id: "h2",
  alias: "sam",
  github_login: "sam-gh",
  member_role: "member",
  avatar_url: "https://github.com/sam-gh.png",
  grants: ["manage_keys"],
};

function stubFetch(impl: (url: string) => Promise<Response> | Response) {
  const fn = vi.fn(async (input: RequestInfo | URL) => impl(String(input)));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}
const json = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => data }) as unknown as Response;

beforeEach(() => resetIdentity());
afterEach(() => vi.restoreAllMocks());

describe("fetchMe — wire shape + single flight", () => {
  it("GETs /api/me?cid=<cid> and passes {identity, trusted} through", async () => {
    const fn = stubFetch(() => json({ identity: IDENT, trusted: true }));
    const me = await fetchMe("c1");
    expect(fn).toHaveBeenCalledWith("/api/me?cid=c1");
    expect(me).toEqual({ identity: IDENT, trusted: true });
  });

  it("URL-encodes the cid", async () => {
    const fn = stubFetch(() => json({ identity: null, trusted: false }));
    await fetchMe("c 1/x");
    expect(fn).toHaveBeenCalledWith("/api/me?cid=c%201%2Fx");
  });

  it("no cid -> no network call, the self-host envelope (vanilla data.js)", async () => {
    const fn = stubFetch(() => json({}));
    expect(await fetchMe(null)).toEqual({ identity: null, trusted: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it("single-flights per cid; a different cid re-asks", async () => {
    const fn = stubFetch(() => json({ identity: IDENT, trusted: true }));
    await Promise.all([fetchMe("c1"), fetchMe("c1")]);
    await fetchMe("c1");
    expect(fn).toHaveBeenCalledTimes(1);
    await fetchMe("c2");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("fetchMe — fail-open to the legacy (self-host) state", () => {
  it("401 -> {identity:null, trusted:false}", async () => {
    stubFetch(() => json({ detail: "unauthorized" }, 401));
    expect(await fetchMe("c1")).toEqual({ identity: null, trusted: false });
  });

  it("404 -> {identity:null, trusted:false}", async () => {
    stubFetch(() => json({ detail: "not found" }, 404));
    expect(await fetchMe("c1")).toEqual({ identity: null, trusted: false });
  });

  it("network error -> {identity:null, trusted:false}", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await fetchMe("c1")).toEqual({ identity: null, trusted: false });
  });

  it("malformed JSON -> {identity:null, trusted:false}", async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } }) as unknown as Response);
    expect(await fetchMe("c1")).toEqual({ identity: null, trusted: false });
  });
});

describe("fetchIdentity — the Extensions.identity seam", () => {
  it("resolves the identity object (and is what extensions registers)", async () => {
    stubFetch(() => json({ identity: IDENT, trusted: true }));
    expect(await fetchIdentity("c1")).toEqual(IDENT);
    expect(extensions.identity).toBe(fetchIdentity);
  });

  it("resolves null on failure (fail-open) and with no cid", async () => {
    stubFetch(() => json({}, 401));
    expect(await fetchIdentity("c1")).toBeNull();
    expect(await fetchIdentity(null)).toBeNull();
  });
});

describe("accountMenu — sign-out menu (app-shell.js parity)", () => {
  it("signed-in member: the one Sign out row, full-navigation href to /oauth2/sign_out", () => {
    const items = accountMenu(IDENT);
    expect(items).toEqual([{ label: "Sign out", href: SIGN_OUT_HREF, danger: true }]);
    expect(SIGN_OUT_HREF).toBe("/oauth2/sign_out?rd=%2Fwelcome");
    expect(items[0].onClick).toBeUndefined(); // plain <a> navigation — the proxy owns the redirect
    expect(extensions.accountMenu).toBe(accountMenu);
  });

  it("trusted viewer (identity null, trusted true): Sign out stays reachable", async () => {
    stubFetch(() => json({ identity: null, trusted: true }));
    await fetchMe("c1");
    expect(accountMenu(null)).toEqual([{ label: "Sign out", href: SIGN_OUT_HREF, danger: true }]);
  });

  it("self-host / trust off (identity null, trusted false): no menu", async () => {
    stubFetch(() => json({ identity: null, trusted: false }));
    await fetchMe("c1");
    expect(accountMenu(null)).toEqual([]);
    resetIdentity();
    expect(accountMenu(null)).toEqual([]); // nothing resolved yet -> no menu either
  });
});

describe("acting-identity accessors (app-data.js parity)", () => {
  const snap = {
    container: { id: "c1" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", member_role: "owner" },
      { id: "h2", alias: "sam", kind: "human", member_role: "member" },
    ],
  } as unknown as Snapshot;
  const meOf = (identity: Me["identity"], trusted: boolean): Me => ({ identity, trusted });

  it("trusted identity binds the actor; a trusted NON-member never falls back", () => {
    expect(memActor(meOf(IDENT, true), snap)?.id).toBe("h2");
    expect(memActor(meOf(null, true), snap)).toBeNull(); // viewer: no fallback actor
    expect(viewerOnly(meOf(null, true))).toBe(true);
  });

  it("trust off falls back to the local acting human (first human)", () => {
    expect(memActor(meOf(null, false), snap)?.id).toBe("h1");
  });

  it("actingOwner: identity role decides; trust off is permissive on the snapshot", () => {
    expect(actingOwner(meOf({ ...IDENT, member_role: "owner" }, true), snap)).toBe(true);
    expect(actingOwner(meOf(IDENT, true), snap)).toBe(false);
    expect(actingOwner(meOf(null, false), snap)).toBe(true); // h1 is owner
  });

  it("actingGrant: owners hold everything; members need the grant listed", () => {
    expect(actingGrant(meOf({ ...IDENT, member_role: "owner", grants: [] }, true), snap, "manage_members")).toBe(true);
    expect(actingGrant(meOf(IDENT, true), snap, "manage_keys")).toBe(true);
    expect(actingGrant(meOf(IDENT, true), snap, "manage_members")).toBe(false);
  });

  it("viewerRole keys off the identity's project role", () => {
    expect(viewerRole(meOf({ ...IDENT, member_role: "viewer" }, true))).toBe(true);
    expect(viewerRole(meOf(IDENT, true))).toBe(false);
  });
});
