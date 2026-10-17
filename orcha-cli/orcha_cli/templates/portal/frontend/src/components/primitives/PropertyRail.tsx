/**
 * PropertyRail — Linear issue right rail (directive D10): muted labels and
 * compact values (status, priority, assignee, reviewer, labels, dependencies,
 * PR), grouped into titled sections with no boxes.
 *
 *   <PropertyRail label="Task properties">
 *     <PropertySection title="Properties">
 *       <Property label="Status"><StatusGlyph …/> In progress</Property>
 *       <Property label="Reviewer" empty="No reviewer" />
 *     </PropertySection>
 *     <PropertySection title="Labels"><Chip …/></PropertySection>
 *   </PropertyRail>
 *
 * A Property without children renders its `empty` text muted (default
 * "None") — pass an explicit `empty` that says WHY when it matters
 * ("Unavailable", "Not assigned"): missing ≠ unknown ≠ zero. Values may be
 * interactive (MenuButton, links); `layout="stack"` puts the label above the
 * value for long content (dependency lists).
 */
import type { ReactNode } from "react";

export function PropertyRail({ label, children, className }: { label: string; children?: ReactNode; className?: string }) {
  return (
    <aside className={`v2-rail${className ? " " + className : ""}`} aria-label={label}>
      {children}
    </aside>
  );
}

export function PropertySection({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={`v2-rail-sec${className ? " " + className : ""}`}>
      {title || actions ? (
        <div className="v2-rail-sec-h">
          {title ? <h3 className="v2-rail-sec-title">{title}</h3> : <span />}
          {actions ? <span className="v2-rail-sec-actions">{actions}</span> : null}
        </div>
      ) : null}
      <dl className="v2-rail-list">{children}</dl>
    </section>
  );
}

export interface PropertyProps {
  label: ReactNode;
  children?: ReactNode;
  /** Text shown (muted) when there is no value. */
  empty?: ReactNode;
  layout?: "row" | "stack";
  /** Tooltip / extra explanation on the label. */
  hint?: string;
  className?: string;
}

const isEmpty = (c: ReactNode): boolean => c == null || c === false || c === "" || (Array.isArray(c) && c.every(isEmpty));

export function Property({ label, children, empty = "None", layout = "row", hint, className }: PropertyProps) {
  const none = isEmpty(children);
  return (
    <div className={`v2-prop v2-prop-${layout}${className ? " " + className : ""}`}>
      <dt className="v2-prop-k" title={hint}>{label}</dt>
      <dd className={`v2-prop-v${none ? " is-empty" : ""}`}>{none ? empty : children}</dd>
    </div>
  );
}
