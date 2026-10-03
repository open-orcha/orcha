/** Desktop embedded-mode detection + message validation (arch §7). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHost, isEmbedded, isSafePath, parseHostMessage, sendToHost, syncEmbedAttribute } from "./host";

afterEach(() => {
  delete window.orchaHost;
  document.documentElement.removeAttribute("data-embed");
});

const host = (caps: string[] = ["sidebar"]) => ({
  version: 1, capabilities: caps, project: "orcha-x", send: vi.fn(), on: vi.fn(() => () => {}),
});

describe("host capability detection", () => {
  it("plain browser: no host, not embedded, hint removed", () => {
    document.documentElement.setAttribute("data-embed", "desktop"); // stale hint
    expect(getHost()).toBeNull();
    expect(isEmbedded()).toBe(false);
    expect(syncEmbedAttribute()).toBe(false);
    expect(document.documentElement.hasAttribute("data-embed")).toBe(false);
  });

  it("v1 host with the sidebar capability → embedded", () => {
    window.orchaHost = host();
    expect(getHost()).not.toBeNull();
    expect(isEmbedded()).toBe(true);
    expect(syncEmbedAttribute()).toBe(true);
    expect(document.documentElement.getAttribute("data-embed")).toBe("desktop");
  });

  it("host without the sidebar capability → web mode (portal keeps its sidebar)", () => {
    window.orchaHost = host(["notifications"]);
    expect(isEmbedded()).toBe(false);
  });

  it("wrong version / malformed objects are ignored", () => {
    window.orchaHost = { ...host(), version: 2 };
    expect(getHost()).toBeNull();
    window.orchaHost = { version: 1, capabilities: "sidebar" };
    expect(getHost()).toBeNull();
  });

  it("sendToHost swallows host errors", () => {
    const h = host();
    h.send.mockImplementation(() => { throw new Error("gone"); });
    window.orchaHost = h;
    expect(() => sendToHost({ type: "ready", version: 1 })).not.toThrow();
  });
});

describe("inbound host messages", () => {
  it("navigate accepts only single-slash same-origin paths", () => {
    expect(parseHostMessage({ type: "navigate", path: "/tasks?task=1&cid=c" })).toEqual({ type: "navigate", path: "/tasks?task=1&cid=c" });
    expect(parseHostMessage({ type: "navigate", path: "//evil.example" })).toBeNull();
    expect(parseHostMessage({ type: "navigate", path: "/\\evil" })).toBeNull();
    expect(parseHostMessage({ type: "navigate", path: "https://evil.example" })).toBeNull();
    expect(isSafePath("javascript:alert(1)")).toBe(false);
  });
  it("openSearch / hostModal shapes; unknown types dropped", () => {
    expect(parseHostMessage({ type: "openSearch" })).toEqual({ type: "openSearch" });
    expect(parseHostMessage({ type: "hostModal", open: true })).toEqual({ type: "hostModal", open: true });
    expect(parseHostMessage({ type: "hostModal", open: "yes" })).toBeNull();
    expect(parseHostMessage({ type: "runShell", cmd: "rm -rf /" })).toBeNull();
    expect(parseHostMessage(null)).toBeNull();
  });
});
