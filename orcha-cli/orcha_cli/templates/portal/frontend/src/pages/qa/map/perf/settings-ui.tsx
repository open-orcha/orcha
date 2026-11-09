/**
 * The settings building blocks the speed budgets use: a group (title, one short line, a calm
 * bordered box) and a row in it (label and description left, the control right).
 */
import type { ReactNode } from "react";
import { HelpCircle } from "../kit/icons";
import { cn } from "../kit";

/** A "?" beside a group title: the longer explanation, as a native tooltip (hover + focus). */
export function HelpTip({ label, children }: { label: string; children: string }) {
  return (
    <span
      tabIndex={0}
      role="img"
      aria-label={`About ${label}: ${children}`}
      title={children}
      className="inline-flex cursor-help text-muted hover:text-fg focus-visible:text-fg"
    >
      <HelpCircle className="size-3.5" aria-hidden />
    </span>
  );
}

export function SettingsGroup({
  title,
  lead,
  help,
  action,
  children,
  flush,
  id,
  className,
}: {
  title?: ReactNode;
  /** ONE short line under the title; longer explanations go in `help`. */
  lead?: ReactNode;
  /** tooltip text behind a "?" beside the title */
  help?: string;
  action?: ReactNode;
  children: ReactNode;
  /** rows fill the box edge to edge (SettingRow lists) */
  flush?: boolean;
  id?: string;
  className?: string;
}) {
  return (
    <section id={id} className={cn("mb-8", className)} data-settings-group>
      {title || lead || action ? (
        <div className="mb-2.5 flex items-end justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                {title}
                {help ? <HelpTip label={typeof title === "string" ? title : "this setting"}>{help}</HelpTip> : null}
              </h2>
            ) : null}
            {lead ? <p className="mt-0.5 text-xs text-muted">{lead}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className={cn("rounded-lg border border-border bg-panel", flush ? "divide-y divide-border" : "p-4")}>{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** the control or value, right-aligned */
  children?: ReactNode;
  /** id of the control, so the label is clickable */
  htmlFor?: string;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  // At phone width the row wraps: a label with a long description takes the full line and
  // the control drops under it, instead of the control squeezing the text to a word a line.
  return (
    <div className={cn("flex min-h-12 items-center justify-between gap-4 px-4 py-2.5 max-sm:flex-wrap max-sm:gap-y-2", className)} data-setting-row>
      <Label {...(htmlFor ? { htmlFor } : {})} className="min-w-0">
        <div className="text-sm text-fg">{label}</div>
        {description ? <div className="mt-0.5 text-xs text-muted">{description}</div> : null}
      </Label>
      {children !== undefined ? <div className="flex shrink-0 items-center gap-2 text-sm text-fg-2">{children}</div> : null}
    </div>
  );
}

