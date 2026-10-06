import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay } from "./feed";

const NOW = new Date(2026, 8, 28, 15, 0, 0).getTime(); // local Sep 28 2026, 15:00
const at = (d: number, h = 10) => new Date(2026, 8, d, h, 0, 0).toISOString();

describe("activity day grouping", () => {
  it("labels Today / Yesterday / older days, and never files a bad date under today", () => {
    expect(dayLabel(at(28), NOW)).toBe("Today");
    expect(dayLabel(at(27, 23), NOW)).toBe("Yesterday");
    expect(dayLabel(at(22), NOW)).not.toMatch(/Today|Yesterday/);
    expect(dayLabel(null, NOW)).toBe("Date unknown");
    expect(dayLabel("not a date", NOW)).toBe("Date unknown");
  });

  it("groups in the incoming (newest-first) order and puts undated items last", () => {
    const items = [
      { id: "a", t: at(28, 12) },
      { id: "x", t: null },
      { id: "b", t: at(28, 9) },
      { id: "c", t: at(27) },
      { id: "d", t: at(20) },
    ];
    const g = groupByDay(items, (i) => i.t, NOW);
    expect(g.map((x) => x.label.replace(/,.*/, ""))).toEqual(["Today", "Yesterday", expect.any(String), "Date unknown"]);
    expect(g[0].items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(g[g.length - 1].items.map((i) => i.id)).toEqual(["x"]);
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(items.length);
  });
});
