import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "../../map/kit";

/** Dense data table. Wraps in a horizontally scrollable container. */
export function Table({
  className,
  wrapperClassName,
  ...rest
}: TableHTMLAttributes<HTMLTableElement> & { wrapperClassName?: string }) {
  return (
    <div className={cn("w-full overflow-x-auto", wrapperClassName)}>
      <table
        className={cn(
          "w-full border-collapse text-left text-base [&_th]:whitespace-nowrap",
          className,
        )}
        {...rest}
      />
    </div>
  );
}

export function THead({
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("text-muted", className)} {...rest} />;
}

export function TBody({
  className,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...rest} />;
}

export function TR({
  className,
  interactive = false,
  selected = false,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & {
  /** Hover highlight (for rows that link somewhere). */
  interactive?: boolean;
  selected?: boolean;
}) {
  return (
    <tr
      className={cn(
        // Linear rows: no row borders, translucent hover / selected.
        interactive && "cursor-pointer transition-colors hover:bg-hover",
        selected && "bg-selected",
        className,
      )}
      aria-selected={selected || undefined}
      {...rest}
    />
  );
}

export function TH({
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        "h-8 border-b border-border px-3 text-sm font-medium text-muted first:pl-4 last:pr-4",
        className,
      )}
      {...rest}
    />
  );
}

export function TD({
  className,
  mono = false,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { mono?: boolean }) {
  return (
    <td
      className={cn(
        "h-9 select-text px-3 align-middle first:pl-4 last:pr-4",
        mono && "font-mono text-sm tabular text-muted",
        className,
      )}
      {...rest}
    />
  );
}
