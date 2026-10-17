/**
 * V2 buttons — Linear-style (docs/orcha-v2-design-system.md §3.1).
 *
 *   size md = 28 px visual, sm = 24 px; 6 px radius; 13 px medium label;
 *   optional 14 px leading icon and trailing icon (e.g. "arrow" for "Open …").
 *   On coarse pointers the VISUAL size is unchanged: a transparent ::after
 *   expands the hit area to >= 44 px (no visual bloat).
 *
 * Variants
 *   primary   — accent fill, dark text (--v2-text-on-accent; white on #8D93F7
 *               is 2.75:1 and fails AA). ONLY the single dominant action of a view.
 *   secondary — subtle raised surface + 1 px subtle border (default).
 *   ghost     — no border, hover background.
 *   danger    — subtle: neutral surface, red text/icon, red-tinted hover.
 *               Never a solid red slab.
 *   link      — inline text action (accent text, no box) for "Expand full
 *               prompt" / "Retry" style affordances; still a real <button>.
 *   pill      — (prop) rounded-full shape, same metrics.
 *   approve   — DEPRECATED alias of primary (kept so older call sites compile;
 *               there are no solid green "Accept" slabs in V2).
 *
 * `ButtonLink` renders the same styles on an <a> (router `to` or plain `href`)
 * for navigational actions like "Open request →".
 */
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../ui";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link" | "approve";
export type ButtonSize = "sm" | "md";

/** Shared class builder so non-<button> elements (labels, links) can match. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string, opts?: { iconOnly?: boolean; pill?: boolean }): string {
  const v = variant === "approve" ? "primary" : variant;
  return `v2-btn v2-btn-${v} v2-btn-${size}${opts?.iconOnly ? " v2-btn-icononly" : ""}${opts?.pill ? " v2-btn-pill" : ""}${extra ? " " + extra : ""}`;
}

function Inner({ icon, iconRight, children }: { icon?: string; iconRight?: string; children?: ReactNode }) {
  return (
    <>
      {icon ? <Icon name={icon} cls="v2-ico v2-btn-ico" /> : null}
      {children != null && children !== false && children !== "" ? <span className="v2-btn-label">{children}</span> : null}
      {iconRight ? <Icon name={iconRight} cls="v2-ico v2-btn-ico v2-btn-ico-r" /> : null}
    </>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string; // leading Icon name from components/ui
  iconRight?: string; // trailing Icon name (e.g. "arrow", "chev")
  busy?: boolean; // in-flight: disabled + aria-busy, label kept
  /** rounded-full (Linear "Preview" / chip-like actions); default is the 6 px control radius */
  pill?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconRight, busy, pill, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={buttonClass(variant, size, className, { pill })}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      <Inner icon={icon} iconRight={iconRight}>{children}</Inner>
    </button>
  );
});

export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** SPA route (react-router Link) */
  to?: string;
  /** plain href (external, hash, or hard navigation) */
  href?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  iconRight?: string;
  pill?: boolean;
  children?: ReactNode;
}

/** A link that looks like a Button (navigation, not an action). */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { to, href, variant = "secondary", size = "md", icon, iconRight, pill, className, children, ...rest },
  ref,
) {
  const cls = buttonClass(variant, size, className, { pill });
  const inner = <Inner icon={icon} iconRight={iconRight}>{children}</Inner>;
  if (to != null) return <Link ref={ref} to={to} className={cls} {...rest}>{inner}</Link>;
  return <a ref={ref} href={href} className={cls} {...rest}>{inner}</a>;
});

/* IconButton lives in ./IconButton (circular Linear icon buttons); re-exported
   here so existing `import { IconButton } from "./Button"` call sites keep working. */
export { IconButton, iconButtonClass, type IconButtonProps, type IconButtonVariant } from "./IconButton";
