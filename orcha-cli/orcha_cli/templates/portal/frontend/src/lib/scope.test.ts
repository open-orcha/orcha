/**
 * Project-scope (?cid=) propagation: resolution (multi-container detection),
 * replaceState pinning, and the document-level capture-phase link interceptor.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cidFromUrl,
  ensureCidInLocation,
  installCidLinkInterceptor,
  resolveCidScope,
  withCid,
  type CidScope,
} from "./scope";

const setUrl = (path: string) => history.replaceState(null, "", path);

afterEach(() => {
  vi.unstubAllGlobals();
  setUrl("/");
  document.body.innerHTML = "";
});

const containersFetch = (containers: unknown) =>
  vi.fn(async () => ({ ok: true, json: async () => containers }) as unknown as Response);

describe("resolveCidScope", () => {
  it("?cid= wins and implies multi-container (no /api/containers fetch)", async () => {
    setUrl("/tasks?cid=c9");
    const f = containersFetch([]);
    vi.stubGlobal("fetch", f);
    expect(await resolveCidScope()).toEqual({ cid: "c9", multi: true });
    expect(f).not.toHaveBeenCalled();
  });

  it("single container → multi=false", async () => {
    vi.stubGlobal("fetch", containersFetch([{ id: "c1", status: "active" }]));
    expect(await resolveCidScope()).toEqual({ cid: "c1", multi: false });
  });

  it("multiple containers → the active one, multi=true", async () => {
    vi.stubGlobal("fetch", containersFetch([
      { id: "c1", status: "stopped" },
      { id: "c2", status: "active" },
    ]));
    expect(await resolveCidScope()).toEqual({ cid: "c2", multi: true });
  });

  it("handles the {containers:[...]} envelope shape too", async () => {
    vi.stubGlobal("fetch", containersFetch({ containers: [{ id: "c1" }, { id: "c2" }] }));
    expect(await resolveCidScope()).toEqual({ cid: "c1", multi: true });
  });
});

describe("withCid / cidFromUrl", () => {
  it("appends cid preserving existing query and hash", () => {
    expect(withCid("/tasks", "c1")).toBe("/tasks?cid=c1");
    expect(withCid("/tasks?task=5#top", "c1")).toBe("/tasks?task=5&cid=c1#top");
  });
  it("leaves an existing cid untouched", () => {
    expect(withCid("/tasks?cid=zz", "c1")).toBe("/tasks?cid=zz");
  });
  it("cidFromUrl reads the current location", () => {
    setUrl("/agents?cid=abc&x=1");
    expect(cidFromUrl()).toBe("abc");
    setUrl("/agents");
    expect(cidFromUrl()).toBeNull();
  });
});

describe("ensureCidInLocation (history.replaceState pinning)", () => {
  it("multi: replaceState's ?cid= in, preserving path and other params", () => {
    setUrl("/tasks?task=t1");
    ensureCidInLocation({ cid: "c1", multi: true });
    expect(window.location.pathname).toBe("/tasks");
    expect(new URLSearchParams(window.location.search).get("task")).toBe("t1");
    expect(new URLSearchParams(window.location.search).get("cid")).toBe("c1");
  });

  it("single-container: no-op (no URL noise)", () => {
    setUrl("/tasks?task=t1");
    ensureCidInLocation({ cid: "c1", multi: false });
    expect(window.location.search).toBe("?task=t1");
  });

  it("never overwrites a cid already in the URL", () => {
    setUrl("/tasks?cid=other");
    ensureCidInLocation({ cid: "c1", multi: true });
    expect(new URLSearchParams(window.location.search).get("cid")).toBe("other");
  });

  it("unknown cid: no-op", () => {
    setUrl("/tasks");
    ensureCidInLocation({ cid: null, multi: true });
    expect(window.location.search).toBe("");
  });
});

describe("installCidLinkInterceptor (capture-phase href upgrade)", () => {
  // swallow the navigation jsdom would otherwise attempt (bubble phase runs
  // AFTER the capture-phase interceptor has already rewritten the href).
  const swallow = (e: Event) => e.preventDefault();

  function clickAnchor(attrs: Record<string, string>, scope: CidScope = { cid: "c1", multi: true }, init: MouseEventInit = {}) {
    const un = installCidLinkInterceptor(() => scope);
    document.addEventListener("click", swallow);
    const a = document.createElement("a");
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    const span = document.createElement("span"); // click a CHILD — closest('a') must resolve
    a.appendChild(span);
    document.body.appendChild(a);
    span.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    document.removeEventListener("click", swallow);
    un();
    return a.getAttribute("href");
  }

  it("upgrades a same-origin internal link, respecting its existing query", () => {
    expect(clickAnchor({ href: "/requests?req=9" })).toBe("/requests?req=9&cid=c1");
    expect(clickAnchor({ href: "/tasks" })).toBe("/tasks?cid=c1");
  });

  it("single-container stack: complete no-op", () => {
    expect(clickAnchor({ href: "/tasks" }, { cid: "c1", multi: false })).toBe("/tasks");
    expect(clickAnchor({ href: "/tasks" }, { cid: null, multi: true })).toBe("/tasks");
  });

  it("skips modified clicks, targeted links, downloads, hash-only and external links", () => {
    expect(clickAnchor({ href: "/tasks" }, undefined, { metaKey: true })).toBe("/tasks");
    expect(clickAnchor({ href: "/tasks" }, undefined, { ctrlKey: true })).toBe("/tasks");
    expect(clickAnchor({ href: "/tasks" }, undefined, { shiftKey: true })).toBe("/tasks");
    expect(clickAnchor({ href: "/tasks", target: "_blank" })).toBe("/tasks");
    expect(clickAnchor({ href: "/file.tgz", download: "" })).toBe("/file.tgz");
    expect(clickAnchor({ href: "#top" })).toBe("#top");
    expect(clickAnchor({ href: "https://example.com/x" })).toBe("https://example.com/x");
  });

  it("leaves links that already carry a cid alone", () => {
    expect(clickAnchor({ href: "/tasks?cid=other" })).toBe("/tasks?cid=other");
  });

  it("uninstaller removes the listener", () => {
    const un = installCidLinkInterceptor(() => ({ cid: "c1", multi: true }));
    un();
    document.addEventListener("click", swallow);
    const a = document.createElement("a");
    a.setAttribute("href", "/tasks");
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.removeEventListener("click", swallow);
    expect(a.getAttribute("href")).toBe("/tasks");
  });
});
