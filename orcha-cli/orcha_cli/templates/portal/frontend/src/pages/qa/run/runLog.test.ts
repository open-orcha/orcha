import { describe, expect, it, vi } from "vitest";
import { behindWords, deviceWord, getRunLog, headline, MAX_LINES, mergeEntries, type RunLogEntry } from "./runLog";

const line = (id: string, at: string, text = id): RunLogEntry => ({ id, at, level: "info", kind: "step", text });
const T = Date.parse("2026-11-05T10:02:14Z");

describe("the run log", () => {
  it("keeps every line, in time order, and takes a changed line in place", () => {
    const have = [line("a", "2026-11-05T10:00:00Z"), line("b", "2026-11-05T10:00:05Z", "Reading the code")];
    const got = mergeEntries(have, [line("b", "2026-11-05T10:00:05Z", "Reading the code (2)"), line("c", "2026-11-05T10:00:02Z")]);
    expect(got.map((e) => e.id)).toEqual(["a", "c", "b"]);
    expect(got[2].text).toBe("Reading the code (2)");
  });

  it("an empty poll changes nothing, so nothing renders again", () => {
    const have = [line("a", "2026-11-05T10:00:00Z")];
    expect(mergeEntries(have, [])).toBe(have);
  });

  it("holds a long run to the newest lines", () => {
    const many = Array.from({ length: MAX_LINES + 5 }, (_, i) => line(`l${i}`, new Date(T + i * 1000).toISOString()));
    const got = mergeEntries([], many);
    expect(got).toHaveLength(MAX_LINES);
    expect(got[got.length - 1].id).toBe(`l${MAX_LINES + 4}`);
  });

  it("says what waits and for how long, and ticks", () => {
    const now = { state: "waiting", level: "wait", text: "Waiting for iPhone 17 Pro · held by another tool", since: "2026-11-05T10:00:00Z" } as const;
    expect(headline(now, T)).toBe("Waiting for iPhone 17 Pro · held by another tool · 2:14");
    expect(headline(now, T + 1000)).toBe("Waiting for iPhone 17 Pro · held by another tool · 2:15");
    expect(headline({ state: "building", level: "info", text: "Building the app", since: "2026-11-05T09:58:12Z" }, T)).toBe("Building the app · 4:02");
    expect(headline({ state: "working", level: "info", text: "QAEngineer is reading the code", since: "2026-11-05T10:00:00Z" }, T)).toBe("QAEngineer is reading the code");
    expect(headline({ state: "done", level: "done", text: "This run finished" }, T)).toBe("This run finished");
  });

  it("names a device the short way", () => {
    expect(deviceWord("iPad Pro 13-inch (M5)")).toBe("iPad Pro");
    expect(deviceWord("iPhone 17 Pro")).toBe("iPhone 17 Pro");
  });

  it("only mentions slowness once the page is really behind", () => {
    expect(behindWords(null, T)).toBeNull();
    expect(behindWords(T - 5_000, T)).toBeNull();
    expect(behindWords(T - 74_000, T)).toBe("Embodent is slow to answer · last update 1:14 ago");
  });

  it("asks for what is new", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getRunLog({ taskId: "t1", sessionId: "s1" }, "2026-11-05T10:00:00+00:00");
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/qa/run-log?task_id=t1&session_id=s1&after=2026-11-05T10%3A00%3A00%2B00%3A00");
    vi.unstubAllGlobals();
  });
});
