/**
 * ISS-331 reusable sort control (Time/Priority + asc/desc) — faithful port of
 * app.js sortState/sortControlHtml/sortComparator. Each surface instantiates it
 * with a stable `name` (its own persisted localStorage choice) and passes field
 * accessors {bucket,time,prio}. Semantics mirror the server _sort_clause: the
 * status `bucket` stays the OUTER key, the chosen key sorts within it, the
 * unchosen key is the tiebreaker.
 */
import { useState } from "react";

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

/** The control itself — same .sortctl markup/class names as sortControlHtml. */
export function SortCtl({ name, onChange }: { name: string; onChange: () => void }) {
  const [, tick] = useState(0);
  const st = sortState(name);
  const arrow = st.dir === "asc" ? "↑" : "↓";
  const dirLabel =
    st.key === "time"
      ? st.dir === "asc" ? "oldest first" : "newest first"
      : st.dir === "asc" ? "highest priority first" : "lowest priority first";
  const pickKey = (k: "time" | "priority") => {
    if (k === st.key) return; // no-op click on the already-active key
    setSortState(name, { key: k, dir: k === "time" ? "desc" : "asc" }); // reset to the key's natural default
    tick((n) => n + 1);
    onChange();
  };
  const flip = () => {
    setSortState(name, { ...st, dir: st.dir === "asc" ? "desc" : "asc" });
    tick((n) => n + 1);
    onChange();
  };
  return (
    <span className="sortctl" data-sort={name} role="group" aria-label="Sort order">
      <button type="button" className={st.key === "time" ? "on" : ""} aria-pressed={st.key === "time"} onClick={() => pickKey("time")}>
        Time
      </button>
      <button type="button" className={st.key === "priority" ? "on" : ""} aria-pressed={st.key === "priority"} onClick={() => pickKey("priority")}>
        Priority
      </button>
      <button type="button" className="sortdir" aria-label={`Toggle direction — ${dirLabel}`} title={dirLabel} onClick={flip}>
        {arrow}
      </button>
    </span>
  );
}
