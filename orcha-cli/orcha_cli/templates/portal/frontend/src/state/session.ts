/**
 * Is there a sign-in (oauth2-proxy) session to clear? (parity r3 extra)
 *
 * The account menu learns "trusted" from /api/me, which needs a project id — a
 * signed-in person with ZERO memberships has none, so Sign out vanished exactly
 * when they most need it (stuck on /projects). oauth2-proxy answers
 * GET /oauth2/userinfo with {user, email, …} for a live session and 401
 * otherwise (Caddy proxies /oauth2/* — deploy/auth/Caddyfile); a self-host
 * portal has no such route (404, or the SPA's HTML), which reads as "no session".
 * Asked once per page load, only by the views that need it.
 */
import { useEffect, useState } from "react";
import { registerTestReset } from "../lib/testResets";

export const USERINFO_URL = "/oauth2/userinfo";

let cached: Promise<boolean> | null = null;

function looksSignedIn(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return ["user", "email", "preferredUsername", "preferred_username"].some((k) => typeof b[k] === "string" && b[k] !== "");
}

export function probeProxySession(): Promise<boolean> {
  if (!cached) {
    cached = (async () => {
      try {
        const r = await fetch(USERINFO_URL, { headers: { Accept: "application/json" }, credentials: "same-origin" });
        if (!r || !r.ok) return false;
        return looksSignedIn(await r.json());
      } catch {
        return false;
      }
    })();
  }
  return cached;
}

/** true once a live proxy session is confirmed (false while unknown / none). */
export function useProxySession(active = true): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void probeProxySession().then((v) => { if (alive) setOn(v); });
    return () => { alive = false; };
  }, [active]);
  return on;
}

/** test hook */
export function _resetProxySessionForTests(): void {
  cached = null;
}
registerTestReset(_resetProxySessionForTests);
