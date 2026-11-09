/**
 * The QA screens' button: Orcha's `Button` primitive with the props those screens pass (icons as
 * children, `loading`, `icon` for a square icon-only button).
 */
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Button as OrchaButton, buttonClass } from "../../../../components/primitives";

export type ButtonVariant = "default" | "secondary" | "primary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const orchaVariant = (v: ButtonVariant) => (v === "default" ? "secondary" : v);
const orchaSize = (s: ButtonSize) => (s === "sm" ? "sm" : "md");

/** Class list for a button, usable on a link too. */
export function buttonVariants({ variant = "default", size = "md", icon = false, className }: { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean; className?: string } = {}): string {
  return buttonClass(orchaVariant(variant), orchaSize(size), className, { iconOnly: icon, pill: icon });
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square icon-only button; pass `aria-label`. */
  icon?: boolean;
  /** Shows the busy state and disables the button. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "default", size = "md", icon = false, loading = false, className, children, ...rest }, ref) {
  return (
    <OrchaButton ref={ref} variant={orchaVariant(variant)} size={orchaSize(size)} busy={loading} pill={icon} className={[icon ? "v2-btn-icononly" : "", className].filter(Boolean).join(" ") || undefined} {...rest}>
      {children}
    </OrchaButton>
  );
});
