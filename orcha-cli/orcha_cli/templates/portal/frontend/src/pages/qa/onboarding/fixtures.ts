/**
 * Onboarding map fixtures that follow the shared contract exactly, for the unit tests, the
 * Playwright proof and the UI while the core route is being built. Three apps, all invented:
 * Cabaz (a grocery shop, 12 screens, XCUITest and Playwright), Little Days (a baby log like
 * Snug Log, 40 screens, XCUITest and Espresso) and Halden (a marketplace, 250 screens, every
 * framework). `fixtureAt` steps a full fixture back to what the snapshot holds at a phase, so a
 * test (or the Playwright mock) can walk the flow phase by phase.
 */
import { MAP_PHASES, type FirstRunVerdict, type Framework, type LiveRun, type MapPhase, type MapScreen, type OnboardingMap, type PhaseInfo, type PlatformKind } from "./contract";

interface AreaSpec {
  key: string;
  label: string;
  screens: string[];
  critical?: boolean;
  endpoints: string[];
}

interface AppSpec {
  projectId: string;
  name: string;
  repoPath: string;
  folder: string;
  platforms: { kind: PlatformKind; app_id?: string; stack: string; path: string }[];
  areas: AreaSpec[];
  frameworks: { framework: Framework; path: string; tests: number }[];
  env: { name: string; base_url?: string }[];
  device: string;
  testData: string;
  ci?: { provider: string; path: string }[];
  ext: string;
  tint: string;
  seed: number;
}

/** A small deterministic PRNG (mulberry32): the same fixture every time. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pascal = (s: string) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c: string) => c.toUpperCase());

/** A tiny screenshot of the screen as an SVG data URL: the app's bar, the title, a few rows. */
export function thumbnailFor(app: string, screen: string, tint: string, i: number): string {
  const rows = [0, 1, 2, 3]
    .map((r) => `<rect x="10" y="${58 + r * 26}" width="${r % 2 ? 70 : 100}" height="14" rx="3" fill="#e7e5e0"/><rect x="${r % 2 ? 90 : 116}" y="${58 + r * 26}" width="14" height="14" rx="3" fill="${tint}" opacity=".5"/>`)
    .join("");
  const hero = i % 3 === 0 ? `<rect x="10" y="40" width="120" height="10" rx="2" fill="${tint}" opacity=".18"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="200" viewBox="0 0 140 200"><rect width="140" height="200" fill="#fbfaf7"/><rect width="140" height="30" fill="${tint}"/><text x="10" y="20" font-family="Helvetica,Arial" font-size="10" font-weight="700" fill="#fff">${app}</text><text x="10" y="44" font-family="Helvetica,Arial" font-size="9" fill="#2b2a28">${screen.replace(/&/g, "and")}</text>${hero}${rows}<rect x="10" y="172" width="120" height="18" rx="9" fill="${tint}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const EVIDENCE: Record<Framework, (screen: string, verb: string) => string> = {
  xcuitest: (s, v) => `app.buttons["${v}"].tap(), then XCTAssert(app.staticTexts["${s}"].exists)`,
  espresso: (s, v) => `onView(withText("${v}")).perform(click()); onView(withId(R.id.${slug(s).replace(/-/g, "_")}_title)).check(matches(isDisplayed()))`,
  maestro: (s, v) => `- tapOn: "${v}"\n- assertVisible: "${s}"`,
  detox: (s, v) => `await element(by.text('${v}')).tap(); await expect(element(by.text('${s}'))).toBeVisible()`,
  playwright: (s, v) => `await page.getByRole('button', { name: '${v}' }).click(); await expect(page.getByRole('heading', { name: '${s}' })).toBeVisible()`,
  cypress: (s, v) => `cy.contains('button', '${v}').click(); cy.contains('h1', '${s}').should('be.visible')`,
  gherkin: (s, v) => `When I tap "${v}"\nThen I see "${s}"`,
};

const TEST_FILE: Record<Framework, (area: string) => string> = {
  xcuitest: (a) => `${pascal(a)}UITests.swift`,
  espresso: (a) => `${pascal(a)}Test.kt`,
  maestro: (a) => `${slug(a)}.yaml`,
  detox: (a) => `${slug(a)}.e2e.ts`,
  playwright: (a) => `${slug(a)}.spec.ts`,
  cypress: (a) => `${slug(a)}.cy.ts`,
  gherkin: (a) => `${slug(a)}.feature`,
};

/** The full (finished) map for an app spec: every phase done, the tests found, nothing in yet. */
function buildApp(spec: AppSpec): OnboardingMap {
  const rand = rng(spec.seed);
  const screens: MapScreen[] = [];
  const fileLinks = new Map<string, Set<string>>();
  const link = (path: string, id: string) => {
    const set = fileLinks.get(path) ?? new Set<string>();
    set.add(id);
    fileLinks.set(path, set);
  };
  const edges: OnboardingMap["edges"] = [];
  let idx = 0;
  // An area's key is its name as a route segment ("Sign in" is /sign-in): the map titles areas
  // from the route, so the name on the map and in the gaps agree.
  for (const a of spec.areas) a.key = slug(a.label);
  for (const area of spec.areas) {
    const shared = `${spec.folder}/${pascal(area.label)}/${pascal(area.label)}Store.${spec.ext}`;
    area.screens.forEach((name, i) => {
      const id = `${area.key}-${slug(name)}`;
      const view = `${spec.folder}/${pascal(area.label)}/${pascal(name)}${spec.ext === "swift" ? "View" : "Screen"}.${spec.ext}`;
      const files = [view];
      if (i % 2 === 0 || area.screens.length < 4) files.push(shared);
      if (rand() < 0.22) files.push(`${spec.folder}/Shared/Components/${["PriceTag", "Avatar", "EmptyState", "ListRow", "Toast"][Math.floor(rand() * 5)]}.${spec.ext}`);
      for (const f of files) link(f, id);
      const endpoints = area.endpoints.filter((_, k) => (k + i) % 2 === 0 || area.endpoints.length === 1).slice(0, 2);
      screens.push({
        id,
        name,
        route: `/${area.key}${i === 0 ? "" : `/${slug(name)}`}`,
        platform: spec.platforms[idx % spec.platforms.length].kind,
        source: "both",
        thumbnail: thumbnailFor(spec.name, name, spec.tint, idx),
        files,
        endpoints,
        coverage: "none",
        tests: [],
        scenarios: [],
        risk: { score: 0, reasons: [] },
      });
      if (i > 0) edges.push({ from: `${area.key}-${slug(area.screens[i - 1])}`, to: id, kind: "nav" });
      idx += 1;
    });
  }
  // Every area is reached from the first screen (the home or the timeline), and a few cross links.
  const hub = screens[0].id;
  for (const area of spec.areas.slice(1)) edges.push({ from: hub, to: `${area.key}-${slug(area.screens[0])}`, kind: "nav" });
  for (let k = 0; k < Math.floor(screens.length / 6); k++) {
    const a = screens[Math.floor(rand() * screens.length)];
    const b = screens[Math.floor(rand() * screens.length)];
    if (a.id !== b.id && !edges.some((e) => e.from === a.id && e.to === b.id)) edges.push({ from: a.id, to: b.id, kind: "nav" });
  }

  // The existing tests: each walks a short flow through one area, critical areas first.
  const areaOrder = [...spec.areas].sort((a, b) => Number(Boolean(b.critical)) - Number(Boolean(a.critical)));
  for (const fw of spec.frameworks) {
    for (let t = 0; t < fw.tests; t++) {
      // Leave the most critical area of each app without tests: that is the gap worth finding.
      const pool = areaOrder.filter((a, k) => !(a.critical && k === 0) && a.screens.length > 0);
      const area = pool[(t * 3 + spec.frameworks.indexOf(fw)) % pool.length];
      const start = Math.floor(rand() * Math.max(1, area.screens.length - 2));
      const len = 1 + Math.floor(rand() * Math.min(3, area.screens.length - start));
      const flow = area.screens.slice(start, start + len);
      const testName = fw.framework === "gherkin" ? `Scenario: ${flow[flow.length - 1]}` : `test${pascal(flow[flow.length - 1])}${t}`;
      const file = `${fw.path}/${TEST_FILE[fw.framework](area.label)}`;
      flow.forEach((sName, k) => {
        const sc = screens.find((s) => s.id === `${area.key}-${slug(sName)}`)!;
        const verb = k === 0 ? "Open" : sName.split(" ")[0];
        sc.tests.push({ framework: fw.framework, name: testName, path: file, line: 12 + t * 9 + k * 3, evidence: EVIDENCE[fw.framework](sName, verb) });
        sc.coverage = "your_tests";
      });
    }
  }

  for (const area of spec.areas) {
    area.screens.forEach((name, i) => {
      const sc = screens.find((s) => s.id === `${area.key}-${slug(name)}`)!;
      const reasons: string[] = [];
      let score = 0.15 + rand() * 0.2;
      if (area.critical) {
        score += 0.45;
        reasons.push(/pay|checkout|basket|order/i.test(area.label + name) ? "Takes money" : "Gates everything behind it");
      }
      if (sc.endpoints.some((e) => /^(POST|PUT|DELETE|PATCH)/.test(e))) {
        score += 0.15;
        reasons.push("Writes data");
      }
      if (i === 0) {
        score += 0.08;
        reasons.push("Entry to the area");
      }
      if (sc.tests.length === 0) reasons.push("No test reaches it");
      sc.risk = { score: Math.min(1, Number(score.toFixed(2))), reasons };
    });
  }

  const gaps = screens
    .filter((s) => s.coverage === "none")
    .map((s) => {
      const area = spec.areas.find((a) => s.id.startsWith(`${a.key}-`))!;
      return { screen_id: s.id, flow: area.label, risk: s.risk.score, reason: gapReason(s, area) };
    })
    .sort((a, b) => b.risk - a.risk);

  const tested = screens.filter((s) => s.tests.length > 0).length;
  const untestedCritical = spec.areas.filter((a) => a.critical && a.screens.every((n) => screens.find((s) => s.id === `${a.key}-${slug(n)}`)?.coverage === "none")).map((a) => a.label.toLowerCase());
  const migrate = spec.frameworks.map((f) => ({ framework: f.framework, count: f.tests }));
  const draftIds = gaps.slice(0, Math.max(3, Math.min(24, Math.round(gaps.length * 0.6)))).map((g) => g.screen_id);

  const phases = Object.fromEntries(MAP_PHASES.map((p) => [p, { state: "done" } as PhaseInfo])) as Record<MapPhase, PhaseInfo>;
  phases.code_map.cost_usd = 0;
  phases.live.estimate_usd = Number((screens.length * 0.011).toFixed(2));
  phases.live.note = `${screens.length} screens on ${spec.device}`;
  phases.bring_in.estimate_usd = Number((draftIds.length * 0.035).toFixed(2));
  phases.first_run.estimate_usd = 0.06;

  return {
    project_id: spec.projectId,
    phase: "done",
    phases,
    found: {
      repo: { name: spec.name, path: spec.repoPath },
      platforms: spec.platforms,
      environments: spec.env,
      tests: spec.frameworks.map((f) => ({ framework: f.framework, count: f.tests, path: f.path })),
      ci: spec.ci,
      defaults: { device: spec.device, test_data: spec.testData },
    },
    files: [...fileLinks.entries()].map(([path, ids]) => ({ path, screen_ids: [...ids] })).sort((a, b) => a.path.localeCompare(b.path)),
    screens,
    edges,
    gaps,
    summary: { screens: screens.length, covered_by_tests: tested, covered_by_qa: 0, uncovered: screens.length - tested, untested_critical: untestedCritical },
    bring_in: { migrate, draft: { gap_screen_ids: draftIds, estimate_usd: phases.bring_in.estimate_usd ?? 0 } },
    first_test: null,
    smoke: null,
    live_run: null,
    billing: { run: null, draft: null },
  };
}

function gapReason(s: MapScreen, area: AreaSpec): string {
  if (area.critical && /pay|checkout|card/i.test(s.name)) return "Takes payment and no test reaches it";
  if (area.critical && /sign|log in|account|password/i.test(s.name)) return "Every signed-in screen sits behind it and nothing tests it";
  if (area.critical) return `Part of ${area.label.toLowerCase()}, which no test covers`;
  if (s.endpoints.some((e) => /^(POST|PUT|DELETE|PATCH)/.test(e))) return `Saves data (${s.endpoints.find((e) => /^(POST|PUT|DELETE|PATCH)/.test(e))}) with no test`;
  return "Reachable from the home screen, never tested";
}

// ---------- the three apps ----------

const CABAZ: AppSpec = {
  projectId: "cabaz-0001",
  name: "Cabaz",
  repoPath: "~/Code/cabaz",
  folder: "Cabaz/Features",
  platforms: [
    { kind: "ios", app_id: "pt.cabaz.shop", stack: "SwiftUI", path: "ios" },
    { kind: "web", app_id: "http://localhost:3000", stack: "Next.js", path: "web" },
  ],
  areas: [
    { key: "browse", label: "Browse", screens: ["Home", "Fruit and veg", "Product", "Search"], endpoints: ["GET /api/products", "GET /api/categories"] },
    { key: "basket", label: "Checkout", critical: true, screens: ["Basket", "Delivery slot", "Payment", "Order placed"], endpoints: ["POST /api/basket/items", "POST /api/orders", "POST /api/payments"] },
    { key: "account", label: "Account", screens: ["Sign in", "Your orders", "Order detail", "Addresses"], endpoints: ["POST /api/session", "GET /api/orders"] },
  ],
  frameworks: [
    { framework: "xcuitest", path: "ios/CabazUITests", tests: 6 },
    { framework: "playwright", path: "web/e2e", tests: 4 },
  ],
  env: [{ name: "local", base_url: "http://localhost:3000" }],
  device: "iPhone 17 Pro",
  testData: "Mary Costa, 2 saved addresses in Lisbon",
  ci: [{ provider: "GitHub Actions", path: ".github/workflows/ci.yml" }],
  ext: "swift",
  tint: "#2f7d4f",
  seed: 7,
};

const LITTLE_DAYS: AppSpec = {
  projectId: "littledays-0002",
  name: "Little Days",
  repoPath: "~/Code/little-days",
  folder: "LittleDays/Features",
  platforms: [
    { kind: "ios", app_id: "app.littledays.ios", stack: "SwiftUI", path: "ios" },
    { kind: "android", app_id: "app.littledays.android", stack: "Jetpack Compose", path: "android" },
  ],
  areas: [
    { key: "start", label: "Sign in", critical: true, screens: ["Welcome", "Create account", "Sign in", "Add baby", "Invite partner"], endpoints: ["POST /v1/accounts", "POST /v1/session", "POST /v1/babies"] },
    { key: "today", label: "Today", screens: ["Timeline", "Log feed", "Log sleep", "Log nappy", "Log pump", "Edit entry", "Entry detail"], endpoints: ["GET /v1/entries", "POST /v1/entries", "PUT /v1/entries/:id"] },
    { key: "sleep", label: "Sleep", screens: ["Sleep summary", "Sleep chart", "Nap planner", "Bedtime routine"], endpoints: ["GET /v1/sleep"] },
    { key: "growth", label: "Growth", screens: ["Growth chart", "Add weight", "Add height", "Percentiles", "Milestones", "Milestone detail"], endpoints: ["GET /v1/growth", "POST /v1/growth"] },
    { key: "health", label: "Health", screens: ["Medicines", "Add dose", "Temperature", "Vaccines", "Appointments", "Appointment detail"], endpoints: ["GET /v1/health", "POST /v1/doses"] },
    { key: "family", label: "Family", screens: ["Family members", "Caregiver invite", "Shared log", "Permissions"], endpoints: ["GET /v1/family", "POST /v1/invites"] },
    { key: "settings", label: "Settings", critical: false, screens: ["Settings", "Units", "Notifications", "Export data", "Subscription", "Paywall", "Restore purchase", "Delete account"], endpoints: ["GET /v1/me", "POST /v1/purchases", "DELETE /v1/me"] },
  ],
  frameworks: [
    { framework: "xcuitest", path: "ios/LittleDaysUITests", tests: 18 },
    { framework: "espresso", path: "android/app/src/androidTest/java/app/littledays", tests: 11 },
  ],
  env: [
    { name: "local", base_url: "http://localhost:8080" },
    { name: "staging", base_url: "https://staging.littledays.app" },
  ],
  device: "iPhone 17 Pro",
  testData: "Mary and Tom, baby Iris (4 months), 3 days of feeds",
  ci: [{ provider: "GitHub Actions", path: ".github/workflows/ios.yml" }],
  ext: "swift",
  tint: "#6a5acd",
  seed: 11,
};

const HALDEN_AREAS: [string, string, string[], boolean, string[]][] = [
  ["home", "Home", ["Home", "Deals", "New in", "Trending", "Gift guide", "Collections", "Collection detail", "Banner landing"], false, ["GET /api/feed"]],
  ["search", "Search", ["Search", "Results", "Filters", "Sort", "Saved searches", "Barcode scan", "No results", "Recent searches", "Suggestions", "Category list", "Subcategory", "Brand list", "Brand page"], false, ["GET /api/search", "GET /api/brands"]],
  ["product", "Product", ["Product", "Gallery", "Size guide", "Variants", "Questions", "Ask a question", "Shipping info", "Returns policy", "Seller card", "Similar items", "Bundle", "Price history", "Stock alert", "Share", "Compare", "AR preview"], false, ["GET /api/products/:id", "POST /api/alerts"]],
  ["basket", "Checkout", ["Basket", "Saved for later", "Promo code", "Delivery address", "Add address", "Delivery options", "Payment", "Add card", "3-D Secure", "Gift wrap", "Order review", "Order placed", "Payment failed", "Split payment", "Pay later", "Wallet"], true, ["POST /api/basket", "POST /api/orders", "POST /api/payments", "POST /api/addresses"]],
  ["auth", "Sign in", ["Sign in", "Create account", "Forgot password", "Reset password", "Verify email", "Two-step code", "Passkey", "Social sign in", "Account locked", "Welcome back"], true, ["POST /api/session", "POST /api/accounts", "POST /api/password"]],
  ["account", "Account", ["Account", "Profile", "Edit profile", "Addresses", "Cards", "Preferences", "Language", "Privacy", "Delete account", "Linked accounts", "Loyalty", "Rewards", "Referral", "Membership", "Invoices", "Tax details"], false, ["GET /api/me", "PUT /api/me", "DELETE /api/me"]],
  ["orders", "Orders", ["Your orders", "Order detail", "Track parcel", "Delivery map", "Invoice", "Cancel order", "Reorder", "Rate delivery", "Order help", "Delivery photo", "Missed delivery", "Reschedule", "Pickup point", "Locker code"], false, ["GET /api/orders", "POST /api/orders/:id/cancel"]],
  ["returns", "Returns", ["Start a return", "Return reason", "Return method", "Label", "Drop-off points", "Refund status", "Exchange", "Return detail", "Return help", "Return photos"], false, ["POST /api/returns", "GET /api/returns/:id"]],
  ["seller", "Selling", ["Seller home", "New listing", "Listing photos", "Listing price", "Listing preview", "Your listings", "Listing detail", "Edit listing", "Sales", "Sale detail", "Ship a sale", "Payouts", "Payout detail", "Seller ratings", "Seller settings", "Vacation mode", "Bulk edit", "Promote listing"], false, ["POST /api/listings", "PUT /api/listings/:id", "GET /api/payouts"]],
  ["messages", "Messages", ["Inbox", "Conversation", "Make an offer", "Offer detail", "Counter offer", "Report user", "Block user", "Attachments", "Quick replies", "Archived"], false, ["GET /api/threads", "POST /api/messages", "POST /api/offers"]],
  ["reviews", "Reviews", ["Reviews", "Write a review", "Review photos", "Review detail", "Report review", "Your reviews", "Helpful votes", "Seller reply"], false, ["GET /api/reviews", "POST /api/reviews"]],
  ["wishlist", "Wishlist", ["Wishlist", "Board", "New board", "Share board", "Price drops", "Back in stock", "Board settings", "Move items"], false, ["GET /api/wishlist", "POST /api/wishlist"]],
  ["notify", "Notifications", ["Notifications", "Notification settings", "Email settings", "Push prompt", "Digest", "Quiet hours", "Order updates", "Offers feed"], false, ["GET /api/notifications", "PUT /api/notifications/settings"]],
  ["help", "Help", ["Help centre", "Help article", "Contact us", "Chat with us", "Chat transcript", "Report a problem", "Safety centre", "Buyer protection", "Seller protection", "Fees", "Accessibility", "Terms"], false, ["GET /api/help", "POST /api/tickets"]],
  ["wallet", "Wallet", ["Wallet", "Top up", "Withdraw", "Bank details", "Transactions", "Transaction detail", "Gift cards", "Redeem gift card", "Vouchers", "Currency"], true, ["GET /api/wallet", "POST /api/wallet/topup", "POST /api/wallet/withdraw"]],
  ["stores", "Stores", ["Store locator", "Store detail", "Click and collect", "Collect slot", "In-store stock", "Store events", "Event detail", "Book a fitting", "Fitting booked", "Store reviews"], false, ["GET /api/stores", "POST /api/bookings"]],
  ["live", "Live shopping", ["Live now", "Live stream", "Live chat", "Live product", "Schedule", "Reminder set", "Replay", "Host profile"], false, ["GET /api/live", "POST /api/live/reminders"]],
  ["onboard", "Onboarding", ["Splash", "Intro 1", "Intro 2", "Intro 3", "Pick interests", "Pick sizes", "Location prompt", "Tracking prompt", "Done"], false, ["PUT /api/me/interests"]],
  ["business", "Business", ["Business home", "Team", "Invite teammate", "Roles", "Bulk orders", "Quote request", "Quote detail", "Purchase orders", "PO detail", "Approvals", "Approval detail", "Spend limits", "Cost centres", "Billing", "Billing history", "Credit line", "Tax exemption", "Catalogue", "Contract prices", "Reorder lists", "Reports", "Integrations"], false, ["GET /api/business", "POST /api/quotes", "POST /api/approvals"]],
  ["admin", "Moderation", ["Queue", "Case detail", "Listing review", "User review", "Appeal", "Appeal detail", "Moderator notes", "Audit log", "Bans", "Ban detail", "Policy", "Escalations", "Reports", "Report detail", "Stats", "Settings", "Team", "Shifts", "Macros", "Exports", "Search users", "User detail", "Refund override", "Payout hold"], false, ["GET /api/admin/queue", "POST /api/admin/actions"]],
];

function haldenSpec(): AppSpec {
  const areas = HALDEN_AREAS.map(([key, label, screens, critical, endpoints]) => ({ key, label, screens, critical, endpoints }));
  return {
    projectId: "halden-0003",
    name: "Halden",
    repoPath: "~/Code/halden",
    folder: "apps/mobile/src/features",
    platforms: [
      { kind: "ios", app_id: "com.halden.market", stack: "React Native (Expo)", path: "apps/mobile" },
      { kind: "android", app_id: "com.halden.market", stack: "React Native (Expo)", path: "apps/mobile" },
      { kind: "web", app_id: "http://localhost:4200", stack: "Next.js", path: "apps/web" },
    ],
    areas,
    frameworks: [
      { framework: "detox", path: "apps/mobile/e2e", tests: 22 },
      { framework: "maestro", path: "apps/mobile/.maestro", tests: 14 },
      { framework: "playwright", path: "apps/web/e2e", tests: 26 },
      { framework: "cypress", path: "apps/admin/cypress/e2e", tests: 9 },
      { framework: "xcuitest", path: "apps/mobile/ios/HaldenUITests", tests: 5 },
      { framework: "espresso", path: "apps/mobile/android/app/src/androidTest", tests: 4 },
      { framework: "gherkin", path: "features", tests: 12 },
    ],
    env: [
      { name: "local", base_url: "http://localhost:4200" },
      { name: "staging", base_url: "https://staging.halden.market" },
    ],
    device: "iPhone 17 Pro",
    testData: "Sofia Lindqvist (buyer), Erik Berg (seller), 40 listings in Oslo",
    ci: [
      { provider: "GitHub Actions", path: ".github/workflows/e2e.yml" },
      { provider: "Bitrise", path: "bitrise.yml" },
    ],
    ext: "tsx",
    tint: "#b4532a",
    seed: 23,
  };
}

let cache: Record<string, OnboardingMap> | null = null;
function all(): Record<string, OnboardingMap> {
  if (!cache) cache = { small: buildApp(CABAZ), snug: buildApp(LITTLE_DAYS), big: buildApp(haldenSpec()) };
  return cache;
}

export type FixtureName = "small" | "snug" | "big";

/** A deep copy of a finished fixture (nothing brought in yet, no first run). */
export function fixture(name: FixtureName): OnboardingMap {
  return structuredClone(all()[name]);
}

// ---------- stepping a fixture through the phases ----------

export interface FixtureStage {
  phase: MapPhase;
  /** 0 to 1: how far the running phase got. */
  progress?: number;
  liveSkipped?: boolean;
  /** Bring it in: whether drafts for the gaps were asked for. */
  drafted?: boolean;
  firstRun?: FirstRunVerdict;
  /** The live pass's crawl, over what the stage implies (null: none queued). */
  liveRun?: Partial<LiveRun> | null;
  /** The live phase, over what the stage implies (a budget note, a failure). */
  livePhase?: Partial<PhaseInfo>;
}

/** The crawl's run id in the fixtures (no such run exists: the device view shows its empty frame). */
export const FIXTURE_LIVE_RUN_ID = "5b2e7c10-0000-4000-8000-00000000c4a1";

const ORDER: MapPhase[] = ["found", "code_map", "tests", "live", "coverage", "bring_in", "first_run", "done"];

/** What the snapshot holds at `stage`: the phases before it done, it running (or done at
 * progress 1), the ones after pending, and only the data those phases have produced. */
export function fixtureAt(full: OnboardingMap, stage: FixtureStage): OnboardingMap {
  const m = structuredClone(full);
  const at = ORDER.indexOf(stage.phase);
  const p = Math.max(0, Math.min(1, stage.progress ?? 1));
  m.phase = stage.phase;
  for (const ph of ORDER) {
    const k = ORDER.indexOf(ph);
    const info = m.phases[ph];
    if (k < at) info.state = "done";
    else if (k === at) info.state = stage.phase === "done" ? "done" : p >= 1 && ph !== "first_run" ? "done" : "running";
    else info.state = "pending";
    if (info.state === "pending") {
      delete info.cost_usd;
    }
  }
  if (stage.liveSkipped && at > ORDER.indexOf("live")) m.phases.live.state = "skipped";
  if (stage.liveSkipped && stage.phase === "live") m.phases.live.state = "skipped";
  if (at > ORDER.indexOf("live") && !stage.liveSkipped) m.phases.live.cost_usd = m.phases.live.estimate_usd;
  // first_run is a step the person starts: pending until a verdict is asked for.
  if (stage.phase === "first_run" && !stage.firstRun) m.phases.first_run.state = "pending";
  if (stage.phase === "first_run" && stage.firstRun && stage.firstRun !== "running" && stage.firstRun !== "queued") m.phases.first_run.state = "done";

  const take = <T>(list: T[], frac: number) => list.slice(0, Math.ceil(list.length * frac));
  const codeFrac = at < ORDER.indexOf("code_map") ? 0 : stage.phase === "code_map" ? p : 1;
  const testFrac = at < ORDER.indexOf("tests") ? 0 : stage.phase === "tests" ? p : 1;
  const liveFrac = stage.liveSkipped ? 0 : at < ORDER.indexOf("live") ? 0 : stage.phase === "live" ? p : 1;

  // Code map: the screens in the order the code is read, with the files read so far.
  const kept = new Set(take(m.screens, codeFrac).map((s) => s.id));
  m.screens = m.screens.filter((s) => kept.has(s.id));
  m.files = m.files.map((f) => ({ ...f, screen_ids: f.screen_ids.filter((id) => kept.has(id)) })).filter((f) => f.screen_ids.length > 0);
  m.edges = m.edges.filter((e) => kept.has(e.from) && kept.has(e.to));

  // Tests: frameworks are matched one after another.
  const fws = full.found.tests.map((t) => t.framework);
  const fwDone = new Set(take(fws, testFrac));
  const crawl = new Set(take(m.screens, liveFrac).map((s) => s.id));
  for (const s of m.screens) {
    s.tests = s.tests.filter((t) => fwDone.has(t.framework as Framework));
    s.coverage = s.tests.length ? "your_tests" : "none";
    if (!crawl.has(s.id)) {
      s.source = "code";
      delete s.thumbnail;
    }
  }

  const inBringIn = at >= ORDER.indexOf("bring_in");
  const bringDone = at > ORDER.indexOf("bring_in") || (stage.phase === "bring_in" && p >= 1);
  if (inBringIn) {
    // Imported tests become scenarios (pointers), one per test, attached to the screens they cover.
    const migrated = stage.phase === "bring_in" ? p : 1;
    let n = 0;
    for (const s of m.screens) {
      for (const t of s.tests) {
        n += 1;
        // One scenario per test, on every screen the test reaches (a pointer to its file and line).
        if (n / Math.max(1, totalTests(m)) <= migrated) s.scenarios.push({ id: `imp-${slug(t.path)}-${slug(t.name)}`, name: humanTest(t.name), status: "imported" });
      }
      s.scenarios = dedupe(s.scenarios);
    }
    if (stage.drafted !== false) {
      const ids = m.bring_in.draft.gap_screen_ids;
      take(ids, migrated).forEach((id) => {
        const s = m.screens.find((x) => x.id === id);
        if (!s) return;
        s.scenarios.push({ id: `drf-${s.id}`, name: draftName(s.name), status: "draft" });
        s.coverage = s.coverage === "your_tests" ? "both" : "qa";
      });
    }
  }
  if (bringDone) {
    m.first_test = pickFixtureFirstTest(m);
  }

  if (stage.firstRun && m.first_test?.screen_id) {
    const s = m.screens.find((x) => x.id === m.first_test!.screen_id);
    if (s) {
      s.first_run = {
        scenario_id: m.first_test.scenario_id,
        // Queued with no run yet, then the run's id once it exists.
        run_id: stage.firstRun === "queued" ? "" : "4f1c2a9e-0000-4000-8000-00000000f1r5",
        verdict: stage.firstRun,
        ...(stage.firstRun === "pass" ? { duration_s: 42 } : {}),
        ...(stage.firstRun === "fail" ? { duration_s: 57, finding: "The Place order button stays disabled after a delivery slot is picked." } : {}),
      };
    }
  }

  // The smoke suite: projected before Bring it in, the real scenarios after.
  const scenarioIds = new Set(m.screens.flatMap((s) => s.scenarios.map((x) => x.id)));
  const projectedCount = full.bring_in.migrate.reduce((n, x) => n + x.count, 0) + full.bring_in.draft.gap_screen_ids.length;
  const count = inBringIn ? scenarioIds.size : projectedCount;
  m.smoke = at >= ORDER.indexOf("coverage") ? { count, estimate_usd: Number((count * 0.05).toFixed(2)), estimate_seconds: count * 40, projected: !inBringIn } : null;

  m.summary = {
    screens: m.screens.length,
    covered_by_tests: m.screens.filter((s) => s.coverage === "your_tests" || s.coverage === "both").length,
    covered_by_qa: m.screens.filter((s) => s.coverage === "qa" || s.coverage === "both").length,
    uncovered: m.screens.filter((s) => s.coverage === "none").length,
    untested_critical: at >= ORDER.indexOf("tests") && (stage.phase !== "tests" || p >= 1) ? full.summary.untested_critical : [],
  };
  const live = new Set(m.screens.map((s) => s.id));
  m.gaps = full.gaps.filter((g) => live.has(g.screen_id) && m.screens.find((s) => s.id === g.screen_id)?.coverage === "none");
  if (at < ORDER.indexOf("tests")) m.gaps = [];

  // The live pass: the overview aims at each area's entry screen (its route has one segment).
  const areas = m.screens.filter((s) => /^\/[^/]+$/.test(s.route ?? ""));
  const liveRan = !stage.liveSkipped && at >= ORDER.indexOf("live") && (stage.phase !== "live" || p > 0);
  m.live_run = liveRan
    ? {
        request_id: "9d41f0a2-0000-4000-8000-00000000c4a1",
        status: stage.phase === "live" && p < 1 ? "running" : "completed",
        run_id: FIXTURE_LIVE_RUN_ID,
        depth: "overview",
        targets: areas.length,
        reached: areas.filter((s) => s.source !== "code").length,
      }
    : null;
  if (stage.liveRun === null) m.live_run = null;
  else if (stage.liveRun) {
    m.live_run = { request_id: "9d41f0a2-0000-4000-8000-00000000c4a1", status: "running", depth: "overview", targets: areas.length, reached: 0, ...(m.live_run ?? {}), ...stage.liveRun };
    if (stage.liveRun.run_id === undefined && "run_id" in stage.liveRun) delete m.live_run.run_id;
  }
  if (stage.livePhase) m.phases.live = { ...m.phases.live, ...stage.livePhase };
  return m;
}

function totalTests(m: OnboardingMap): number {
  return m.screens.reduce((n, s) => n + s.tests.length, 0);
}

function dedupe<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

function humanTest(name: string): string {
  const bare = name.replace(/^Scenario:\s*/, "").replace(/^test/, "").replace(/\d+$/, "");
  return bare.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function draftName(screen: string): string {
  if (/payment|card|secure/i.test(screen)) return `Pay for an order on ${screen}`;
  if (/sign in|account|password/i.test(screen)) return `${screen} with a test account`;
  return `Reach ${screen} and check it shows its content`;
}

function pickFixtureFirstTest(m: OnboardingMap): OnboardingMap["first_test"] {
  // The highest-risk screen an imported test covers, else the top drafted gap.
  // Ideally short and sign-in free: screens behind the sign-in area come last.
  const signIn = (s: MapScreen) => /sign|account|password|welcome/i.test(`${s.route ?? ""} ${s.name}`);
  const covered = m.screens
    .filter((s) => s.scenarios.some((x) => x.status === "imported"))
    .sort((a, b) => Number(signIn(a)) - Number(signIn(b)) || b.risk.score - a.risk.score);
  const pick = covered[0];
  if (pick) {
    const sc = pick.scenarios.find((x) => x.status === "imported")!;
    return {
      scenario_id: sc.id,
      name: sc.name,
      screen_id: pick.id,
      platform: pick.platform,
      estimate_seconds: 45,
      estimate_usd: 0.06,
      why: `It covers ${pick.name}, the riskiest screen one of your tests already reaches, and needs no sign-in.`,
    };
  }
  const gap = m.screens.find((s) => s.scenarios.some((x) => x.status === "draft"));
  if (!gap) return null;
  const sc = gap.scenarios.find((x) => x.status === "draft")!;
  return { scenario_id: sc.id, name: sc.name, screen_id: gap.id, platform: gap.platform, estimate_seconds: 60, estimate_usd: 0.08, why: `It checks ${gap.name}, the riskiest screen nothing tested before.` };
}
