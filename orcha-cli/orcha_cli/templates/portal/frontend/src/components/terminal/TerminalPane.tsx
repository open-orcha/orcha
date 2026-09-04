/**
 * S3 §3b "Pair in terminal" — React port of the conversation↔terminal PAIRING
 * half of static/conversation.js (togglePair / gateThenPair / openPair /
 * termShell / onTermState / termFail / preflightFail / showSaving / closePair /
 * unpair / maximize) on top of the OrchaTerm engine port (./orchaTerm, the
 * static/terminal.js contract, UNCHANGED). All user-facing copy is verbatim
 * from the vanilla page; the xterm vendored assets load at runtime via
 * ./xtermAssets (the SPA never bundles a second xterm).
 *
 * Shape: `usePairing(agent)` owns the whole flow and hands the host page
 *   - togglePair()            wire to the "Pair in terminal" header button
 *   - paired / termConnected  drives the .paired grid class + the §3b lock
 *   - termSlot                the docked <TerminalPane> (render in .term-slot)
 *   - overlays                §3b preempt + ISS-84 not-installed modals and
 *                             the shared ISS-65 maximize backdrop
 *   - maxed / toggleMax       ISS-65 (exclusive: "conv" | "term" | null)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { leaseOf } from "../../lib/status";
import { actingHuman, useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Icon, Modal, useToast } from "../ui";
import * as OrchaTerm from "./orchaTerm";
import type { PreflightResult, TermFrameInfo } from "./orchaTerm";
import { loadXtermAssets } from "./xtermAssets";

// ISS-69(a): name the lease HOLDER in human terms instead of leaking the wire
// `lease_kind`. resident = a warm conversation; live = a human terminal;
// ephemeral = a background task.
const HOLDER_DOING: Record<string, string> = {
  resident: "in a live conversation",
  live: "in a live terminal",
  ephemeral: "running a task",
};
function holderDoing(kind: string | undefined): string {
  return (kind && HOLDER_DOING[kind]) || "in another live session";
}

export interface TermCta {
  label: string;
  kind?: string;
  onClick: () => void;
}
export interface TermError {
  kind: string;
  title: string;
  msg: string;
  cta?: TermCta[];
}

type SavingMode = null | "close" | "handoff";
export type MaxTarget = "conv" | "term" | null;

/* ---------- the docked terminal panel (vanilla termShell markup) ---------- */
interface TerminalPaneProps {
  alias: string;
  tagText: string;
  saving: SavingMode;
  error: TermError | null;
  maximized: boolean;
  onToggleMax: () => void;
  onClose: () => void;
  onHostMount: (el: HTMLElement) => void;
  onHostUnmount: () => void;
}

export function TerminalPane({ alias, tagText, saving, error, maximized, onToggleMax, onClose, onHostMount, onHostUnmount }: TerminalPaneProps) {
  const mountRef = useRef(onHostMount);
  const unmountRef = useRef(onHostUnmount);
  mountRef.current = onHostMount;
  unmountRef.current = onHostUnmount;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // mount → OrchaTerm.open (fresh or ISS-71 re-attach); unmount → DETACH (the
  // socket stays open so the session survives nav; an explicit Close already
  // tore the session down via unpair, making the detach a no-op).
  useEffect(() => {
    if (bodyRef.current) mountRef.current(bodyRef.current);
    return () => unmountRef.current();
  }, []);

  return (
    <div className={"term" + (maximized ? " maximized" : "")} id="convTerm">
      <div className="term-h">
        <div className="lights">
          <i className="r" />
          <i className="y" />
          <i className="g" />
        </div>
        <div className="ttl">{alias.toLowerCase()}@orcha — pair session</div>
        <span className="pairtag" id="termTag">
          <span className="d" />
          <span id="termTagText">{tagText}</span>
        </span>
        <div className="term-actions">
          <button className="x term-max" id="termMax" title={maximized ? "Restore terminal" : "Maximize terminal"} onClick={onToggleMax}>
            <Icon name={maximized ? "minimize" : "maximize"} cls="" />
          </button>
          <button className="x" id="termClose" title="Close & save session" onClick={onClose}>
            <Icon name="x" cls="" />
          </button>
        </div>
      </div>
      <div className="term-body" id="termBody" ref={bodyRef} />
      {/* the ref's "saving session" overlay — mode "close" = snapshot-on-close
          (Vault digest write); mode "handoff" = ISS-69 yield. */}
      {saving && (
        <div className="term-saving">
          <div className="ring" />
          <div className="st">{saving === "handoff" ? "Handing off — saving session" : "Closing — saving session"}</div>
          <div className="sub">
            {saving === "handoff"
              ? `Snapshotting ${alias}'s live conversation, then handing you the terminal…`
              : `Writing terminal history into ${alias}'s memory digest…`}
          </div>
        </div>
      )}
      {/* failure → keep the panel OPEN with a VISIBLE message (no silent flash);
          rendered after .term-saving so it stacks on top, like the vanilla DOM. */}
      {error && (
        <div className="term-error">
          <Icon name="shield" cls="" />
          <div className="te-tx">
            <div className="st">{error.title}</div>
            <div className="sub">{error.msg}</div>
            {error.cta && error.cta.length > 0 && (
              <div className="te-cta">
                {error.cta.map((c, i) => (
                  <button key={i} className={"btn sm " + (c.kind || "ghost")} onClick={c.onClick}>
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- the pairing flow ---------------------------------------------- */
export interface Pairing {
  paired: boolean;
  termConnected: boolean;
  togglePair: () => void;
  maxed: MaxTarget;
  toggleMax: (which: "conv" | "term") => void;
  termSlot: ReactNode;
  overlays: ReactNode;
}

export function usePairing(agent: Agent): Pairing {
  const { snap } = useSnapshot();
  const toast = useToast();
  const aid = agent.id;

  const [paired, setPaired] = useState(false);
  const [termConnected, setTermConnected] = useState(false);
  const [tagText, setTagText] = useState("connecting…");
  const [saving, setSaving] = useState<SavingMode>(null);
  const [error, setError] = useState<TermError | null>(null);
  const [preemptModal, setPreemptModal] = useState<null | "resident" | "ephemeral">(null);
  const [notInstalled, setNotInstalled] = useState<PreflightResult | null>(null);
  const [maxed, setMaxedState] = useState<MaxTarget>(null);

  // latest values for the imperative callbacks (onState outlives any render)
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const pairedRef = useRef(paired);
  pairedRef.current = paired;
  const termConnectedRef = useRef(false);
  const maxedRef = useRef<MaxTarget>(null);
  const openOptsRef = useRef<{ preempt: boolean; humanId: string | null }>({ preempt: false, humanId: null });

  const setMaxed = useCallback((v: MaxTarget) => {
    maxedRef.current = v;
    setMaxedState(v);
  }, []);
  const toggleMax = useCallback(
    (which: "conv" | "term") => setMaxed(maxedRef.current === which ? null : which),
    [setMaxed],
  );

  // port of app.js copyText (the vanilla modal CTA used O().copyText)
  const copyText = useCallback(
    (s: string) => {
      try {
        void navigator.clipboard.writeText(s);
        toast("Copied", "ok");
      } catch { /* clipboard unavailable */ }
    },
    [toast],
  );

  const unpair = useCallback(() => {
    pairedRef.current = false;
    setPaired(false);
    termConnectedRef.current = false;
    setTermConnected(false);
    OrchaTerm.cleanup(agentRef.current.id);
    setSaving(null);
    setError(null);
    if (maxedRef.current === "term") setMaxed(null); // the maximized panel just went away — restore the dock
  }, [setMaxed]);

  // failure → keep the panel OPEN with a VISIBLE message; the dead ws/xterm is
  // torn down. Optional `cta` (ISS-84 #244) = corrective-action buttons.
  const termFail = useCallback((kind: string, title: string, msg: string, cta?: TermCta[]) => {
    OrchaTerm.cleanup(agentRef.current.id);
    setTagText(kind);
    setError({ kind, title, msg, cta });
  }, []);

  // forward declaration so retryPair (used inside preflightFail) can re-gate.
  const gateThenPairRef = useRef<(preempt: boolean) => void>(() => {});
  const retryPair = useCallback(() => {
    unpair();
    gateThenPairRef.current(false);
  }, [unpair]);

  // Part B (ISS-84 #244): map a typed CLI-exit class to the right corrective
  // prompt + CTA, keyed off the runtime. HONESTY GUARD (Helm sign-off): only
  // not_installed/auth_required/usage_limit are named — anything else degrades
  // to a neutral "couldn't start — see terminal output" + Retry, NEVER a
  // fabricated cause.
  const preflightFail = useCallback(
    (info: TermFrameInfo) => {
      const a = agentRef.current;
      const nm = a ? a.alias : "agent";
      const runtime = info.runtime || (a as Agent & { model_runtime?: string }).model_runtime || "claude";
      const isCodex = runtime === "codex";
      const product = isCodex ? "Codex CLI" : "Claude Code";
      const provider = isCodex ? "OpenAI" : "Claude";
      const hint =
        info.install_hint ||
        (isCodex
          ? "Install Codex CLI or set ORCHA_CODEX_EXEC=/absolute/path/to/codex."
          : "Install Claude Code or set ORCHA_CLAUDE_EXEC=/absolute/path/to/claude.");
      const detail = info.detail ? String(info.detail) : "";
      const retry: TermCta = { label: "Retry", kind: "approve", onClick: retryPair };
      switch (info.exitClass) {
        case "not_installed":
          termFail(
            "not installed",
            product + " isn't installed",
            product + " isn't on this host's PATH, so " + nm + "'s session can't start. " + hint,
            [{ label: "Copy install hint", onClick: () => copyText(hint) }, retry],
          );
          return;
        case "auth_required":
          termFail(
            "sign-in needed",
            "Sign in to " + provider,
            nm + "'s " + product + " needs to be authenticated with " + provider + " before it can run." +
              (detail ? " " + detail : "") + " Authenticate the CLI on the host, then retry.",
            [retry],
          );
          return;
        case "usage_limit":
          termFail(
            "usage limit",
            provider + " usage limit reached",
            nm + "'s " + product + " hit a " + provider + " usage limit." + (detail ? " " + detail : "") +
              " Top up or wait for it to reset, then retry.",
            [retry],
          );
          return;
        default: // "unknown" / unrecognized — HONESTY GUARD: no fabricated cause
          termFail(
            "couldn't start",
            "Couldn't start the session",
            nm + "'s CLI exited before connecting — see the terminal output above for details.",
            [retry],
          );
      }
    },
    [copyText, retryPair, termFail],
  );

  const onTermState = useCallback(
    (state: string, info?: TermFrameInfo) => {
      const a = agentRef.current;
      const nm = a ? a.alias : "agent";
      const code = info && info.code;
      const holder = info && info.holder; // present ONLY when a lease is genuinely HELD (4409)
      // ISS-67: while the bridge is still booting on a cold reopen, the engine
      // retries with bounded backoff and reports progress here.
      if (state === "connecting") {
        setTagText(info && info.bridgeStarting ? "starting bridge… (" + info.attempt + "/" + info.max + ")" : "connecting…");
        return;
      }
      // connected → CLEAR any saving/hand-off overlay (P1, kedar review #179)
      // and any leftover busy/error guard (ISS-80) so nothing sits over the
      // live terminal.
      if (state === "connected") {
        termConnectedRef.current = true;
        setTermConnected(true);
        setSaving(null);
        setError(null);
        setTagText("live · paired as " + nm);
        return;
      }
      if (state === "snapshotting") {
        setSaving("close");
        setTagText("saving…");
        return;
      }
      // ISS-69(b): the bridge yields an IDLE warm resident on preempt — show
      // the handoff in flight; the `connected` branch above clears it.
      if (state === "yielding") {
        setSaving("handoff");
        setTagText("handing off…");
        return;
      }
      // The bridge sends `lease_denied` for BOTH the not-human denial (4403, NO
      // holder) AND the genuinely-busy case (4409, carries `holder`) — key off
      // holder/code so 4403 isn't mislabeled "busy".
      if (code === 4409 || (state === "lease_denied" && holder)) { // BUSY: a live lease is held
        const reason = info && info.reason ? String(info.reason) : "";
        termFail(
          "busy",
          nm + " is busy",
          nm + " is " + holderDoing(holder) + "." + (reason ? " " + reason + "." : "") +
            " End that session, then re-open here — or use Pair to hand it off.",
        );
        return;
      }
      if (code === 4403 || state === "lease_denied") { // DENIED: no valid human actor
        termFail("denied", "Not permitted", "Couldn't pair as " + nm + " — pick an acting human (top-right) the bridge recognizes, then re-open.");
        return;
      }
      if (code === 4404) {
        termFail("denied", "Agent not recognized", "The bridge didn't recognize this agent — reload and try again.");
        return;
      }
      if (code === 4400) {
        termFail("denied", "Bad request", "The terminal request was malformed (missing ids).");
        return;
      }
      // Part B (ISS-84 #244): typed `exitClass` on the frame → the matching
      // corrective prompt. MUST precede the unreachable bucket and the
      // agent_exited cleanup at the foot.
      if (info && info.exitClass) {
        preflightFail(info);
        return;
      }
      // never reached "connected" → the bridge is unreachable (down / starting up / wrong port).
      if (!termConnectedRef.current && (state === "error" || state === "closed")) {
        termFail(
          "down",
          "Terminal bridge not reachable",
          "It starts with the workspace — if you just (re)installed it may still be coming up. Otherwise start it with:  orcha terminal-bridge",
        );
        return;
      }
      // a live session ended normally → tidy up (snapshot already shown via 'snapshotting').
      if (state === "closed" || state === "agent_exited" || state === "error" || state === "no_human") {
        if (state === "closed") toast("Terminal closed — session snapshotted", "ok");
        unpair();
      }
    },
    [preflightFail, termFail, toast, unpair],
  );

  // open a fresh session OR RE-ATTACH an existing one (ISS-71: the session
  // survives nav, so returning to the agent re-docks the live terminal).
  const openPair = useCallback(
    async (preempt: boolean) => {
      const reattach = OrchaTerm.hasSession(aid);
      const h = actingHuman(snapRef.current);
      if (!reattach && !h) {
        toast("Pick an acting human (top-right) first.", "danger");
        return;
      }
      const ok = await loadXtermAssets();
      if (!ok) {
        toast("Terminal unavailable — assets not loaded", "danger");
        return;
      }
      openOptsRef.current = { preempt, humanId: h ? String(h.id) : null };
      const connectedNow = reattach && OrchaTerm.isConnected(aid);
      termConnectedRef.current = connectedNow;
      setTermConnected(connectedNow);
      setSaving(null);
      setError(null);
      setTagText(reattach ? "reattaching…" : "connecting…");
      pairedRef.current = true;
      setPaired(true); // → TerminalPane mounts → onHostMount → OrchaTerm.open
    },
    [aid, toast],
  );

  // Part A (ISS-84 #244): DETERMINISTIC READINESS PRE-GATE. installed===false
  // is the only pre-launch blocker; FAIL-OPEN on a null probe. Re-attach skips
  // the gate entirely (that session is already live; nothing to pre-check).
  const gateThenPair = useCallback(
    (preempt: boolean) => {
      if (OrchaTerm.hasSession(aid)) {
        void openPair(preempt);
        return;
      }
      OrchaTerm.preflight(aid)
        .then((pf) => {
          if (pf && pf.installed === false) {
            setNotInstalled(pf);
            return;
          }
          void openPair(preempt);
        })
        .catch(() => void openPair(preempt)); // any probe failure -> fail-open
    },
    [aid, openPair],
  );
  gateThenPairRef.current = gateThenPair;

  const closePair = useCallback(() => {
    setSaving("close");
    if (OrchaTerm.isOpen(aid)) OrchaTerm.close(aid); // -> snapshot-on-close -> 'closed' -> unpair()
    else unpair();
  }, [aid, unpair]);

  const togglePair = useCallback(() => {
    if (pairedRef.current) {
      closePair();
      return;
    }
    const a = agentRef.current;
    const lease = leaseOf(a);
    if (lease === "live") {
      toast(a.alias + " already holds a live session", "danger");
      return;
    }
    if (lease === "ephemeral" || lease === "resident") {
      // busy -> human-gated graceful preempt (§3b); distinct copy per holder (ISS-69(b))
      setPreemptModal(lease);
      return;
    }
    gateThenPair(false); // idle -> open directly
  }, [closePair, gateThenPair, toast]);

  // ISS-71: if a live terminal session survived a previous nav, re-dock it
  // (reattach) instead of showing the un-paired guard.
  useEffect(() => {
    if (OrchaTerm.hasSession(aid)) void openPair(false);
    // per-mount: the host component is keyed by agent.id upstream
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ISS-65: a panel changed size → let xterm's fit addon re-measure (the
  // engine listens on window 'resize'); Escape restores a maximized panel.
  useEffect(() => {
    try {
      window.dispatchEvent(new Event("resize"));
    } catch { /* jsdom */ }
    if (!maxed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMaxed(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [maxed, setMaxed]);

  const onHostMount = useCallback(
    (el: HTMLElement) => {
      OrchaTerm.open(el, aid, {
        preempt: openOptsRef.current.preempt,
        humanId: openOptsRef.current.humanId,
        onState: onTermState,
      });
    },
    [aid, onTermState],
  );
  const onHostUnmount = useCallback(() => {
    // ISS-71: nav-away DETACHES the terminal (xterm out of the DOM, socket
    // stays open); it is only CLOSED via the explicit Close button or reload.
    OrchaTerm.detach(aid);
  }, [aid]);

  const nm = agent.alias;
  const termSlot: ReactNode = paired ? (
    <TerminalPane
      alias={nm}
      tagText={tagText}
      saving={saving}
      error={error}
      maximized={maxed === "term"}
      onToggleMax={() => toggleMax("term")}
      onClose={closePair}
      onHostMount={onHostMount}
      onHostUnmount={onHostUnmount}
    />
  ) : null;

  // Pre-gate blocker UX (ISS-84 #244): the runtime CLI isn't installed on the
  // host, so a PTY would just exit — surface the install prompt instead of
  // opening a doomed terminal. Copy mirrors the canonical install-hint strings.
  let notInstalledModal: ReactNode = null;
  if (notInstalled) {
    const runtime = notInstalled.runtime || (agent as Agent & { model_runtime?: string }).model_runtime || "claude";
    const isCodex = runtime === "codex";
    const product = isCodex ? "Codex CLI" : "Claude Code";
    const hint =
      notInstalled.install_hint ||
      (isCodex
        ? "Install Codex CLI or set ORCHA_CODEX_EXEC=/absolute/path/to/codex."
        : "Install Claude Code or set ORCHA_CLAUDE_EXEC=/absolute/path/to/claude.");
    notInstalledModal = (
      <Modal
        title={product + " isn't installed"}
        desc={
          "Pairing as " + nm + " runs " + product +
          " on this host, but it isn't on the PATH. Install it (or point Orcha at it with the override env), then pair again."
        }
        primary="Copy install hint"
        cancel="Dismiss"
        onPrimary={() => {
          copyText(hint);
          setNotInstalled(null);
        }}
        onClose={() => setNotInstalled(null)}
      >
        <div className="pf-hint">
          <code>{hint}</code>
        </div>
      </Modal>
    );
  }

  const overlays: ReactNode = (
    <>
      {preemptModal && (
        <Modal
          title={preemptModal === "resident" ? "Hand off the live conversation?" : "Preempt the running task?"}
          primary={preemptModal === "resident" ? "Hand off & pair" : "Stop & pair"}
          desc={
            preemptModal === "resident"
              ? "Hand off " + nm + "'s warm conversation? It's saved (snapshotted) first, then you get the live terminal — " +
                nm + " can resume from the saved state."
              : nm + " is running a task. Pairing gracefully stops it — its progress is snapshotted first — and gives you the live terminal."
          }
          onPrimary={() => {
            setPreemptModal(null);
            gateThenPair(true);
          }}
          onClose={() => setPreemptModal(null)}
        />
      )}
      {notInstalledModal}
      {/* ISS-65: shared maximize backdrop — click (or Escape) restores the dock */}
      {maxed && <div className="max-backdrop" id="convMaxBackdrop" onClick={() => setMaxed(null)} />}
    </>
  );

  return { paired, termConnected, togglePair, maxed, toggleMax, termSlot, overlays };
}
