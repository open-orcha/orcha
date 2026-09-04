/**
 * ORCHA CLOUD — the /api/plan gating layer (Orcha Cloud local run, plan-gating
 * addendum: docs/orcha-cloud-local-run.md).
 *
 * Wire contract (backend UNCHANGED — portal_backend/plan_routes.py):
 *   GET /api/plan -> { plan: "solo" | "team", features: { members: bool },
 *       upgrade_url: string }
 *
 * Fetched ONCE per page load (single-flighted module cache), same shape as
 * the identity layer's fetchMe (src/cloud/identity.ts) — the extensions seam
 * fetches plan alongside identity so every consumer reads the same resolved
 * value without re-asking the server.
 *
 * FAIL-OPEN ON ERROR: a fetch failure (network blip, 5xx, bad JSON) resolves
 * to {plan: "team", features: {members: true}, upgrade_url: default}. This is
 * deliberate, not an oversight — see the addendum's non-goals: there is no
 * license-key/billing enforcement in v1, ORCHA_PLAN is the whole mechanism,
 * and the SERVER is the actual gate (member mutations 402 under solo
 * regardless of what the frontend believes). A transient blip must never
 * paywall a paying Team customer just because one GET failed; a solo user who
 * hits this fallback still gets the real 402 card from the server the moment
 * they try a gated mutation (MembersPage's belt-and-braces 402 catch below).
 * Defaulting to "solo" instead would incorrectly hide paid features from
 * paying customers on every blip — worse than the reverse.
 */
import { useEffect, useState } from "react";

export interface PlanFeatures {
  members: boolean;
}
export interface Plan {
  plan: "solo" | "team";
  features: PlanFeatures;
  upgrade_url: string;
}

const DEFAULT_UPGRADE_URL = "https://orcha.nursoftai.com/#pricing";

// The fail-open fallback — see the file-level comment for why "team".
const FAIL_OPEN_PLAN: Plan = {
  plan: "team",
  features: { members: true },
  upgrade_url: DEFAULT_UPGRADE_URL,
};

/* ---- GET /api/plan, single-flighted for the page's lifetime -------------- */
let _cache: Promise<Plan> | null = null;

export function fetchPlan(): Promise<Plan> {
  if (!_cache) {
    _cache = fetch("/api/plan")
      .then(async (r) => {
        if (!r.ok) return FAIL_OPEN_PLAN;
        const d = (await r.json()) as Partial<Plan> | null;
        if (!d || (d.plan !== "solo" && d.plan !== "team")) return FAIL_OPEN_PLAN;
        return {
          plan: d.plan,
          features: { members: !!d.features?.members },
          upgrade_url: d.upgrade_url || DEFAULT_UPGRADE_URL,
        };
      })
      .catch(() => FAIL_OPEN_PLAN);
  }
  return _cache;
}

// Test/page-teardown hook: drop the single-flight cache so a fresh mount
// re-asks (mirrors resetIdentity in src/cloud/identity.ts).
export function resetPlan(): void {
  _cache = null;
}

/* ---- usePlan() hook -------------------------------------------------------
 * null while the fetch is in flight (first render); the resolved Plan after.
 * Consumers that need to render something meaningful before resolution (e.g.
 * "Loading…") can treat null as pending — MembersPage does exactly that. */
export function usePlan(): Plan | null {
  const [plan, setPlan] = useState<Plan | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchPlan().then((p) => { if (alive) setPlan(p); });
    return () => { alive = false; };
  }, []);
  return plan;
}
