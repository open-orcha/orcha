/**
 * Phone-pairing modal — React port of modules/app-pairing.js for the /projects
 * hub's per-card QR button. CID-SCOPED: the payload/QR comes from
 * GET /api/containers/{cid}/pairing built from the PATH cid, so the phone
 * always pairs against exactly the project whose button was pressed.
 *
 * Landing-page semantics (vanilla parity): a foreign-cid open skips the local
 * "Pair as" picker — trusted lane shows the resolved identity chip (the server
 * resolves and enforces the member; no human_agent_id rides the request), and
 * a multi-human trust-off stack answers 400 choose_human with the roster,
 * rendered as its own picker. Same class names as overlays.css styles.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, OrcaMark } from "../../components/ui";
import { CloudIcon } from "./icons";
import { GhAvatar } from "./avatars";

export interface PairingIdentity { github_login?: string | null }

interface PairingPayload {
  baseUrl?: string;
  humanAgentId?: string;
  humanAgentAlias?: string;
  qrSvg?: string;
  shortCode?: string;
  expiresAt?: string;
}
interface PairingWarningInfo { title?: string; message?: string; remedy?: string }
interface ChooseHuman { id: string; alias: string }

/* Honest network copy: behind the cloud sign-in perimeter (https / non-local
 * payload URL) the phone connects from anywhere. */
function cloudContext(baseUrl?: string): boolean {
  if (/^https:/i.test(baseUrl || "")) return true;
  try { return typeof location !== "undefined" && location.protocol === "https:"; } catch { return false; }
}
function scanCopy(cloud: boolean): string {
  return cloud
    ? "Scan with the Orcha app — works from anywhere."
    : "Scan with the Orcha app on the same Wi-Fi network.";
}
function footCopy(cloud: boolean): string {
  return cloud
    ? "Your phone connects securely over HTTPS through this Orcha's sign-in perimeter."
    : "Your phone talks directly to this computer on your network. Nothing goes through the cloud.";
}

function countdownText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return "expires in " + m + ":" + s + " — regenerates automatically";
}

// esc()-free remedy renderer: React escapes text; only `code` spans are markup.
function CopyWithCode({ s }: { s: string }) {
  const parts = s.split(/`([^`]+)`/g);
  return <>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</>;
}

type View =
  | { kind: "loading" }
  | { kind: "warning"; info: PairingWarningInfo }
  | { kind: "chooser"; humans: ChooseHuman[] }
  | { kind: "payload"; data: PairingPayload; humanId: string | null };

/**
 * PairingPanel — the pairing BODY, host-agnostic: auto-loads the cid-scoped
 * pairing GET on mount, ticks the expiry countdown, regenerates on expiry,
 * and renders the warning / choose-human / payload states. The modal wraps
 * it in overlay chrome; the settings section renders it directly in the card
 * so the QR is visible the moment the tab opens (no button press).
 */
export function PairingPanel({ cid, identity }: {
  cid: string;
  identity: PairingIdentity | null; // trusted-lane resolved identity (or null)
}) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [countLeft, setCountLeft] = useState<string>("expires soon");
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = () => {
    if (timer.current != null) clearInterval(timer.current);
    timer.current = null;
  };

  const load = useCallback(async (humanId: string | null) => {
    const mySeq = ++seq.current;
    clearTimer();
    setView({ kind: "loading" });
    let url = "/api/containers/" + encodeURIComponent(cid) + "/pairing";
    if (humanId) url += "?human_agent_id=" + encodeURIComponent(humanId);
    try {
      const r = await fetch(url);
      let data: unknown = null;
      try { data = await r.json(); } catch { /* empty body */ }
      if (mySeq !== seq.current) return;
      if (!r.ok) {
        const detail = (data as { detail?: unknown } | null)?.detail;
        // Foreign-cid open with several humans and no trusted identity: the
        // server answers 400 choose_human with the roster — render its picker.
        if (
          detail && typeof detail === "object" &&
          (detail as { reason?: string }).reason === "choose_human" &&
          Array.isArray((detail as { humans?: unknown }).humans)
        ) {
          setView({ kind: "chooser", humans: (detail as { humans: ChooseHuman[] }).humans });
          return;
        }
        const info: PairingWarningInfo = typeof detail === "string"
          ? { message: detail } // plain-string 403 details
          : (detail as PairingWarningInfo) || { message: "Pairing failed (" + r.status + ")." };
        setView({ kind: "warning", info });
        return;
      }
      setView({ kind: "payload", data: data as PairingPayload, humanId });
    } catch (e) {
      if (mySeq === seq.current) {
        setView({ kind: "warning", info: { message: "Could not reach the local pairing endpoint: " + (e instanceof Error ? e.message : String(e)) } });
      }
    }
  }, [cid]);

  useEffect(() => { void load(null); return clearTimer; }, [load]);

  // countdown: tick each second; on expiry regenerate against the same human.
  useEffect(() => {
    clearTimer();
    if (view.kind !== "payload") return;
    const exp = Date.parse(view.data.expiresAt || "");
    if (!exp) return;
    const humanId = view.humanId || view.data.humanAgentId || null;
    const tick = () => {
      const left = exp - Date.now();
      if (left <= 0) {
        clearTimer();
        void load(humanId);
      } else {
        setCountLeft(countdownText(left));
      }
    };
    tick();
    timer.current = setInterval(tick, 1000);
    return clearTimer;
  }, [view, load]);

  const body = () => {
    switch (view.kind) {
      case "loading":
        return (
          <div className="pair-loading"><Icon name="clock" cls="" /><span>Preparing pairing code...</span></div>
        );
      case "warning": {
        const info = view.info;
        return (
          <div className="pair-warning">
            <div className="pair-warn-title"><CloudIcon name="alert" cls="" /><span>{info.title || "Phones can't reach this Orcha yet"}</span></div>
            <p>{info.message || "The server could not produce a phone-reachable network address."}</p>
            {info.remedy && <div className="pair-remedy"><CopyWithCode s={info.remedy} /></div>}
            {!cloudContext() && (
              <p className="pair-foot">Both devices must be on the same Wi-Fi. Some VPNs and corporate networks block phone-to-laptop traffic.</p>
            )}
          </div>
        );
      }
      case "chooser":
        return (
          <div className="pair-warning">
            <div className="pair-warn-title"><CloudIcon name="alert" cls="" /><span>Choose who to pair as</span></div>
            <label className="pair-select"><span>Pair as</span>
              <select id="pairChoose" defaultValue="" onChange={(e) => { if (e.target.value) void load(e.target.value); }}>
                <option value="" disabled>Select a human…</option>
                {view.humans.map((h) => <option key={h.id} value={h.id}>{h.alias} (human)</option>)}
              </select>
            </label>
          </div>
        );
      case "payload": {
        const data = view.data;
        const human = data.humanAgentAlias || "selected human";
        const cloud = cloudContext(data.baseUrl);
        return (
          <div className="pair-grid">
            <div className="pair-card">
              <div className="pair-brand"><OrcaMark /><span className="pair-wordmark">Orcha</span></div>
              <div className="pair-qr" role="img" aria-label="Orcha phone pairing QR code" dangerouslySetInnerHTML={{ __html: data.qrSvg || "" }} />
              <div className="pair-scanline">Scan with the Orcha app</div>
              <div className="pair-url mono">{data.baseUrl || ""}</div>
            </div>
            <div className="pair-meta">
              <div>
                <div className="pair-label">Pairing as</div>
                <div className="pair-value">
                  {identity && identity.github_login
                    ? <span className="pair-identity"><GhAvatar login={identity.github_login} size="sm" /><span className="gh-login">{identity.github_login}</span></span>
                    : `${human} (human)`}
                </div>
              </div>
              <div>
                <div className="pair-label">Manual code</div>
                <div className="pair-code mono">{data.shortCode || ""}</div>
              </div>
              <div className="pill s-warn pair-expiry" id="pairCountdown"><Icon name="clock" cls="gl" /><span id="pairCountText">{countLeft}</span></div>
              <div className="pair-foot">{footCopy(cloud)}</div>
            </div>
          </div>
        );
      }
    }
  };

  return <div id="pairBody">{body()}</div>;
}

/**
 * PairingModal — the overlay/dialog chrome around PairingPanel. Rendered via a
 * React PORTAL to document.body: launchers live inside the topbar, whose
 * backdrop-filter (shell.css) makes it the containing block for
 * position:fixed descendants — an inline .overlay would center over the
 * TOPBAR, not the viewport, with no page-dimming backdrop. Portaling restores
 * the vanilla document-level overlay: centered, dimmed, outside-click and
 * Escape both close.
 */
export function PairingModal({ cid, name, identity, onClose }: {
  cid: string;
  name?: string;
  identity: PairingIdentity | null; // trusted-lane resolved identity (or null)
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal pair-modal" role="dialog" aria-modal="true" aria-labelledby="pairTitle">
        <div className="pair-head">
          <span className="pair-mark"><OrcaMark /></span>
          <div className="grow">
            <h3 id="pairTitle">Pair your phone</h3>
            <p>{scanCopy(cloudContext())}{name ? <> Project: <b>{name}</b>.</> : null}</p>
          </div>
          <button className="iconbtn" id="pairClose" type="button" title="Close" onClick={onClose}><Icon name="x" cls="" /></button>
        </div>
        <div className="pair-content">
          <PairingPanel cid={cid} identity={identity} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
