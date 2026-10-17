/**
 * RepoNotConnected — the ONE "no repository connected" empty state shared by
 * the GitHub hub and Code Space (same icon, title, body, CTA and placement),
 * so the same condition never reads two different ways (review r2).
 *
 * Pass `onConnect` to open the connect dialog in place (GitHub hub), or `to`
 * to route to it (Code Space → /github?connect=1).
 */
import { Button, ButtonLink, EmptyState } from "../../components/primitives";
import "./repoNotConnected.css";

export const REPO_NOT_CONNECTED_TITLE = "No repository connected";
export const REPO_NOT_CONNECTED_BODY =
  "Connect this project to a repository — this machine's own git repo, or GitHub — to browse its code, issues and pull requests.";
export const REPO_NOT_CONNECTED_CTA = "Connect repo";

export function RepoNotConnected({ onConnect, to, className, disabledReason }: {
  onConnect?: () => void; to?: string; className?: string;
  /** Set when the viewer can't bind a repo (viewer / non-member / no
   *  manage_repo grant): the CTA is disabled and the reason is shown, instead
   *  of an action the server will refuse (e2e-permissions-16). */
  disabledReason?: string | null;
}) {
  const action = disabledReason
    ? <Button variant="primary" icon="link" disabled title={disabledReason}>{REPO_NOT_CONNECTED_CTA}</Button>
    : to != null
      ? <ButtonLink variant="primary" icon="link" to={to}>{REPO_NOT_CONNECTED_CTA}</ButtonLink>
      : <Button variant="primary" icon="link" onClick={onConnect}>{REPO_NOT_CONNECTED_CTA}</Button>;
  const body = disabledReason
    ? <>{REPO_NOT_CONNECTED_BODY}<span className="repo-not-connected-reason">{disabledReason} — ask an owner to connect one.</span></>
    : REPO_NOT_CONNECTED_BODY;
  return (
    <div className={"repo-not-connected" + (className ? " " + className : "")}>
      <EmptyState icon="git" title={REPO_NOT_CONNECTED_TITLE} body={body} action={action} />
    </div>
  );
}
