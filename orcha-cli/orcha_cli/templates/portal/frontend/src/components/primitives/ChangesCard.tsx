/**
 * ChangesCard — Linear "Changed 2 files +22 −10 · Draft Reset rows ·
 * master ← branch" card (directive D9). Render it ONLY from real data: every
 * field is optional and a missing field is omitted, never shown as 0. With
 * nothing to show the component renders null.
 *
 *   <ChangesCard files={2} additions={22} deletions={10}
 *     pr={{ number: 55, title: "Reset dimmed rows", state: "draft", href: pr.url }}
 *     base="main" branch="orcha/t-364-reset-rows"
 *     action={<Button size="sm" variant="ghost" icon="eye" onClick={openDiff}>Preview</Button>} />
 */
import type { ReactNode } from "react";
import type { PrState } from "./Chip";

export interface ChangesCardProps {
  files?: number | null;
  additions?: number | null;
  deletions?: number | null;
  pr?: { number?: number | null; title?: ReactNode; state?: PrState | null; href?: string | null } | null;
  base?: string | null;
  branch?: string | null;
  /** Top-right action (e.g. "Preview" diff button). */
  action?: ReactNode;
  className?: string;
}

const PR_WORD: Record<PrState, string> = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" };

function PrGlyph({ state }: { state?: PrState | null }) {
  return (
    <svg className={`v2-ico v2-pr-glyph v2-pr-${state ?? "open"}`} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5.5" cy="4.8" r="1.8" />
      <circle cx="5.5" cy="15.2" r="1.8" />
      <circle cx="14.5" cy="15.2" r="1.8" />
      <path d="M5.5 6.6v6.8M14.5 13.4V8.5a2.5 2.5 0 0 0-2.5-2.5H9.5M11 4.3 9.3 6 11 7.7" />
    </svg>
  );
}

const num = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export function ChangesCard({ files, additions, deletions, pr, base, branch, action, className }: ChangesCardProps) {
  const hasStats = num(files) || num(additions) || num(deletions);
  const hasPr = !!pr && (pr.title != null || num(pr.number));
  if (!hasStats && !hasPr && !branch) return null;
  const prLabel = pr ? [pr.state ? PR_WORD[pr.state] : null, num(pr.number) ? `#${pr.number}` : null].filter(Boolean).join(" ") : "";
  const prBody = pr ? (
    <>
      <PrGlyph state={pr.state} />
      {prLabel ? <span className="v2-changes-prstate">{prLabel}</span> : null}
      {pr.title != null ? <span className="v2-changes-prtitle">{pr.title}</span> : null}
    </>
  ) : null;
  return (
    <section className={`v2-changes${className ? " " + className : ""}`} aria-label="Code changes">
      {hasStats || action ? (
        <div className="v2-changes-h">
          <span className="v2-changes-stats">
            {hasStats ? <b>Changed</b> : null}
            {num(files) ? <span>{files} {files === 1 ? "file" : "files"}</span> : null}
            {num(additions) ? <span className="v2-changes-add" aria-label={`${additions} lines added`}>+{additions}</span> : null}
            {num(deletions) ? <span className="v2-changes-del" aria-label={`${deletions} lines removed`}>−{deletions}</span> : null}
          </span>
          {action ? <span className="v2-changes-action">{action}</span> : null}
        </div>
      ) : null}
      {hasPr ? (
        pr?.href ? (
          <a className="v2-changes-pr" href={pr.href} target="_blank" rel="noreferrer">{prBody}</a>
        ) : (
          <div className="v2-changes-pr">{prBody}</div>
        )
      ) : null}
      {branch ? (
        <div className="v2-changes-branch" title={base ? `${branch} → ${base}` : branch}>
          {base ? <><span>{base}</span><span aria-label="from" className="v2-changes-arrow">←</span></> : null}
          <span>{branch}</span>
        </div>
      ) : null}
    </section>
  );
}
