/**
 * Device pairing page — React port of static/device.html (the page the iOS app
 * opens in its authenticated browser sheet; device_token_routes serves the SPA
 * shell at /auth/device). STANDALONE like the vanilla page: no <Shell>, no
 * snapshot — the OAuth-proxied browser session is the whole context.
 *
 * Contract (device_token_routes.py): POST /api/device-tokens with
 * {label: "iOS device"} mints a bearer token for the acting member — the raw
 * token appears in THIS response only (the row keeps its sha256). The token is
 * handed to the iOS app via its registered orcha:// URL scheme; the page stays
 * behind as the manual-copy fallback. 403 = the signed-in GitHub account is not
 * a member of any project. The GET that renders this page mints nothing; one
 * POST fires per page load (mint-once guard survives StrictMode double-effects).
 */
import { useEffect, useRef, useState } from "react";
import "./device.css";

export function DevicePage() {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const minted = useRef(false);

  useEffect(() => {
    if (minted.current) return; // a device token is minted state — never twice
    minted.current = true;
    fetch("/api/device-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "iOS device" }),
    })
      .then((r) =>
        r.json().catch(() => ({})).then((d: { token?: string; detail?: string }) => {
          if (!r.ok) {
            const detail = d.detail || "HTTP " + r.status;
            throw new Error(detail + " — your GitHub account must be a member of " +
              "this project. Ask an owner to invite you (Settings → Members), " +
              "then reload this page.");
          }
          return d;
        }),
      )
      .then((d) => {
        setToken(d.token || "");
        // Hand the token to the iOS app via its registered URL scheme. The page
        // stays behind as the manual-copy fallback.
        try {
          window.location.href = "orcha://auth/callback?host=" +
            encodeURIComponent(location.host) +
            "&token=" + encodeURIComponent(d.token || "");
        } catch { /* non-navigating environment (tests) */ }
      })
      .catch((err) => setError(err && err.message ? err.message : String(err)));
  }, []);

  const status = error
    ? "Could not mint a device token."
    : token != null
      ? "Device token minted — opening the Orcha app…"
      : "Minting a device token…";

  return (
    <div className="device-page">
      <div className="card">
        <h1>Connect your device</h1>
        <p id="status">{status}</p>
        {error != null && <div id="error">{error}</div>}
        {token != null && (
          <div id="tokenbox">
            <p>The Orcha app should have opened automatically. If it didn&rsquo;t, copy the
              token below and paste it into the app.</p>
            <code id="token">{token}</code>
            <button
              id="copy"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(token).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy token"}
            </button>
          </div>
        )}
        <p className="muted">This token identifies you (via your GitHub account) to this Orcha
          box. You can revoke it any time from Settings &rarr; Members, or with{" "}
          <code>DELETE /api/device-tokens/&lt;id&gt;</code>.</p>
      </div>
    </div>
  );
}
