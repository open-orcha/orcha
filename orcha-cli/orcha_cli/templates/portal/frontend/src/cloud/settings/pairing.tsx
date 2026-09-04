/**
 * ORCHA CLOUD — phone-pairing entry points over the shared pairing UI
 * (src/cloud/projects/PairingModal.tsx: PairingPanel + PairingModal):
 *
 *  - PairingButton: the topbar "Pair phone" button (vanilla app-shell.js
 *    #pairPhoneBtn), registered via the Extensions.topbarActions seam. Opens
 *    the PairingModal — portal'd to document.body so the overlay centers and
 *    dims the whole page even though the button lives inside the topbar.
 *  - PairingSection: the settings "Phone pairing" card (vanilla settings.html
 *    Collaboration-tab card), registered via Extensions.settingsSections. It
 *    renders the PairingPanel INLINE in the card body, so the QR loads and
 *    shows the moment the tab opens — countdown, auto-regenerate on expiry,
 *    and the choose-human picker all included; no button press needed.
 *
 * Both are cid-scoped to the LOADED container (vanilla openPairingModal() with
 * no opts — no project name line). The trusted-lane identity rides in via the
 * shared single-flighted fetchMe: a resolved signed-in member is the only
 * human a phone can pair as (the server enforces the same rule); trust off
 * keeps the panel's own picker semantics.
 */
import { useEffect, useState } from "react";
import { useToast } from "../../components/ui";
import { useSnapshot } from "../../state/SnapshotProvider";
import { CloudIcon } from "../projects/icons";
import { PairingModal, PairingPanel } from "../projects/PairingModal";
import { fetchMe, type Me } from "../identity";
import "./settings-cards.css";
import "./pairing.css";

function useMeIdentity(cid: string | null) {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!cid) return;
    let alive = true;
    void fetchMe(cid).then((m) => { if (alive) setMe(m); });
    return () => { alive = false; };
  }, [cid]);
  return me && me.trusted ? me.identity : null;
}

/* ---- topbar action (vanilla app-shell.js #pairPhoneBtn, markup verbatim) -- */
export function PairingButton() {
  const { cid } = useSnapshot();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const identity = useMeIdentity(cid);

  const launch = () => {
    if (!cid) { toast("No Orcha container is loaded.", "danger"); return; }
    setOpen(true);
  };

  return (
    <>
      <button
        className="btn sm subtle pair-top" id="pairPhoneBtn" type="button"
        title="Pair a phone with this Orcha" onClick={launch}
      >
        <CloudIcon name="phone" cls="" />Pair phone
      </button>
      {open && cid && (
        <PairingModal cid={cid} identity={identity} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/* ---- settings card: the pairing panel INLINE (QR on tab open) ------------- */
export function PairingSection() {
  const { cid } = useSnapshot();
  const identity = useMeIdentity(cid);

  return (
    <div className="card set-card">
      <div className="card-h"><h2>Phone pairing</h2></div>
      <div className="card-b">
        <div className="lead">
          Pair the Orcha mobile app with this workspace. Scan the code with the Orcha app — it
          explains how your phone connects.
        </div>
        <div id="pairingCard">
          {cid ? (
            <PairingPanel cid={cid} identity={identity} />
          ) : (
            <div className="sc-banner muted">
              <div className="bt">
                <CloudIcon name="phone" cls="" />
                <span>Waiting for a loaded Orcha container…</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
