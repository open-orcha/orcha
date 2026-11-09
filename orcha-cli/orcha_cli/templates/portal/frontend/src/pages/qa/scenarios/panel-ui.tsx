/**
 * Building blocks of the scenario side sheet (a Linear "properties" sheet, as the task
 * inspector): sections with a `text-sm font-semibold` header, an optional "?" tooltip and
 * trailing action, at most ONE muted line, hairline dividers between sections; and
 * label/value property rows with compact controls.
 */
import type { ReactNode } from "react";
import { HelpCircle } from "../map/kit/icons";
import { cn } from "../map/kit";

/** A "?" that shows `children` on hover or focus. */
export function HelpTip({ label, children }: { label: string; children: string }) {
  return (
    <span tabIndex={0} role="img" aria-label={`About ${label}: ${children}`} title={children} className="inline-flex cursor-help text-muted hover:text-fg focus-visible:text-fg">
      <HelpCircle className="size-3.5" aria-hidden />
    </span>
  );
}

export function PanelSection({
  title,
  help,
  lead,
  action,
  children,
  className,
  ...rest
}: {
  title: ReactNode;
  /** Longer explanation, behind a "?" beside the title. */
  help?: string;
  /** ONE short muted line under the title. */
  lead?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <section className={cn("flex flex-col gap-2.5 border-t border-border px-4 py-3.5", className)} {...rest}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            {title}
            {help ? <HelpTip label={typeof title === "string" ? title : "this section"}>{help}</HelpTip> : null}
          </h3>
          {lead ? <p className="mt-0.5 truncate text-xs text-muted">{lead}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** One label/value row: muted label on the left (fixed width), the control on the right. */
export function PropRow({
  label,
  htmlFor,
  help,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  help?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-8 items-start gap-3", className)}>
      <div className="flex h-7 w-[104px] shrink-0 items-center gap-1 text-sm text-muted">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="truncate">
            {label}
          </label>
        ) : (
          <span className="truncate">{label}</span>
        )}
        {help ? <HelpTip label={typeof label === "string" ? label : "this field"}>{help}</HelpTip> : null}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
    </div>
  );
}

/** Inline error under a field: the danger tone only on the short text, never a red box. */
export function FieldError({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, boolean | string | undefined>) {
  return (
    <p className="text-xs text-danger" {...rest}>
      {children}
    </p>
  );
}

/** Compact multiline input shared by the sheet's textareas. */
export const textareaClass =
  "w-full resize-y rounded-md border border-border-strong bg-transparent px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-muted hover:border-muted/60 focus-visible:border-accent aria-invalid:border-danger";
