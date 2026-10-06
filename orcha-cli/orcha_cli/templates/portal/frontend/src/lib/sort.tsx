/**
 * ISS-331 reusable sort control (Time/Priority + asc/desc) — faithful port of
 * app.js sortState/sortControlHtml/sortComparator. Each surface instantiates it
 * with a stable `name` (its own persisted localStorage choice) and passes field
 * accessors {bucket,time,prio}. Semantics mirror the server _sort_clause: the
 * status `bucket` stays the OUTER key, the chosen key sorts within it, the
 * unchosen key is the tiebreaker.
 */
import { useState } from "react";
import { MenuButton } from "../components/primitives/Menu";

export interface SortState {
  key: "time" | "priority";
  dir: "asc" | "desc";
}
export interface SortAcc<T> {
  bucket: (x: T) => number;
  time: (x: T) => number;
  prio: (x: T) => number;
}

const SORT_DEFAULT: SortState = { key: "time", dir: "desc" }; // "Time-sort is the higher-priority key"

export function sortState(name: string): SortState {
  try {
    const raw = JSON.parse(localStorage.getItem("orcha:sort:" + name) || "null") as SortState | null;
    if (raw && (raw.key === "time" || raw.key === "priority") && (raw.dir === "asc" || raw.dir === "desc")) return raw;
  } catch {
    /* corrupt / private mode */
  }
  return { ...SORT_DEFAULT };
}
function setSortState(name: string, st: SortState): void {
  try {
    localStorage.setItem("orcha:sort:" + name, JSON.stringify(st));
  } catch {
    /* private mode */
  }
}

// comparator mirroring server _sort_clause; acc = {bucket(item)->int, time(item)->ms, prio(item)->number}
export function sortComparator<T>(name: string, acc: SortAcc<T>): (a: T, b: T) => number {
  const st = sortState(name);
  const sign = st.dir === "asc" ? 1 : -1;
  return (a, b) => {
    const bk = acc.bucket(a) - acc.bucket(b);
    if (bk) return bk;
    if (st.key === "priority") {
      const d = acc.prio(a) - acc.prio(b); // lower number = higher priority
      if (d) return sign * d;
      return acc.time(b) - acc.time(a); // tiebreak: newest first
    }
    const d = acc.time(a) - acc.time(b);
    if (d) return sign * d; // asc = oldest first, desc = newest first
    return acc.prio(a) - acc.prio(b); // tiebreak: highest priority first
  };
}

/** The four sort choices, in menu order (key + its natural direction first). */
export const SORT_OPTIONS: { st: SortState; label: string; short: string }[] = [
  { st: { key: "time", dir: "desc" }, label: "Newest first", short: "Newest" },
  { st: { key: "time", dir: "asc" }, label: "Oldest first", short: "Oldest" },
  { st: { key: "priority", dir: "asc" }, label: "Highest priority first", short: "Priority" },
  { st: { key: "priority", dir: "desc" }, label: "Lowest priority first", short: "Lowest priority" },
];

/** Persist a sort choice for `name` (the same orcha:sort:<name> key SortCtl reads). */
export function pickSort(name: string, st: SortState): void {
  setSortState(name, st);
}

/**
 * The control itself. V2 (screen review, D2): one compact ghost menu button
 * ("Sort: Newest ▾") instead of the old filled-accent Time/Priority/↑↓
 * segment, so it matches every other toolbar control, sizes to its content
 * and never stretches at narrow widths. Same persisted state + semantics as
 * the vanilla sortControlHtml (`data-sort` kept on the wrapper).
 */
export function SortCtl({ name, onChange, menuLabel = "Sort order" }: { name: string; onChange: () => void; menuLabel?: string }) {
  const [, tick] = useState(0);
  const st = sortState(name);
  const cur = SORT_OPTIONS.find((o) => o.st.key === st.key && o.st.dir === st.dir) ?? SORT_OPTIONS[0];
  const pick = (next: SortState) => {
    if (next.key === st.key && next.dir === st.dir) return; // no-op on the active choice
    setSortState(name, next);
    tick((n) => n + 1);
    onChange();
  };
  return (
    <span className="sortctl-v2" data-sort={name}>
      <MenuButton
        variant="ghost"
        size="sm"
        label="Sort"
        value={cur.short}
        title={"Sort: " + cur.label}
        menuLabel={menuLabel}
        placement="bottom-end"
        items={SORT_OPTIONS.map((o) => ({ label: o.label, checked: o === cur, onSelect: () => pick(o.st) }))}
      />
    </span>
  );
}
