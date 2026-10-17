/**
 * ConnectRepoModal — the repo-binding picker (Orcha Cloud local run,
 * Addendum 2: docs/orcha-cloud-local-run.md "code source: local or GitHub").
 * Two sections: "This machine" (the local git repository the portal was
 * init'd against — zero setup, works offline) and "GitHub" (the App/PAT
 * repo listing, whatever token source is active). Choosing an entry PUTs
 * the binding: {"repo": "local"} for the local entry, {"repo": full_name}
 * for a GitHub repo.
 *
 * Modeled on PairingModal's raw .overlay/.modal portal chrome (a repo list
 * doesn't fit the shared <Modal>'s single primary/cancel footer — each row
 * IS its own action) plus the settings sc-* banner idiom for the GitHub
 * empty state.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Icon, useToast } from "../../components/ui";
import { CloudIcon } from "../projects/icons";
import { fetchGithubRepos, isLocalRepo, LOCAL_REPO_SENTINEL, putRepoBinding, type GhRepoEntry } from "./connectRepo";
import { bindErrorText } from "./repoPermissions";
import "./connectRepo.css";

export interface ConnectRepoModalProps {
  cid: string;
  /** dirname the local entry should show if the backend hasn't shipped the
   * prepended local repo entry yet (defensive fallback — see loadRepos()). */
  fallbackLocalName?: string | null;
  currentRepo?: string | null;
  onClose: () => void;
  onBound: (repo: string | null) => void;
  /** Why the viewer may not change the binding (viewer / non-member / no
   *  manage_repo grant). Set → every row is disabled and the reason shown;
   *  the server would refuse the PUT anyway (e2e-permissions-16). */
  blockedReason?: string | null;
}

type LoadState = "loading" | "ready" | "error";

export function ConnectRepoModal({ cid, fallbackLocalName, currentRepo, onClose, onBound, blockedReason }: ConnectRepoModalProps) {
  const toast = useToast();
  const [state, setState] = useState<LoadState>("loading");
  const [source, setSource] = useState<string | null>(null);
  const [ghDetail, setGhDetail] = useState<string | null>(null);
  const [githubRepos, setGithubRepos] = useState<GhRepoEntry[]>([]);
  const [localEntry, setLocalEntry] = useState<GhRepoEntry | null>(null);
  const [busyRepo, setBusyRepo] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    const payload = await fetchGithubRepos(cid);
    const repos = payload.repos || [];
    const local = repos.find((r) => r.source_kind === "local" || r.full_name === LOCAL_REPO_SENTINEL) || null;
    setLocalEntry(local);
    setGithubRepos(repos.filter((r) => r !== local && r.full_name !== LOCAL_REPO_SENTINEL));
    setSource(payload.source || null);
    setGhDetail(typeof payload.detail === "string" ? payload.detail : null);
    setState("ready");
  }, [cid]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choose = async (repo: string) => {
    if (busyRepo || blockedReason) return;
    setBusyRepo(repo);
    const res = await putRepoBinding(cid, repo);
    setBusyRepo(null);
    if (!res.ok) {
      toast("Couldn't connect the repo: " + bindErrorText(res.status, res.detail), "danger");
      return;
    }
    toast(isLocalRepo(repo) ? "Connected — using the local repository." : "Connected — " + repo, "ok");
    onBound(repo);
    onClose();
  };

  // The backend prepends a local entry ONLY when local_git.available() — a
  // row offered without it would PUT {"repo":"local"} into a guaranteed 400
  // (parity: ORCHA_LOCAL_REPO_DIR unset still offered "This machine"). The
  // row stays when the project is ALREADY bound local, so the current
  // binding is always visible.
  const localBound = isLocalRepo(currentRepo);
  const showLocal = state === "ready" && (!!localEntry || localBound);
  const localName = (localEntry && (localEntry.name || undefined)) || (localBound ? fallbackLocalName : null) || null;
  // The payload's `available` is true for a local-only listing too — only a
  // real App/PAT `source` means "GitHub access is configured".
  const hasGithubSource = !!source;
  const locked = !!busyRepo || !!blockedReason;

  return createPortal(
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal cr-modal" role="dialog" aria-modal="true" aria-labelledby="crTitle">
        <div className="mh">
          <h3 id="crTitle">Connect a repository</h3>
          <p>Browse and dispatch agents against either this machine&#39;s own git repository or a repo on GitHub.</p>
        </div>
        <div className="mb cr-body">
          {blockedReason ? (
            <p className="cr-blocked" role="note">{blockedReason} — ask an owner to connect or change the repository.</p>
          ) : null}
          {showLocal ? (
          <div className="cr-section">
            <div className="cr-section-h">This machine</div>
            <button
              type="button"
              className={"cr-row cr-row-local" + (localBound ? " on" : "")}
              disabled={locked}
              title={blockedReason || undefined}
              onClick={() => void choose(LOCAL_REPO_SENTINEL)}
            >
              <CloudIcon name="folder" cls="cr-row-ico" />
              <span className="cr-row-main">
                <span className="cr-row-name">{localName || "Local git repository"}</span>
                <span className="cr-row-caption">Local git repository — works offline, no GitHub needed</span>
              </span>
              {localBound ? <span className="cr-row-current">Connected</span> : null}
              {busyRepo === LOCAL_REPO_SENTINEL ? <span className="cr-row-busy">Connecting…</span> : null}
            </button>
          </div>
          ) : null}

          <div className="cr-section">
            <div className="cr-section-h">GitHub</div>
            {state === "loading" ? (
              <div className="cr-empty">Checking GitHub access…</div>
            ) : !githubRepos.length ? (
              <div className="cr-empty">
                <p>
                  {!hasGithubSource
                    ? "No GitHub access configured yet."
                    : ghDetail
                      ? "GitHub didn't return a repository list. Check GitHub access, then try again."
                      : "No repositories found for the active GitHub access."}
                </p>
                <p className="cr-hint">
                  <Link to="/settings#tab=github-access" onClick={onClose}>Settings → Integrations</Link> unlocks repo listing,
                  issues, pull requests, and checks.
                </p>
              </div>
            ) : (
              <div className="cr-list">
                {githubRepos.map((r) => {
                  const name = r.full_name || "";
                  const bound = currentRepo === name;
                  return (
                    <button
                      key={name}
                      type="button"
                      className={"cr-row" + (bound ? " on" : "")}
                      disabled={locked || !name}
                      title={blockedReason || undefined}
                      onClick={() => void choose(name)}
                    >
                      <Icon name="link" cls="cr-row-ico" />
                      <span className="cr-row-main">
                        <span className="cr-row-name">{name}</span>
                        {r.description ? <span className="cr-row-caption">{r.description}</span> : null}
                      </span>
                      {r.private ? <span className="cr-row-tag">Private</span> : null}
                      {bound ? <span className="cr-row-current">Connected</span> : null}
                      {busyRepo === name ? <span className="cr-row-busy">Connecting…</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="mf">
          <button className="btn ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
