/** V2 project switching (arch §4): full ?cid= navigation, same section, entity params dropped. */
import { describe, expect, it } from "vitest";
import { projectSwitchHref, withCidForced } from "./scope";

describe("projectSwitchHref", () => {
  it("keeps a project-scoped section and its filters, drops entity ids, sets the target cid", () => {
    expect(projectSwitchHref("c2", "/tasks", "?cid=c1&task=t9&status=open&q=login")).toBe("/tasks?cid=c2&status=open&q=login");
    expect(projectSwitchHref("c2", "/requests", "?req=r1&cid=c1")).toBe("/requests?cid=c2");
    expect(projectSwitchHref("c2", "/code", "?path=src/a.ts&line=4&thread=x&ref=main")).toBe("/code?cid=c2");
    expect(projectSwitchHref("c2", "/needs", "?item=verify:t1&scope=project")).toBe("/needs?scope=project&cid=c2");
  });
  it("non-project pages land on the target's Overview", () => {
    expect(projectSwitchHref("c2", "/projects", "")).toBe("/?cid=c2");
    expect(projectSwitchHref("c2", "/onboarding", "?new=1")).toBe("/?cid=c2");
    expect(projectSwitchHref("c2", "/auth/device", "")).toBe("/?cid=c2");
  });
  it("encodes odd cids safely", () => {
    expect(projectSwitchHref("a b&c", "/", "")).toBe("/?cid=a+b%26c");
  });
});

describe("withCidForced", () => {
  it("replaces an existing cid (target project wins) and keeps the hash", () => {
    expect(withCidForced("/settings?cid=c1#tab=pairing", "c2")).toBe("/settings?cid=c2#tab=pairing");
  });
});
