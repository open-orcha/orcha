/**
 * Ref picker (V2 screen review: "HEAD chip → branch/tag/SHA menu updating
 * ?ref="). The compact button shows the ref being viewed; its popover lets a
 * human jump back to HEAD, reopen a recently viewed ref, type any branch /
 * tag / commit SHA, or (local worktree) open this file's commit history.
 *
 * There is no branch-listing endpoint, so the picker never invents a branch
 * list: it offers what it can honestly know (HEAD, refs this browser viewed
 * for this project, free-form entry) — an unknown ref simply lands on the
 * file pane's normal "not found" state.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Popover } from "../../components/primitives";
import { Icon } from "../../components/ui";

const KEY = (cid: string) => "orcha:cs:recentRefs:" + cid;
const MAX_RECENT = 5;

export function loadRecentRefs(cid: string): string[] {
  try {
    const raw = localStorage.getItem(KEY(cid));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "HEAD").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function recordRecentRef(cid: string, ref: string): void {
  if (!ref || ref === "HEAD") return;
  try {
    const next = [ref, ...loadRecentRefs(cid).filter((r) => r !== ref)].slice(0, MAX_RECENT);
    localStorage.setItem(KEY(cid), JSON.stringify(next));
  } catch {
    /* private mode — the picker still works, just without memory */
  }
}

export function shortRefLabel(ref: string): string {
  return /^[0-9a-f]{12,40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

export interface RefPickerProps {
  cid: string;
  gitRef: string;
  /** visible label for the current ref (e.g. "main (HEAD)" / "Pinned 0123456") */
  label: string;
  onPick: (ref: string) => void;
  /** local worktree only: opens the file's commit history */
  onOpenHistory?: () => void;
}

export function RefPicker({ cid, gitRef, label, onPick, onOpenHistory }: RefPickerProps) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const pinned = gitRef !== "HEAD";

  useEffect(() => { recordRecentRef(cid, gitRef); }, [cid, gitRef]);
  useEffect(() => { if (open) { setRecent(loadRecentRefs(cid)); setDraft(""); } }, [open, cid]);

  const pick = (ref: string) => {
    setOpen(false);
    if (ref && ref !== gitRef) onPick(ref);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    if (v) pick(v);
  };

  return (
    <>
      <Button
        ref={anchor}
        size="sm"
        variant="ghost"
        className={"cs-refpicker-btn mono" + (pinned ? " pinned" : "")}
        icon="git"
        iconRight="chev"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={pinned ? "Viewing " + gitRef + " (read-only) — change ref" : "Viewing " + label + " — the latest commit — change ref"}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} role="dialog" label="Switch ref" className="cs-refpicker">
        <form className="cs-refpicker-form" onSubmit={submit}>
          <input
            className="cs-refpicker-in mono"
            aria-label="Branch, tag or commit SHA"
            placeholder="Branch, tag or commit SHA"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim()}>Go</Button>
        </form>
        <div className="cs-refpicker-list">
          <button type="button" className={"cs-refpicker-row" + (!pinned ? " on" : "")} onClick={() => pick("HEAD")}>
            <Icon name="git" cls="v2-ico" />
            <span className="cs-refpicker-name mono">HEAD</span>
            <span className="cs-refpicker-hint">latest</span>
            {!pinned ? <Icon name="check" cls="v2-ico cs-refpicker-check" /> : null}
          </button>
          {recent.length ? <div className="cs-refpicker-group">Recently viewed</div> : null}
          {recent.map((r) => (
            <button key={r} type="button" className={"cs-refpicker-row" + (r === gitRef ? " on" : "")} onClick={() => pick(r)} title={r}>
              <Icon name="clock" cls="v2-ico" />
              <span className="cs-refpicker-name mono">{shortRefLabel(r)}</span>
              {r === gitRef ? <Icon name="check" cls="v2-ico cs-refpicker-check" /> : null}
            </button>
          ))}
          {onOpenHistory ? (
            <button type="button" className="cs-refpicker-row" onClick={() => { setOpen(false); onOpenHistory(); }}>
              <Icon name="clock" cls="v2-ico" />
              <span className="cs-refpicker-name">This file's commit history…</span>
            </button>
          ) : null}
        </div>
        <p className="cs-refpicker-note">
          {pinned ? "Other refs are read-only. Editing is only available at HEAD." : "Viewing another ref is read-only; editing stays on HEAD."}
        </p>
      </Popover>
    </>
  );
}
