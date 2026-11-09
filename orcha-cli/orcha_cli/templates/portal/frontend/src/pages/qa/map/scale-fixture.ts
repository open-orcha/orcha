/**
 * A big multi-platform app for the scale tests (`layout.test.ts`, `model.test.ts`): 60 features
 * (most of them small), 180 screens on web, iOS and Android, 350 navigation edges inside and
 * between features, and some screens no feature claims. With `endpoints` (and `entities`), a
 * backend the size of Nyumbani's: endpoints under fourteen path prefixes, each called by one to
 * three screens, reading and writing the entities. Deterministic: the same map every time.
 */
import { parseAppMap, type AppMap } from "./types";

const NAMES = [
  "Properties", "Property details", "Agents", "Agent profile", "Disputes", "Nyumba Plus", "Search", "Saved homes", "Viewings", "Messages",
  "Payments", "Rent schedule", "Maintenance requests", "Tenancy agreements", "Landlord dashboard", "Notifications", "Settings", "Help centre", "Onboarding", "Sign in",
];

/** A small seeded random, so the fixture never changes. */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PREFIXES = ["properties", "agents", "users", "auth", "payments", "messages", "viewings", "maintenance", "notifications", "search", "uploads", "reports", "admin", "favorites"];
const METHODS = ["GET", "GET", "GET", "POST", "PUT", "PATCH", "DELETE"];
const SIDES = ["client", "server", "both"];

export function scaleMap({ features = 60, screens = 180, edges = 350, other = 38, seed = 7, endpoints = 0, entities = 0 } = {}): AppMap {
  const r = rand(seed);
  const platforms = ["web", "ios", "android"];
  // Twelve big features hold most screens; the rest have one or two.
  const sizes = Array.from({ length: features }, (_, f) => (f < 12 ? 0 : 1 + (f % 2)));
  let left = screens - other - sizes.reduce((a, b) => a + b, 0);
  for (let f = 0; left > 0; f = (f + 1) % 12, left--) sizes[f]++;
  const nodes: Record<string, unknown>[] = [];
  const byFeature: string[][] = [];
  sizes.forEach((size, f) => {
    const ids: string[] = [];
    for (let s = 0; s < size; s++) {
      const id = `screen:f${f}-s${s}`;
      ids.push(id);
      nodes.push({ id, kind: "screen", key: `f${f}-s${s}`, label: `${NAMES[(f + s) % NAMES.length]} ${s}`, feature: `f${f}`, state: r() < 0.5 ? "seen" : "declared", frame_url: `/api/artifacts/qa-runs/r1/frames/f${f}-s${s}.jpg`, detail: { platform: platforms[(f + s) % 3] } });
    }
    byFeature.push(ids);
  });
  const others: string[] = [];
  for (let o = 0; o < other; o++) {
    others.push(`screen:other-${o}`);
    nodes.push({ id: `screen:other-${o}`, kind: "screen", key: `other-${o}`, label: `Untitled screen ${o}`, state: "seen", detail: { platform: platforms[o % 3] } });
  }
  const all = [...byFeature.flat(), ...others];
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (out.length < edges) {
    const f = Math.floor(r() * 12);
    const inner = r() < 0.6 && byFeature[f].length > 1;
    const from = inner ? byFeature[f][Math.floor(r() * byFeature[f].length)] : all[Math.floor(r() * all.length)];
    const to = inner ? byFeature[f][Math.floor(r() * byFeature[f].length)] : all[Math.floor(r() * all.length)];
    if (from === to || seen.has(`${from}>${to}`)) continue;
    seen.add(`${from}>${to}`);
    out.push({ id: `nav${out.length}`, kind: "navigates", from, to, label: `Tap "${NAMES[out.length % NAMES.length]}"`, count: 1 + Math.floor(r() * 6) });
  }
  // The backend comes after the navigation, so a map without one is the same map as ever.
  for (let k = 0; k < entities; k++) nodes.push({ id: `entity:e${k}`, kind: "entity", key: `e${k}`, label: `${NAMES[k % NAMES.length]} record`, detail: { store: "prisma" } });
  for (let i = 0; i < endpoints; i++) {
    const method = METHODS[Math.floor(r() * METHODS.length)];
    const pattern = `/api/${PREFIXES[i % PREFIXES.length]}/op${i}`;
    const id = `endpoint:${method} ${pattern}`;
    nodes.push({ id, kind: "endpoint", key: `${method} ${pattern}`, label: `${method} ${pattern}`, detail: { method, pattern, side: SIDES[i % 3] } });
    const callers = 1 + Math.floor(r() * 3);
    for (let c = 0; c < callers; c++) out.push({ id: `call${i}-${c}`, kind: "calls", from: all[Math.floor(r() * all.length)], to: id, count: 1 + Math.floor(r() * 4), sources: ["code"] });
    if (entities > 0) out.push({ id: `data${i}`, kind: method === "GET" ? "reads" : "writes", from: id, to: `entity:e${i % entities}`, sources: ["code"] });
  }
  return parseAppMap({
    features: Array.from({ length: features }, (_, f) => ({ key: `f${f}`, name: `${NAMES[f % NAMES.length]}${f >= NAMES.length ? ` ${Math.floor(f / NAMES.length) + 1}` : ""}`, coverage: f % 5 === 0 ? "thin" : "untested" })),
    nodes,
    edges: out,
  });
}
