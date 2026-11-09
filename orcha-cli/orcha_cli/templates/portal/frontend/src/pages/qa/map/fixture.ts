/**
 * A home-rentals app's map, as the map's JSON gives it: the tests' shared fixture
 * (`types.test.ts`, `layout.test.ts`, `model.test.ts`). Four features, eleven screens in all three
 * states, endpoints on the app and the server, three Prisma models and one on-device store, and
 * two flows from XCUITest.
 */

const code = (path: string, line: number) => [{ path, line }];
const live = (runs: number, at: string) => ({ runs, last_run_id: "run-2041", last_seen_at: at });

function screen(key: string, label: string, feature: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    id: `screen:${key}`,
    kind: "screen",
    key,
    label,
    feature,
    state,
    blocked_reason: null,
    frame_url: state === "seen" ? `/api/artifacts/runs/run-2041/frames/${key}.png` : null,
    evidence: {
      code: code(`ios/Rentals/Views/${label.replace(/\s+/g, "")}View.swift`, 14),
      tests: [],
      live: state === "seen" ? live(4, "2026-10-20T16:42:00Z") : {},
    },
    detail: { route: null, platform: "ios", actions: [] },
    ...extra,
  };
}

function endpoint(method: string, pattern: string, side: string) {
  return {
    id: `endpoint:${method} ${pattern}`,
    kind: "endpoint",
    key: `${method} ${pattern}`,
    label: `${method} ${pattern}`,
    feature: null,
    state: side === "server" ? "declared" : "seen",
    evidence: { code: code(`web/app${pattern.replace("*", "[id]")}/route.ts`, 8), tests: [], live: side === "server" ? {} : live(9, "2026-10-20T16:41:10Z") },
    detail: { method, pattern, side, statuses: [200], body_keys: [], handler: { path: `web/app${pattern.replace("*", "[id]")}/route.ts`, line: 8 } },
  };
}

function entity(key: string, label: string, store: string, fields: string[]) {
  return {
    id: `entity:${key}`,
    kind: "entity",
    key,
    label,
    feature: null,
    state: "declared",
    evidence: { code: code(store === "prisma" ? "web/prisma/schema.prisma" : `ios/Rentals/Models/${label}.swift`, 20), tests: [], live: {} },
    detail: { store, fields },
  };
}

let n = 0;
function edge(kind: string, from: string, to: string, extra: Record<string, unknown> = {}) {
  n += 1;
  return { id: `e${n}`, kind, from, to, label: null, count: 1, sources: ["code"], ...extra };
}

export const RENTALS_MAP_JSON = {
  project_id: "proj-rentals",
  built_at: "2026-10-21T09:00:00Z",
  build: { id: "build-7", status: "done", started_at: "2026-10-21T08:59:12Z", finished_at: "2026-10-21T09:00:00Z", error: null },
  sources: {
    code: { at: "2026-10-21T08:59:20Z", repo: "/Users/mary/rentals", screens: 11, edges: 22, endpoints: 6, entities: 4 },
    tests: { at: "2026-10-21T08:59:31Z", tests: 2, flows: 2, frameworks: ["xcuitest"] },
    live: { at: "2026-10-21T08:59:58Z", runs: 12, last_run_id: "run-2041" },
  },
  counts: { features: 4, screens: 11, seen: 5, declared: 4, blocked: 2, endpoints: 6, entities: 4, flows: 2, edges: 29 },
  features: [
    { key: "listings", name: "Listings", summary: "Browse, search and save homes to rent", screens: 4, seen: 3, coverage: "covered" },
    { key: "viewings", name: "Viewings", summary: "Book and manage viewings", screens: 3, seen: 1, coverage: "thin" },
    { key: "messages", name: "Messages", summary: "Talk to letting agents", screens: 2, seen: 0, coverage: "untested" },
    { key: "account", name: "Account", summary: "Sign in and profile", screens: 2, seen: 1, coverage: "thin" },
  ],
  nodes: [
    screen("listings", "Listings", "listings", "seen", { detail: { route: "/listings", platform: "ios", actions: ["Tap a listing", "Open map", "Save"] } }),
    screen("listing-detail", "Listing detail", "listings", "seen", {
      detail: { route: "/listings/*", platform: "ios", actions: ["Book a viewing", "Message the agent"] },
      evidence: {
        code: code("ios/Rentals/Views/ListingDetailView.swift", 12),
        tests: [{ path: "ios/RentalsUITests/BookingTests.swift", test_name: "testBookViewingFromListing", line: 40, framework: "xcuitest" }],
        live: live(7, "2026-10-20T16:42:00Z"),
      },
    }),
    screen("map-search", "Map search", "listings", "declared"),
    screen("saved", "Saved listings", "listings", "seen"),
    screen("book-viewing", "Book a viewing", "viewings", "seen", {
      evidence: {
        code: code("ios/Rentals/Views/BookViewingView.swift", 9),
        tests: [{ path: "ios/RentalsUITests/BookingTests.swift", test_name: "testBookViewingFromListing", line: 52, framework: "xcuitest" }],
        live: live(4, "2026-10-20T16:43:30Z"),
      },
    }),
    screen("viewing-confirmed", "Viewing confirmed", "viewings", "declared", {
      evidence: { code: [], tests: [{ path: "ios/RentalsUITests/BookingTests.swift", test_name: "testBookViewingFromListing", line: 61, framework: "xcuitest" }], live: {} },
    }),
    screen("my-viewings", "My viewings", "viewings", "blocked", { blocked_reason: "Needs sign-in" }),
    screen("inbox", "Inbox", "messages", "blocked", { blocked_reason: "Needs a conversation to exist" }),
    screen("conversation", "Conversation", "messages", "declared"),
    screen("sign-in", "Sign in", "account", "seen"),
    screen("profile", "Profile", "account", "declared"),
    endpoint("GET", "/api/listings", "both"),
    endpoint("GET", "/api/listings/*", "both"),
    endpoint("POST", "/api/viewings", "server"),
    endpoint("GET", "/api/viewings", "client"),
    endpoint("GET", "/api/messages", "client"),
    endpoint("POST", "/api/session", "both"),
    entity("listing", "Listing", "prisma", ["id", "title", "rent", "bedrooms"]),
    entity("viewing", "Viewing", "prisma", ["id", "listingId", "startsAt"]),
    entity("user", "User", "prisma", ["id", "email", "name"]),
    entity("savedlisting", "SavedListing", "swiftdata", ["listingId", "savedAt"]),
    {
      id: "flow:book-a-viewing",
      kind: "flow",
      key: "book-a-viewing",
      label: "testBookViewingFromListing",
      feature: "viewings",
      state: "declared",
      evidence: { code: [], tests: [{ path: "ios/RentalsUITests/BookingTests.swift", test_name: "testBookViewingFromListing", line: 38, framework: "xcuitest" }], live: {} },
      detail: {},
    },
    {
      id: "flow:sign-in",
      kind: "flow",
      key: "sign-in",
      label: "testSignInWithEmail",
      feature: "account",
      state: "declared",
      evidence: { code: [], tests: [{ path: "ios/RentalsUITests/AccountTests.swift", test_name: "testSignInWithEmail", line: 12, framework: "xcuitest" }], live: {} },
      detail: {},
    },
  ],
  edges: [
    edge("navigates", "screen:listings", "screen:listing-detail", { label: "Tap a listing", count: 7, sources: ["code", "live"] }),
    edge("navigates", "screen:listing-detail", "screen:book-viewing", { label: "Tap Book a viewing", count: 4, sources: ["code", "tests", "live"] }),
    edge("navigates", "screen:book-viewing", "screen:viewing-confirmed", { label: "Tap Confirm", sources: ["code", "tests"] }),
    edge("navigates", "screen:listings", "screen:map-search", { label: "Tap Map" }),
    edge("navigates", "screen:listings", "screen:saved", { label: "Tap Saved", count: 2, sources: ["code", "live"] }),
    edge("navigates", "screen:sign-in", "screen:listings", { label: "Tap Sign in", count: 5, sources: ["code", "live"] }),
    edge("navigates", "screen:listing-detail", "screen:conversation", { label: "Tap Message the agent" }),
    edge("navigates", "screen:inbox", "screen:conversation", { label: "Tap a conversation" }),
    edge("navigates", "screen:profile", "screen:my-viewings", { label: "Tap My viewings" }),
    edge("navigates", "screen:sign-in", "screen:profile", { label: "Tap Profile" }),
    edge("navigates", "screen:book-viewing", "screen:sign-in", { label: "Sign in to book", count: 2, sources: ["live"] }),
    edge("calls", "screen:listings", "endpoint:GET /api/listings", { count: 9, sources: ["code", "live"] }),
    edge("calls", "screen:listing-detail", "endpoint:GET /api/listings/*", { count: 7, sources: ["code", "live"] }),
    edge("calls", "screen:book-viewing", "endpoint:POST /api/viewings", { count: 2, sources: ["code", "live"] }),
    edge("calls", "screen:my-viewings", "endpoint:GET /api/viewings"),
    edge("calls", "screen:inbox", "endpoint:GET /api/messages"),
    edge("calls", "screen:sign-in", "endpoint:POST /api/session", { count: 5, sources: ["code", "live"] }),
    edge("reads", "endpoint:GET /api/listings", "entity:listing"),
    edge("reads", "endpoint:GET /api/listings/*", "entity:listing"),
    edge("writes", "endpoint:POST /api/viewings", "entity:viewing", { sources: ["code", "live"] }),
    edge("reads", "endpoint:GET /api/viewings", "entity:viewing"),
    edge("writes", "endpoint:POST /api/session", "entity:user"),
    edge("writes", "screen:saved", "entity:savedlisting", { sources: ["code"] }),
    edge("steps", "flow:book-a-viewing", "screen:listings", { order: 0, sources: ["tests"] }),
    edge("steps", "flow:book-a-viewing", "screen:listing-detail", { order: 1, sources: ["tests"] }),
    edge("steps", "flow:book-a-viewing", "screen:book-viewing", { order: 2, sources: ["tests"] }),
    edge("steps", "flow:book-a-viewing", "screen:viewing-confirmed", { order: 3, sources: ["tests"] }),
    edge("steps", "flow:sign-in", "screen:sign-in", { order: 0, sources: ["tests"] }),
    edge("steps", "flow:sign-in", "screen:profile", { order: 1, sources: ["tests"] }),
  ],
};
