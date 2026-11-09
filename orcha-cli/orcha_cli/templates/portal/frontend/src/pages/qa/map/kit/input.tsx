import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "./cn";
import { Select } from "./select";

/* Linear text field (Orcha V2 controls): 1px control outline, 6px radius, transparent fill;
   hover strengthens the outline; focus is the ONE global 2px ring (no accent border on top). */
export const inputClass =
  "h-7 w-full rounded-md border border-border-strong bg-transparent px-2.5 text-base text-fg transition-colors duration-[90ms] placeholder:text-muted hover:border-muted/60 focus-visible:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger";

/** Heights: sm 24px · md 28px (default, `inputClass`) · lg 32px (Orcha `--v2-control-h`). */
export const inputSizes = {
  sm: "h-6 px-2 text-sm",
  md: "",
  lg: "h-8 px-3",
} as const;

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; dimension?: keyof typeof inputSizes }
>(function Input({ className, mono = false, dimension = "md", ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cn(inputClass, inputSizes[dimension], mono && "font-mono text-sm", className)}
      {...rest}
    />
  );
});

export function Label({
  className,
  ...rest
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-sm font-medium leading-4 text-fg", className)}
      {...rest}
    />
  );
}

/** A child a `<label for>` can name: a native form control, or one of our own controls that
 * forwards `id` to one (Input to its `<input>`, Select to its combobox button). */
function isLabelable(node: ReactNode): node is ReactElement<{ id?: string }> {
  if (!isValidElement<{ id?: string; type?: string }>(node)) return false;
  if (node.type === Input || node.type === Select) return true;
  if (node.type === "select" || node.type === "textarea") return true;
  return node.type === "input" && node.props.type !== "hidden";
}

/** Label + control + optional hint/error stacked with tight spacing.
 *
 * The label is always tied to its control so a screen reader names it: an explicit `htmlFor`
 * wins; otherwise the one form control among the children is named, keeping its own `id` or
 * getting a generated one. A Field around something else (a picker, a radio group, a code
 * block) names its contents as a group instead, since no single control could take the
 * label. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const autoId = useId();
  const labelId = `${autoId}-label`;
  let controlId = htmlFor;
  let control = children;
  if (controlId === undefined) {
    const nodes = Children.toArray(children);
    const controls = nodes.filter(isLabelable);
    const only = controls.length === 1 ? controls[0] : null;
    if (only) {
      controlId = only.props.id ?? `${autoId}-control`;
      const target = only.props.id ? only : cloneElement(only, { id: controlId });
      control = nodes.map((n) => (n === only ? target : n));
    }
  }
  const grouped = controlId === undefined;
  return (
    <div
      className={cn("flex flex-col gap-1.5", className)}
      role={grouped ? "group" : undefined}
      aria-labelledby={grouped ? labelId : undefined}
    >
      <Label id={labelId} htmlFor={controlId}>{label}</Label>
      {control}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
