/**
 * RepoBadge — renders a container's bound repo two ways (Orcha Cloud local
 * run, Addendum 2 deliverable 2): a normal binding is the owner/name text
 * (optionally linked to github.com); a LOCAL binding ("local") renders as
 * the workspace name plus a small "Local" chip instead — never a link to
 * a repo literally called "local" on github.com.
 *
 * Used wherever a bound repo full_name surfaces: the GitHub page header,
 * project cards (ProjectsPage), and any future Code Space anchor that wants
 * the same treatment.
 *
 * Local-binding + GitHub-origin fall-through (simultaneous local binding +
 * GitHub hub): `originRepo` lets a LOCAL badge additionally show the working
 * tree's detected GitHub origin as a muted "· owner/name" suffix — both
 * truths at once (this project IS local-bound, AND its hub data is being
 * served from that GitHub repo) rather than picking one to display. Ignored
 * entirely on a non-local badge (a GitHub-bound repo has no separate
 * "origin" concept here).
 */
import { Icon } from "../../components/ui";
import { CloudIcon } from "../projects/icons";
import { isLocalRepo, repoDisplayName } from "./connectRepo";

export interface RepoBadgeProps {
  repo: string | null | undefined;
  /** workspace/project display name, used as the local label when known. */
  workspaceName?: string | null;
  /** render the GitHub full_name as a clickable github.com link (never for local). */
  link?: boolean;
  className?: string;
  /** local-binding + GitHub-origin fall-through: the detected origin repo
   * (owner/name), shown as a muted suffix — local badge only, else ignored. */
  originRepo?: string | null;
}

export function RepoBadge({ repo, workspaceName, link, className, originRepo }: RepoBadgeProps) {
  if (!repo) return null;
  const local = isLocalRepo(repo);
  const cls = "repo-badge" + (local ? " local" : "") + (className ? " " + className : "");
  if (local) {
    return (
      <span className={cls} data-repo-kind="local" title="Local git repository — works offline, no GitHub needed">
        <CloudIcon name="folder" cls="" />
        <span className="repo-badge-name">{repoDisplayName(repo, workspaceName)}</span>
        <span className="repo-badge-chip">Local</span>
        {originRepo ? <span className="repo-badge-origin muted">· {originRepo}</span> : null}
      </span>
    );
  }
  const label = <><Icon name="link" cls="" />{repo}</>;
  return (
    <span className={cls} data-repo-kind="github" title={repo}>
      {link ? (
        <a href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : label}
    </span>
  );
}
