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
import "./connectRepo.css";

export interface ConnectRepoModalProps {
  cid: string;
  /** dirname the local entry should show if the backend hasn't shipped the
   * prepended local repo entry yet (defensive fallback — see loadRepos()). */
  fallbackLocalName?: string | null;
  currentRepo?: string | null;
  onClose: () => void;
  onBound: (repo: string | null) => void;
}

type LoadState = "loading" | "ready" | "error";

export function ConnectRepoModal({ cid, fallbackLocalName, currentRepo, onClose, onBound }: ConnectRepoModalProps) {
  const toast = useToast();
  const [state, setState] = useState<LoadState>("loading");
  const [available, setAvailable] = useState(false);
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
    setAvailable(!!payload.available);
    setState("ready");
  }, [cid]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choose = async (repo: string) => {
    if (busyRepo) return;
    setBusyRepo(repo);
    const res = await putRepoBinding(cid, repo);
    setBusyRepo(null);
    if (!res.ok) {
      toast("Couldn't connect the repo" + (res.detail ? ": " + res.detail : " (" + res.status + ")"), "danger");
      return;
    }
    toast(isLocalRepo(repo) ? "Connected — using the local repository." : "Connected — " + repo, "ok");
    onBound(repo);
    onClose();
  };

  // Defensive: render a local row even when the backend hasn't shipped the
  // prepended local entry yet (parallel-built gap #3) — falls back to a
  // generic "This machine" label with no dirname.
  const localName = (localEntry && (localEntry.name || undefined)) || fallbackLocalName || null;
  const localBound = isLocalRepo(currentRepo);

  return createPortal(
    <div className="overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal cr-modal" role="dialog" aria-modal="true" aria-labelledby="crTitle">
        <div className="mh">
          <h3 id="crTitle">Connect a repository</h3>
          <p>Browse and dispatch agents against either this machine&#39;s own git repository or a repo on GitHub.</p>
        </div>
        <div className="mb cr-body">
          <div className="cr-section">
            <div className="cr-section-h">This machine</div>
            <button
              type="button"
              className={"cr-row cr-row-local" + (localBound ? " on" : "")}
              disabled={!!busyRepo}
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

          <div className="cr-section">
            <div className="cr-section-h">GitHub</div>
            {state === "loading" ? (
              <div className="cr-empty">Checking GitHub access…</div>
            ) : !available || !githubRepos.length ? (
              <div className="cr-empty">
                <p>{available ? "No repositories found for the active GitHub access." : "No GitHub access configured yet."}</p>
                <p className="cr-hint">
                  <Link to="/settings" onClick={onClose}>Settings → GitHub access</Link> unlocks repo listing,
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
                      disabled={!!busyRepo || !name}
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
