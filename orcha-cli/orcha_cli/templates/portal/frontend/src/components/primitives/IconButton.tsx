/**
 * IconButton — Linear-style icon-only action (design-system §3.1, directive D5).
 *
 *   Circular by default: 28 px (md) / 24 px (sm) visual, 16 / 14 px glyph.
 *   Coarse pointers keep the visual size; ::after grows the hit area to 44 px.
 *
 * Variants
 *   ghost     (default) borderless, round hover background — header utility icons.
 *   outline   1 px subtle border on transparent — the Linear toolbar circles
 *             (filter · display options · view toggle, detail-view actions).
 *   secondary alias of outline with the raised control fill (standalone toolbars).
 *   solid     light filled circle, dark glyph — the composer "send" button.
 *   danger    red glyph, red-tinted hover.
 *
 * `shape="square"` keeps the legacy 6 px radius (dense inline tools, editors).
 * `label` is REQUIRED: it is the aria-label AND the tooltip — icons are never
 * unlabeled. `pressed` renders aria-pressed for toggles (e.g. board/list).
 * `glyph` accepts a custom ReactNode (an <svg>) instead of an Icon name.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon } from "../ui";

export type IconButtonVariant = "ghost" | "outline" | "secondary" | "solid" | "danger";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Icon name from components/ui (ignored when `glyph` is given). */
  icon?: string;
  /** Custom glyph (inline <svg>) — for icons not in the shared set. */
  glyph?: ReactNode;
  /** Required accessible name; also the tooltip unless `title` overrides it. */
  label: string;
  size?: "sm" | "md";
  shape?: "circle" | "square";
  variant?: IconButtonVariant;
  pressed?: boolean;
  badge?: ReactNode;
  busy?: boolean;
}

export function iconButtonClass(
  { size = "md", shape = "circle", variant = "ghost" }: { size?: "sm" | "md"; shape?: "circle" | "square"; variant?: IconButtonVariant } = {},
  extra?: string,
): string {
  return (
    `v2-iconbtn v2-iconbtn-${size}` +
    (shape === "circle" ? " v2-iconbtn-circle" : "") +
    (variant !== "ghost" ? ` v2-iconbtn-${variant}` : "") +
    (extra ? " " + extra : "")
  );
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, glyph, label, size = "md", shape = "circle", variant = "ghost", pressed, badge, busy, className, type, title, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={iconButtonClass({ size, shape, variant }, className)}
      {...rest}
    >
      {glyph ?? (icon ? <Icon name={icon} cls="v2-ico" /> : null)}
      {badge != null && badge !== "" && badge !== 0 && badge !== false ? <span className="v2-iconbtn-badge">{badge}</span> : null}
    </button>
  );
});
