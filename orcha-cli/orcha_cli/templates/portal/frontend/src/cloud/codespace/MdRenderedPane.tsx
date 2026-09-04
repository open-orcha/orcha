/**
 * Item 2 — thread conversations on rendered markdown. Rendered mode
 * previously disabled anchoring entirely ("switch to Raw to anchor a
 * thread"); this wraps the house Md renderer with two anchor affordances
 * that DON'T touch Md/mdText (a shared component also used by ThreadView/
 * Conversation):
 *
 *  - a "Discuss this document" button in the content header (rendered by
 *    CodeSpacePage, not here — see headerExtra) opens the composer with a
 *    FILE-LEVEL anchor (start_line=1, end_line=1, wholeDocument=true).
 *  - each rendered heading (mdText's flat `<span class="md-h">`, no id/line
 *    info) gets a hover affordance that anchors to that heading's SOURCE
 *    line, resolved by mdHeadingAnchor.ts against the raw content Code Space
 *    already has fetched. On ambiguity (see that module's doc) it falls back
 *    to the file-level anchor with a tooltip explaining why, rather than
 *    guessing wrong.
 *
 * Headings are matched by event delegation (one click handler on the
 * wrapper, `closest(".md-h")`) rather than post-processing the
 * dangerouslySetInnerHTML DOM — mdText's markup/class names stay untouched,
 * and every `.md-h` span is addressed purely by its DOM-order index among
 * its siblings, computed at click time (cheap: rendered docs are short).
 */
import { useRef } from "react";
import { Md } from "../../components/ui";
import { resolveHeadingLine } from "./mdHeadingAnchor";

export interface MdRenderedPaneProps {
  content: string;
  onDiscussHeading: (line: number) => void;
  onAmbiguousHeading: () => void;
}

export function MdRenderedPane({ content, onDiscussHeading, onAmbiguousHeading }: MdRenderedPaneProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const heading = target.closest(".md-h");
    const wrap = wrapRef.current;
    if (!heading || !wrap) return;
    const all = Array.from(wrap.querySelectorAll(".md-h"));
    const domIndex = all.indexOf(heading);
    const resolution = resolveHeadingLine(content, domIndex, heading.textContent || "");
    if (resolution.resolved) {
      onDiscussHeading(resolution.line);
    } else {
      onAmbiguousHeading();
    }
  };

  return (
    <div
      ref={wrapRef}
      className="cs-md-rendered cs-md-rendered-anchorable"
      onClick={onClick}
    >
      <Md text={content} className="tx cs-md-body" />
    </div>
  );
}
