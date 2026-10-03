/**
 * Settings › Devices & pairing › "Signed-in devices" — the acting identity's
 * live device tokens (phones and desktop apps minted through /auth/device),
 * with Revoke. Wire contract (device_token_routes.py, backend unchanged):
 *   GET    /api/device-tokens        -> {tokens:[{id,label,created_at,last_used_at}]}
 *   DELETE /api/device-tokens/{id}   -> {id, revoked}
 * The list is always YOUR tokens; revoking is idempotent server-side.
 */
import { useCallback, useEffect, useState } from "react";
import { Icon, Modal, useToast } from "../../components/ui";
import { Button } from "../../components/primitives";
import { relTime } from "../../lib/format";
import { GroupHead, StatusLine } from "../../pages/settings/settingsUi";

export interface DeviceToken {
  id: string;
  label: string | null;
  created_at: string | null;
  last_used_at: string | null;
}

/** "Desktop app" / "iOS device" / anything else → a glyph + a readable name. */
export function deviceKind(label: string | null | undefined): { icon: string; name: string } {
  const l = (label || "").trim();
  if (/desktop|mac|windows|linux/i.test(l)) return { icon: "sidebar", name: l };
  if (/ios|iphone|ipad|android|phone/i.test(l)) return { icon: "phone", name: l };
  return { icon: "shield", name: l || "Unnamed device" };
}

/** Device sign-in exists only behind GitHub sign-in (the trusted proxy lane):
 *  device_token_routes 403s "device tokens require a verified GitHub
 *  identity" on a self-hosted (trust-off) portal. */
export const DEVICE_SIGNIN_UNAVAILABLE =
  "Device sign-in needs GitHub sign-in (Embodent Cloud). It isn't available on this self-hosted portal.";

/** Signed in with GitHub, but not a member of any project: the device-token
 *  routes 403 "GitHub user 'x' is not a member of any project" (D9). */
export const DEVICE_NOT_A_MEMBER =
  "You're not a member of any Embodent project yet — ask an owner to invite you.";

/** Which 403 this is (pure, tested): the self-host "no verified GitHub
 *  identity" state, or a signed-in GitHub user who belongs to no project. */
export function deviceListDenial(detail: unknown): "unavailable" | "not_member" {
  const d = typeof detail === "string" ? detail : "";
  if (/verified GitHub identity/i.test(d)) return "unavailable";
  if (/not a member/i.test(d)) return "not_member";
  return "unavailable";
}

/** A failed revoke as the words to show (pure, tested) — never a status code.
 *  404 means it's already gone: the row is dropped and that's said plainly. */
export function revokeFailure(status: number): { text: string; tone: "warn" | "danger"; drop: boolean } {
  if (status === 404) return { text: "That device was already signed out.", tone: "warn", drop: true };
  if (status === 401 || status === 403) return { text: "Only the device's owner or a project owner can revoke it.", tone: "danger", drop: false };
  return { text: "Couldn't revoke the device. Try again.", tone: "danger", drop: false };
}

export function DeviceTokensSection({ onNotMember }: { onNotMember?: () => void } = {}) {
  const toast = useToast();
  const [tokens, setTokens] = useState<DeviceToken[] | null>(null);
  const [err, setErr] = useState(false);
  // DEV-SELFHOST: a 403 on the list is the "no verified GitHub identity" state
  // (trust-off / self-host), not an error to retry
  const [unavailable, setUnavailable] = useState<false | "unavailable" | "not_member">(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<DeviceToken | null>(null);

  const load = useCallback(async () => {
    setErr(false);
    setUnavailable(false);
    try {
      const r = await fetch("/api/device-tokens");
      if (r.status === 403) {
        const b = (await r.json().catch(() => null)) as { detail?: unknown } | null;
        const kind = deviceListDenial(b && b.detail);
        setTokens(null);
        setUnavailable(kind);
        if (kind === "not_member" && onNotMember) onNotMember();
        return;
      }
      const body = (await r.json().catch(() => null)) as { tokens?: DeviceToken[] } | null;
      if (!r.ok || !body || !Array.isArray(body.tokens)) throw new Error(String(r.status));
      setTokens(body.tokens);
    } catch {
      setTokens(null);
      setErr(true);
    }
  }, [onNotMember]);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (t: DeviceToken) => {
    setBusy(t.id);
    const drop = () => setTokens((cur) => (cur ? cur.filter((x) => x.id !== t.id) : cur));
    try {
      const r = await fetch("/api/device-tokens/" + encodeURIComponent(t.id), { method: "DELETE" });
      if (r.ok) {
        toast("Revoked " + deviceKind(t.label).name + ".", "ok");
        drop();
      } else {
        const f = revokeFailure(r.status);
        toast(f.text, f.tone);
        if (f.drop) drop();
      }
    } catch {
      toast(revokeFailure(0).text, "danger");
    }
    setBusy(null);
  };

  let body;
  if (unavailable === "not_member") {
    body = <p className="set-note" id="devNotMember">{DEVICE_NOT_A_MEMBER}</p>;
  } else if (unavailable) {
    body = <p className="set-note" id="devUnavailable">{DEVICE_SIGNIN_UNAVAILABLE}</p>;
  } else if (err) {
    body = (
      <StatusLine
        tone="err"
        action={<Button size="sm" variant="ghost" icon="refresh" onClick={() => void load()}>Retry</Button>}
      >
        Couldn&#39;t load your signed-in devices.
      </StatusLine>
    );
  } else if (!tokens) {
    body = <StatusLine tone="muted">Loading devices…</StatusLine>;
  } else if (!tokens.length) {
    body = <p className="set-note" id="devEmpty">No phones or desktop apps are signed in as you yet.</p>;
  } else {
    body = (
      <ul className="dev-list" aria-label="Signed-in devices">
        {tokens.map((t) => {
          const k = deviceKind(t.label);
          return (
            <li className="dev-row" key={t.id} data-token={t.id}>
              <span className="dev-ico" aria-hidden="true"><Icon name={k.icon} cls="" /></span>
              <div className="dev-main">
                <div className="dev-name">{k.name}</div>
                <div className="dev-sub">
                  Added {t.created_at ? relTime(t.created_at) : "—"} · {t.last_used_at ? "last used " + relTime(t.last_used_at) : "never used"}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="dev-revoke"
                disabled={busy === t.id}
                busy={busy === t.id}
                aria-label={"Revoke " + k.name}
                onClick={() => setRevoking(t)}
              >
                Revoke
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="card set-card" data-settab="pairing" id="deviceTokens">
      <GroupHead title="Signed-in devices" lead="Phones and desktop apps that act as you." />
      <div className="card-b">
        {body}
      </div>
      {revoking && (
        <Modal
          title={"Revoke " + deviceKind(revoking.label).name + "?"}
          danger
          primary="Revoke"
          desc="The device is signed out on its next request. Sign in again from the device to reconnect."
          onPrimary={() => { const t = revoking; setRevoking(null); void revoke(t); }}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
