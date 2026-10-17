/**
 * Edit context strip (V2, brief §5 Code Space: "make the source, branch/ref,
 * dirty state and destination of edits clear"). A one-line strip above the
 * open file that always answers four questions without the human having to
 * know the two flows apart:
 *
 *   1. SOURCE     — where this file is read from: the local working tree, a
 *                   GitHub repo (draft/proposal flow), or read-only.
 *   2. REF        — HEAD (with the real local branch name when the worktree
 *                   reports one) or a pinned commit/ref, with a way back.
 *   3. STATE      — viewing / editing, and whether there are unsaved or
 *                   drafted changes.
 *   4. DESTINATION— what happens to an edit: written to the working-tree file
 *                   (then Commit/Push from Changes) vs kept as a browser-local
 *                   draft until an explicit Propose opens a pull request.
 *
 * Pure presentation over state CodeSpacePage already owns — it never decides
 * editability itself (that stays `canEdit` in CodeSpacePage) and never writes.
 * Viewing a remote file can never become a direct default-branch write: the
 * GitHub copy here says so because the propose contract guarantees it
 * (githubEditApi.ts — always a new branch + PR).
 */
import type { ReactNode } from "react";
import { Button, Tooltip } from "../../components/primitives";
import { Icon } from "../../components/ui";

export type EditSource = "worktree" | "github" | "readonly";

export interface EditContextProps {
  source: EditSource;
  gitRef: string;
  /** local worktree branch name (GET …/worktree/branch), when known */
  branch?: string | null;
  editing: boolean;
  dirty: boolean;
  /** number of browser-local drafts for this project (GitHub flow) */
  draftCount: number;
  /** navigate back to HEAD from a pinned ref */
  onBackToHead?: () => void;
  /** interactive ref control (RefPicker) rendered in place of the ref label */
  refSlot?: ReactNode;
  /** left side of the file bar: the breadcrumb trail */
  lead?: ReactNode;
  /** right side of the file bar: file controls (Raw/Rendered, History, Edit) */
  actions?: ReactNode;
}

export function isPinnedRef(gitRef: string): boolean {
  return !!gitRef && gitRef !== "HEAD";
}

function shortRef(ref: string): string {
  return /^[0-9a-f]{12,40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/** The visible ref label ("main (HEAD)", "HEAD", "Pinned 0123456"). */
export function refLabelFor(source: EditSource, gitRef: string, branch?: string | null): string {
  if (isPinnedRef(gitRef)) return "Pinned " + shortRef(gitRef);
  return source === "worktree" && branch ? branch + " (HEAD)" : "HEAD";
}

/** The sentence describing where an edit goes — exported for tests. */
export function destinationText(p: Pick<EditContextProps, "source" | "gitRef">): string {
  if (isPinnedRef(p.gitRef)) {
    return "Historical version — read-only. Editing is only available at HEAD.";
  }
  if (p.source === "worktree") {
    return "Edits are saved straight to this file in the local working tree (autosave, Ctrl/Cmd+S). Commit and push from the Changes tab.";
  }
  if (p.source === "github") {
    return "Edits stay as a draft in this browser. Nothing is written to GitHub until you Propose, which opens a new branch and pull request — the default branch is never written directly.";
  }
  return "Read-only — editing isn't available for this project's code source.";
}

function stateText(p: EditContextProps): { label: string; tone: "neutral" | "warn" | "ok" } {
  if (!p.editing) {
    if (p.source === "github" && p.draftCount > 0) {
      return { label: p.draftCount + " draft" + (p.draftCount === 1 ? "" : "s") + " not proposed", tone: "warn" };
    }
    return { label: "Viewing", tone: "neutral" };
  }
  if (p.source === "worktree") {
    return p.dirty
      ? { label: "Unsaved changes — autosaving", tone: "warn" }
      : { label: "Saved to working tree", tone: "ok" };
  }
  return p.dirty
    ? { label: "Draft saved in this browser — not proposed", tone: "warn" }
    : { label: "No changes from base", tone: "neutral" };
}

const SOURCE_ICON: Record<EditSource, string> = { worktree: "code", github: "git", readonly: "eye" };

/**
 * ONE line — the code pane's file bar (Linear detail header, D5/D12):
 *
 *   [source icon] root / src / Shell.tsx …… [state] [⎇ ref ⌄] [ⓘ] | [file actions]
 *
 * The source is an icon + tooltip (its words stay in the accessible text);
 * the neutral "Viewing" state is announced but not painted (the Edit toggle
 * already says it — D12 "never show the same fact twice"); only a warn/ok
 * state (unsaved, saved, drafts) is shown. The destination sentence lives
 * behind the info affordance (and in the accessible text). `lead` carries the
 * breadcrumb trail and `actions` the file controls (Raw/Rendered, History,
 * Edit) so the pane has a single header row instead of two stacked strips.
 * `refSlot` lets the page mount the interactive RefPicker in place of the
 * static ref label.
 */
export function EditContext(props: EditContextProps) {
  const { source, gitRef, branch, onBackToHead, refSlot, lead, actions } = props;
  const pinned = isPinnedRef(gitRef);
  const sourceLabel = source === "worktree" ? "Local worktree" : source === "github" ? "GitHub · draft & propose" : "Read-only";
  const refLabel = refLabelFor(source, gitRef, branch);
  const st = stateText(props);
  const dest = destinationText({ source, gitRef });
  return (
    <div className="cs-ctx" role="group" aria-label="Edit context">
      <Tooltip label={sourceLabel} placement="bottom">
        <span className={"cs-ctx-source " + source}>
          <Icon name={SOURCE_ICON[source]} cls="v2-ico" />
          <span className="cs-ctx-source-label">{sourceLabel}</span>
        </span>
      </Tooltip>
      {lead ? <div className="cs-ctx-lead">{lead}</div> : <span className="cs-ctx-grow" />}
      <span className={"cs-ctx-state " + st.tone + (st.tone === "neutral" ? " v2-sr" : "")} aria-live="polite" title={st.tone !== "neutral" ? st.label : undefined}>
        {st.tone !== "neutral" ? <span className="cs-ctx-dot" aria-hidden="true" /> : null}
        <span className="cs-ctx-state-label">{st.label}</span>
      </span>
      {refSlot ?? (
        <span className={"cs-ctx-ref mono" + (pinned ? " pinned" : "")} title={pinned ? "Viewing " + gitRef : "Viewing the latest commit (HEAD)"}>
          {refLabel}
        </span>
      )}
      {pinned && onBackToHead ? (
        <Button size="sm" variant="ghost" pill icon="arrow-left" className="cs-ctx-back" onClick={onBackToHead}>
          Back to HEAD
        </Button>
      ) : null}
      <Tooltip label={dest} placement="bottom">
        <span className="cs-ctx-info" tabIndex={0} aria-label="Where edits go">
          <Icon name="info" cls="v2-ico" />
        </span>
      </Tooltip>
      {actions ? <div className="cs-ctx-actions">{actions}</div> : null}
      <span className="cs-ctx-dest v2-sr">{dest}</span>
    </div>
  );
}
