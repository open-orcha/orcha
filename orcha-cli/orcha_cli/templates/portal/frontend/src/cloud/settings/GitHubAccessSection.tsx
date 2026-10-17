/**
 * ORCHA CLOUD — GitHub access settings card (Orcha Cloud local-run, gap #2:
 * docs/orcha-cloud-local-run.md section "Settings surface → GitHub access
 * card"). Same idiom as ProviderKeysSection: a `set-card` with `sc-*` banner/
 * row/hint/acts/result markup, human-gated mutations via the shared cloud
 * identity layer, drafts that survive the poll, masked display, toast on
 * every mutation outcome.
 *
 * Wire contract (frozen doc section 1 — backend built in parallel):
 *   GET    /api/containers/{cid}/settings/github-pat
 *     -> {configured, source: 'env'|'db'|null, masked, set_at}
 *   PUT    …/settings/github-pat   {token, actor_agent_id}
 *   DELETE …/settings/github-pat   {actor_agent_id}
 *   POST   …/settings/github-pat/test          {actor_agent_id}            (stored token)
 *   POST   …/settings/github-pat/test          {token, actor_agent_id}     (pasted token, pre-save)
 *     -> {ok, login?, detail?, scopes?}
 *
 * App-managed probe: GET /api/github/repos — the existing App-installation
 * repo listing (portal_backend/github_routes.py). Per the frozen doc it now
 * carries `source: "pat" | "app"` alongside the existing `available` flag; we
 * read `source` when present and otherwise fall back to `available` alone
 * (pre-rollout backend), so this card never hard-depends on the new field
 * shipping first. available:true + source !== "pat" reads as "App installation
 * is active" — the PAT section then collapses below it (App wins precedence
 * per the resolution order in section 1).
 */
import { useCallback, useEffect, useState } from "react";
import { Modal, useToast } from "../../components/ui";
import { Button } from "../../components/primitives";
import { GroupHead, SecretInput, StatusLine, TestResult, settingsErrText } from "../../pages/settings/settingsUi";
import { useGrantAuthority } from "../../pages/settings/grantAuthority";
import { errorDetailText } from "../../api/client";
import { relTime } from "../../lib/format";
import { useSnapshot } from "../../state/SnapshotProvider";
import { fetchMe, memActor, type Me } from "../identity";
import "./settings-cards.css";

/* ---- wire shapes ----------------------------------------------------------- */
interface PatStatus {
  configured?: boolean;
  source?: "env" | "db" | null;
  masked?: string | null;
  set_at?: string | null;
}
interface ReposProbe {
  available?: boolean;
  source?: "pat" | "app" | null;
  detail?: unknown;
}
interface TestResult {
  ok: boolean;
  login?: string | null;
  detail?: string | null;
}

/** A failed call in words: the server's detail (e.g. GitHub's rate-limit
 * message), else the status meaning — never a bare "(403)". Pure, tested. */
export function gaErrText(res: { status: number; body: Record<string, unknown> | null }): string {
  const d = res.body && res.body.detail;
  const t = d != null ? errorDetailText(d) : "";
  return t || settingsErrText({ status: res.status });
}

/* raw fetch with status passthrough — matches ProviderKeysSection's pkApi. */
interface GaRes { ok: boolean; status: number; body: Record<string, unknown> | null }
async function gaApi(method: string, path: string, body?: unknown): Promise<GaRes> {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    const r = await fetch(path, init);
    let j: GaRes["body"] = null;
    try { j = (await r.json()) as GaRes["body"]; } catch { /* empty body */ }
    return { ok: r.ok, status: r.status, body: j };
  } catch { return { ok: false, status: 0, body: null }; }
}

export function GitHubAccessSection() {
  const { cid, snap } = useSnapshot();
  const toast = useToast();
  const [status, setStatus] = useState<PatStatus | null>(null); // null until loaded
  // "forbidden": a 403 on the read (not a member) — Retry can't help (S1)
  const [statusErr, setStatusErr] = useState<false | "error" | "forbidden">(false);
  const [appManaged, setAppManaged] = useState(false);
  // INT-RATELIMIT: an installed App that failed (error / rate limit) — its detail
  const [appDown, setAppDown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  // Collab v1: resolve the acting identity once per page load (parity with
  // ProviderKeysSection / MembersPage).
  useEffect(() => {
    if (!cid) return;
    let alive = true;
    void fetchMe(cid).then((m) => { if (alive) setMe(m); });
    return () => { alive = false; };
  }, [cid]);

  const load = useCallback(async () => {
    if (!cid) return;
    setStatusErr(false);
    const res = await gaApi("GET", "/api/containers/" + encodeURIComponent(cid) + "/settings/github-pat");
    if (res.ok && res.body) {
      setStatus(res.body as PatStatus);
    } else {
      setStatus(null);
      setStatusErr(res.status === 403 ? "forbidden" : "error");
    }
  }, [cid]);

  // App-installation probe: reuse the existing repo-listing endpoint rather
  // than inventing a route. Only a definitive source === "app" means an App
  // token answered the call. A token-less stack with a mounted local tree
  // still returns available:true (the prepended "local" entry) with source
  // null — inferring "app" from that hid the PAT input on exactly the stacks
  // that needed it (the desktop-provisioned / stale-.env case).
  const probeApp = useCallback(async () => {
    const res = await gaApi("GET", "/api/github/repos");
    if (res.ok && res.body) {
      const body = res.body as ReposProbe;
      setAppManaged(!!body.available && body.source === "app");
      setAppDown(!body.available && body.source === "app"
        ? errorDetailText(body.detail) || "no answer"
        : null);
    } else {
      setAppManaged(false);
      setAppDown(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void probeApp(); }, [probeApp]);

  // PR #315 human gate — vanilla requireHuman() wording, actor via the shared
  // cloud acting helpers (trusted lane: the resolved member or nothing).
  // INT-PERM: the PAT routes enforce manage_keys (github_pat_routes.py); the
  // controls lock with the reason instead of offering a write that 403s.
  const auth = useGrantAuthority("manage_keys");
  const locked = !auth.can;
  const who = locked ? null : memActor(me, snap);
  const requireHuman = (verb: string): boolean => {
    if (who) return true;
    if (locked && auth.reason) { toast(auth.reason, "warn"); return false; }
    toast("Pick an acting human to " + verb + " GitHub access", "warn");
    return false;
  };

  const patUrl = (suffix = "") =>
    "/api/containers/" + encodeURIComponent(cid || "") + "/settings/github-pat" + suffix;

  const doSave = async () => {
    const v = draft.trim();
    if (!v || busy) return;
    if (!requireHuman("save")) return;
    setBusy(true);
    const res = await gaApi("PUT", patUrl(), { token: v, actor_agent_id: who ? who.id : null });
    setBusy(false);
    if (res.ok) {
      toast("GitHub token saved.", "ok");
      setTest(null);
      setDraft("");
      setReveal(false);
      void load();
      void probeApp();
    } else {
      // keep the typed value — a transient failure never loses it
      toast("Couldn't save the token — " + gaErrText(res) + ". Your input is preserved.", "danger");
    }
  };

  const doTest = async () => {
    if (busy) return;
    const v = draft.trim();
    if (!requireHuman("test")) return;
    setBusy(true);
    setTest(null);
    // Send the pasted token if present, else test the stored token (omit token).
    const res = await gaApi(
      "POST",
      patUrl("/test"),
      v ? { token: v, actor_agent_id: who ? who.id : null } : { actor_agent_id: who ? who.id : null },
    );
    setBusy(false);
    if (res.ok && res.body) {
      const body = res.body as { ok?: boolean; login?: string | null; detail?: string | null };
      setTest({ ok: !!body.ok, login: body.login, detail: body.detail });
      toast(body.ok ? "Token is valid" + (body.login ? " — signed in as " + body.login + "." : ".") : body.detail || "Token was rejected.", body.ok ? "ok" : "danger");
    } else {
      setTest({ ok: false, detail: "Test failed — " + gaErrText(res) + "." });
      toast("Test failed — " + gaErrText(res) + ".", "danger");
    }
  };

  const doRemove = () => {
    if (busy) return;
    if (!requireHuman("remove")) return;
    setConfirmRemove(true);
  };

  const doRemoveConfirmed = async () => {
    setBusy(true);
    const res = await gaApi("DELETE", patUrl(), { actor_agent_id: who ? who.id : null });
    setBusy(false);
    setConfirmRemove(false);
    if (res.ok) {
      toast("GitHub token removed.", "ok");
      setTest(null);
      void load();
      void probeApp();
    } else {
      toast("Couldn't remove the token — " + gaErrText(res) + ".", "danger");
    }
  };

  const configured = !!status && (status.source === "env" || status.source === "db" || status.configured === true);
  const mode: "db" | "env" | "none" = status?.source === "env" ? "env" : status?.source === "db" ? "db" : configured ? "db" : "none";

  const patBody = () => {
    if (statusErr === "forbidden") {
      return <StatusLine tone="warn" id="gaForbidden">You&#39;re not a member of this project.</StatusLine>;
    }
    if (statusErr) {
      return (
        <StatusLine
          tone="err"
          action={<Button size="sm" variant="ghost" icon="refresh" id="gaRetry" onClick={() => void load()}>Retry</Button>}
        >
          Couldn&#39;t load GitHub access settings.
        </StatusLine>
      );
    }
    if (!status) {
      return <StatusLine tone="muted">Checking GitHub access…</StatusLine>;
    }
    // I6: someone who can't manage keys (viewer / member without manage_keys)
    // sees the status only — never an editable secret field or dead buttons
    // (same as the Models KeyBody when locked).
    if (locked && !auth.pending) {
      return configured ? (
        <StatusLine tone={mode === "env" ? "env" : "ok"} masked={status.masked || "ghp_…"} id="ga-status">
          <b>Personal access token configured</b>
          {mode === "env" ? " · from the environment (ORCHA_GITHUB_PAT)." : " · stored encrypted on this workspace."}
          {status.set_at && <> Set {relTime(status.set_at)}.</>}
        </StatusLine>
      ) : (
        <StatusLine tone="warn" id="ga-status"><b>No personal access token configured.</b></StatusLine>
      );
    }
    if (mode === "env" || mode === "db") {
      return (
        <>
          <StatusLine
            tone={mode === "env" ? "env" : "ok"}
            masked={status.masked || "ghp_…"}
            action={mode === "db" ? (
              <Button size="sm" variant="ghost" className="sc-remove" icon="trash" id="ga-remove" disabled={busy || locked} title={locked ? auth.reason || undefined : undefined} onClick={doRemove}>
                Remove
              </Button>
            ) : null}
          >
            <b>Personal access token configured</b>
            {mode === "env"
              ? " · using ORCHA_GITHUB_PAT from the environment; it takes precedence, read-only here."
              : " · stored encrypted on this workspace."}
            {status.set_at && <> Set {relTime(status.set_at)}.</>}
          </StatusLine>
          {mode === "db" && (
            <SecretInput
              id="ga-input"
              revealId="ga-reveal"
              label="Replace the GitHub personal access token"
              placeholder="Paste a new token to replace…"
              value={draft}
              onChange={(v) => { setDraft(v); setTest(null); }}
              reveal={reveal}
              onToggleReveal={() => setReveal((r) => !r)}
            />
          )}
          <div className="sc-acts">
            {mode === "db" && (
              <Button size="sm" variant={draft.trim() ? "primary" : "secondary"} icon="check" id="ga-save" disabled={busy || locked || !draft.trim()} title={locked ? auth.reason || undefined : undefined} onClick={() => void doSave()}>
                Replace token
              </Button>
            )}
            <Button size="sm" variant={mode === "db" ? "ghost" : "secondary"} icon="spark" id="ga-test" disabled={busy || locked} title={locked ? auth.reason || undefined : undefined} onClick={() => void doTest()}>
              Test
            </Button>
          </div>
          {mode === "env" && (
            <div className="sc-hint">
              To change an environment token, update <code>ORCHA_GITHUB_PAT</code> and relaunch with <code>orcha up</code>.
            </div>
          )}
        </>
      );
    }
    // not configured
    return (
      <>
        <StatusLine tone="warn">
          <b>No personal access token configured.</b> Add one so GitHub features work without the App installation.
        </StatusLine>
        <SecretInput
          id="ga-input"
          revealId="ga-reveal"
          label="GitHub personal access token"
          placeholder="Paste a GitHub personal access token…"
          value={draft}
          onChange={(v) => { setDraft(v); setTest(null); }}
          reveal={reveal}
          onToggleReveal={() => setReveal((r) => !r)}
        />
        <div className="sc-hint">
          Already use the GitHub CLI? Run <code>gh auth token | pbcopy</code> in a terminal
          and paste here — no new token needed. (Restarting with <code>orcha up</code> picks
          your gh login up automatically, too.)
        </div>
        <div className="sc-hint">
          Or <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer noopener">create a token</a>
          {" "}— a classic PAT with the <code>repo</code> scope, or a fine-grained token with{" "}
          <b>Contents</b> + <b>Metadata</b> read access on the repos you want to use.
        </div>
        <div className="sc-acts">
          <Button size="sm" variant={draft.trim() ? "primary" : "secondary"} icon="check" id="ga-save" disabled={busy || locked || !draft.trim()} title={locked ? auth.reason || undefined : undefined} onClick={() => void doSave()}>
            Save token
          </Button>
          <Button size="sm" variant="ghost" icon="spark" id="ga-test" disabled={busy || locked || !draft.trim()} title={locked ? auth.reason || undefined : undefined} onClick={() => void doTest()}>
            Test
          </Button>
        </div>
      </>
    );
  };

  return (
    <div className="card set-card">
      <GroupHead
        title="GitHub access"
        lead="How Embodent signs in to GitHub for issues, pull requests and checks."
        help="A GitHub App installation always takes precedence when present; a personal access token is used only when no App token is present."
      />
      <div className="card-b">

        {locked && auth.reason && !auth.pending && (
          <div className="sc-hint" id="ga-locked">View-only — {auth.reason}</div>
        )}

        {appDown && (
          <StatusLine tone="warn" id="ga-app-down">
            <b>GitHub App installed, but GitHub didn&#39;t answer:</b> {appDown}
          </StatusLine>
        )}

        {appManaged && (
          <StatusLine tone="env" id="ga-app-managed">
            <b>GitHub App installation (managed)</b> · repo access is provided by the installed App.
          </StatusLine>
        )}

        {appManaged ? (
          <details id="ga-pat-details">
            <summary className="sc-hint sc-summary">
              Personal access token settings (used only when no App token is present)
            </summary>
            <div style={{ marginTop: 12 }}>{patBody()}</div>
          </details>
        ) : (
          patBody()
        )}

        {test && (
          <TestResult ok={test.ok}>
            {test.ok ? "Token is valid" + (test.login ? " — signed in as " + test.login + "." : ".") : test.detail || "Token was rejected."}
          </TestResult>
        )}
      </div>

      {confirmRemove && (
        <ConfirmRemoveModal onConfirm={() => void doRemoveConfirmed()} onClose={() => setConfirmRemove(false)} />
      )}
    </div>
  );
}

/* Local wrapper — same danger/confirm shape as ProviderKeysSection's Remove-key
 * modal, reusing the shared Modal component directly. */
function ConfirmRemoveModal({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      title="Remove GitHub token"
      danger
      primary="Remove token"
      desc="Deletes the stored personal access token for this workspace. If ORCHA_GITHUB_PAT is set in the environment, the client falls back to it; otherwise GitHub features that need a PAT go idle until one is added or the App is installed."
      onPrimary={onConfirm}
      onClose={onClose}
    />
  );
}
