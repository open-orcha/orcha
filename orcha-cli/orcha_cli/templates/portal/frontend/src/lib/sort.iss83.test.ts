/**
 * ISS-83 / ISS-331 tests, ported from the pytest node harness that used to
 * eval static/app.js (tests/test_iss83_recency_band_sort.py):
 *  - the retained recencyTs/recencyBand helpers (ISS-83, kept for reuse);
 *  - sortComparator behavior (ISS-331): status bucket OUTER in both modes,
 *    user-chosen key within — SUPERSEDING the within-group recency float.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { recencyBand, recencyTs } from "./format";
import { sortComparator, type SortAcc } from "./sort";

const H = 3600 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe("ISS-83 recency band helper (retained for reuse)", () => {
  it("recencyTs picks the NEWEST of any supplied ISO timestamps (0 if none parse)", () => {
    // compute the newest input ONCE — two separate iso(2*H) calls can differ by
    // a millisecond and made this assertion flaky.
    const newest = iso(2 * H);
    expect(recencyTs(iso(10 * H), newest, iso(30 * H))).toBe(Date.parse(newest));
    expect(recencyTs(null, "", undefined)).toBe(0);
  });
  it("recencyBand: 0 inside the ~12h window, 1 outside — recent sorts above stale", () => {
    expect(recencyBand(iso(1 * H))).toBe(0);
    expect(recencyBand(iso(11.5 * H))).toBe(0); // edge just inside
    expect(recencyBand(iso(24 * H))).toBe(1);
    expect(recencyBand(iso(13 * H))).toBe(1); // edge just outside
    expect(recencyBand(iso(48 * H), iso(1 * H))).toBe(0); // updated-recently wins
    expect(recencyBand(null, "")).toBe(1); // no timestamp -> stale
    expect(recencyBand(iso(1 * H)) - recencyBand(iso(48 * H))).toBeLessThan(0); // recent first as a sort key
  });
});

/* ---- ISS-331 comparator: status bucket outer + supersedes the recency float
   MUTATION TEETH:
     - drop the bucket key  -> 'a' (newest overall, stale bucket) floats to top
     - re-insert a recency float above priority -> recent 'c' jumps old high-prio 'd' */
interface Row { id: string; bucket: number; time: number; prio: number }
const acc: SortAcc<Row> = { bucket: (t) => t.bucket, time: (t) => t.time, prio: (t) => t.prio };
// two status buckets (0=top, 1=lower); within bucket-0 vary time & priority
const items: Row[] = [
  { id: "a", bucket: 1, time: 1000, prio: 10 }, // lower bucket, newest overall, high prio
  { id: "b", bucket: 0, time: 1, prio: 50 }, // top bucket, oldest, low prio
  { id: "c", bucket: 0, time: 999, prio: 50 }, // top bucket, recent, low prio
  { id: "d", bucket: 0, time: 5, prio: 10 }, // top bucket, old, HIGH prio
];
const setMode = (name: string, key: string, dir: string) =>
  localStorage.setItem("orcha:sort:" + name, JSON.stringify({ key, dir }));

describe("ISS-331 sortComparator supersedes the ISS-83 within-group float", () => {
  beforeEach(() => localStorage.clear());

  it("status bucket stays the OUTER key in both modes", () => {
    setMode("t", "priority", "asc");
    const byPrio = items.slice().sort(sortComparator("t", acc)).map((x) => x.id);
    setMode("t", "time", "desc");
    const byTimeDesc = items.slice().sort(sortComparator("t", acc)).map((x) => x.id);
    // 'a' (the only bucket-1 row) is LAST in both modes even though it is the
    // newest overall — a global sort ignoring buckets would surface it first.
    expect(byPrio[byPrio.length - 1]).toBe("a");
    expect(byTimeDesc[byTimeDesc.length - 1]).toBe("a");
  });

  it("priority mode: old HIGH-prio beats recent LOW-prio within the bucket (no recency float)", () => {
    setMode("t", "priority", "asc");
    const byPrio = items.slice().sort(sortComparator("t", acc)).map((x) => x.id);
    // an ISS-83 recency band above priority would float 'c' over 'd'
    expect(byPrio.indexOf("d")).toBeLessThan(byPrio.indexOf("c"));
  });

  it("time-desc within the bucket: newest first", () => {
    setMode("t", "time", "desc");
    const byTimeDesc = items.slice().sort(sortComparator("t", acc)).map((x) => x.id);
    expect(byTimeDesc.indexOf("c")).toBeLessThan(byTimeDesc.indexOf("d")); // c(999) before d(5)
    expect(byTimeDesc.indexOf("d")).toBeLessThan(byTimeDesc.indexOf("b")); // d(5) before b(1)
  });
});
