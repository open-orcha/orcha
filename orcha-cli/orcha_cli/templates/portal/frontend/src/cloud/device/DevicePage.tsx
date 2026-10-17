/**
 * Device pairing page — React port of static/device.html (the page the iOS app
 * opens in its authenticated browser sheet, and the desktop app's sign-in page
 * via Settings › Devices & pairing → /auth/device?client=desktop;
 * device_token_routes serves the SPA shell at /auth/device). STANDALONE like
 * the vanilla page: no <Shell>, no snapshot — the OAuth-proxied browser
 * session is the whole context.
 *
 * Contract (device_token_routes.py): POST /api/device-tokens with
 * {label: "iOS device"} (or "Desktop app" for ?client=desktop) mints a bearer
 * token for the acting member — the raw token appears in THIS response only
 * (the row keeps its sha256). The token is handed to the app via its
 * registered orcha:// URL scheme; the page stays behind as the manual-copy
 * fallback. 403 = the signed-in GitHub account is not a member of any project.
 * The GET that renders this page mints nothing; one POST fires per page load
 * (mint-once guard survives StrictMode double-effects) — Retry mints again
 * only after a failure.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { OrcaMark } from "../../components/ui";
import { Button, ButtonLink } from "../../components/primitives";
import "./device.css";

export type DeviceClient = "ios" | "desktop";

/** ?client=desktop|ios (default ios — the iOS app opens this page bare). */
export function deviceClient(search: string): DeviceClient {
  try {
    return new URLSearchParams(search).get("client") === "desktop" ? "desktop" : "ios";
  } catch {
    return "ios";
  }
}

/** How long we wait for the app to take over before saying so plainly. */
export const APP_OPEN_GRACE_MS = 2000;

interface MintError { headline: string; guidance: string; detail: string }

/**
 * A failed mint as the user should read it (pure, tested; DEV-004). Fixed
 * headline + guidance per case; the server's raw text only goes in the
 * collapsed Details (never appended to the guidance).
 *   403 "verified GitHub identity" → not signed in with GitHub (self-host / no proxy)
 *   403 otherwise                  → signed in, but not a member of any project
 *   anything else                  → a generic retryable failure
 */
export function mintError(status: number, detail: unknown): MintError {
  const raw = typeof detail === "string" && detail ? detail : "";
  const details = ["HTTP " + status, raw].filter(Boolean).join(" · ");
  if (status === 403 && /verified github identity|trusted proxy/i.test(raw)) {
    return {
      headline: "Sign in with GitHub first",
      guidance: "Device sign-in needs GitHub sign-in (Embodent Cloud). Open Embodent through its GitHub sign-in, then try again.",
      detail: details,
    };
  }
  if (status === 403) {
    return {
      headline: "Your GitHub account isn't a member of this Embodent yet",
      guidance: "Ask an owner to invite you (Settings → Members & access), then try again.",
      detail: details,
    };
  }
  return {
    headline: "Couldn't create a sign-in token",
    guidance: "Something went wrong on the server. Try again.",
    detail: status ? details : raw || "No answer from Embodent",
  };
}

export function DevicePage() {
  const client = deviceClient(typeof location !== "undefined" ? location.search : "");
  const label = client === "desktop" ? "Desktop app" : "iOS device";
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<MintError | null>(null);
  const [copied, setCopied] = useState(false);
  const [appSlow, setAppSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const minted = useRef(-1); // the attempt number already minted (never twice per attempt)

  const callbackUrl = useCallback(
    (t: string) =>
      "orcha://auth/callback?host=" + encodeURIComponent(location.host) + "&token=" + encodeURIComponent(t),
    [],
  );

  useEffect(() => {
    if (minted.current === attempt) return; // a device token is minted state — never twice
    minted.current = attempt;
    fetch("/api/device-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    })
      .then((r) =>
        r.json().catch(() => ({})).then((d: { token?: string; detail?: string }) => {
          if (!r.ok) {
            const e = new Error("mint failed") as Error & { mint?: MintError };
            e.mint = mintError(r.status, d.detail);
            throw e;
          }
          return d;
        }),
      )
      .then((d) => {
        setToken(d.token || "");
        // Hand the token to the app via its registered URL scheme. The page
        // stays behind as the manual-copy fallback.
        try {
          window.location.href = callbackUrl(d.token || "");
        } catch { /* non-navigating environment (tests) */ }
      })
      .catch((err: Error & { mint?: MintError }) =>
        setError(err && err.mint ? err.mint : mintError(0, err && err.message ? err.message : String(err))),
      );
  }, [attempt, label, callbackUrl]);

  // After a short grace period, stop claiming the app is opening.
  useEffect(() => {
    if (token == null) return;
    const t = window.setTimeout(() => setAppSlow(true), APP_OPEN_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [token]);

  const retry = () => {
    setError(null);
    setToken(null);
    setAppSlow(false);
    setAttempt((a) => a + 1);
  };

  // the error block carries its own headline — no duplicate status line then
  const status = error
    ? null
    : token != null
      ? appSlow
        ? "If the app didn’t open, copy the token below."
        : client === "desktop" ? "Device token minted — opening the Embodent desktop app…" : "Device token minted — opening the Orcha mobile app…"
      : "Minting a device token…";

  return (
    <div className="device-page">
      <main className="device-card" aria-labelledby="deviceTitle">
        <div className="device-brand"><OrcaMark /><span>Embodent</span></div>
        <h1 id="deviceTitle">{client === "desktop" ? "Sign in the desktop app" : "Connect your device"}</h1>
        {status != null && (
          <p id="status" role="status" aria-live="polite" className="device-status">
            {token == null ? <span className="device-spinner" aria-hidden="true" /> : null}
            {status}
          </p>
        )}
        {error != null && (
          <div id="error" role="alert">
            <p className="device-err-h">{error.headline}</p>
            <p className="device-err-d">{error.guidance}</p>
            <details className="device-err-more">
              <summary>Details</summary>
              <code>{error.detail}</code>
            </details>
            <div className="device-acts">
              <Button size="sm" variant="primary" icon="refresh" onClick={retry}>Try again</Button>
              <ButtonLink size="sm" variant="ghost" href="/">Back to Embodent</ButtonLink>
            </div>
          </div>
        )}
        {token != null && (
          <div id="tokenbox">
            <p>{client === "desktop" ? "The Embodent desktop app" : "The Orcha mobile app"} should have opened automatically. If it
              didn&rsquo;t, copy the token below and paste it into the app.</p>
            <div className="device-token-row">
              <code id="token" title="Device token (copy copies the full value)">{token}</code>
              <Button
                id="copy"
                size="sm"
                variant="primary"
                icon={copied ? "check" : "copy"}
                onClick={() => {
                  void navigator.clipboard.writeText(token).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy token"}
              </Button>
            </div>
            <div className="device-acts">
              <ButtonLink size="sm" variant="ghost" href={callbackUrl(token)} iconRight="arrow">Open the app again</ButtonLink>
            </div>
          </div>
        )}
        {error == null && <p className="device-foot">This token identifies you (via your GitHub account) to this Embodent
          box. You can revoke it any time from{" "}
          <a href="/settings#tab=pairing">Settings &rarr; Devices &amp; pairing</a>.</p>}
      </main>
    </div>
  );
}
