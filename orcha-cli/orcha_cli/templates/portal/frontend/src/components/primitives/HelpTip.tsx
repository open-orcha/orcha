/**
 * HelpTip — the quiet "?" that carries an explanation a line of copy used to
 * (D12: boilerplate out of the layout, into a tooltip). One shared primitive
 * replaces the per-page copies (Overview, Onboarding, Settings, Code Space).
 * A real focusable button so the tooltip opens on hover AND keyboard focus;
 * its accessible name is `label`, else the tooltip text itself.
 */
import type { ReactNode } from "react";
import { Icon } from "../ui";
import { Tooltip, type TooltipPlacement } from "./Tooltip";

export interface HelpTipProps {
  /** tooltip content */
  tip: ReactNode;
  /** accessible name (default: the tip when it is a string) */
  label?: string;
  placement?: TooltipPlacement;
  className?: string;
}

export function HelpTip({ tip, label, placement = "top", className }: HelpTipProps) {
  const name = label ?? (typeof tip === "string" ? tip : "More information");
  return (
    <Tooltip label={tip} placement={placement}>
      <button type="button" className={"v2-help" + (className ? " " + className : "")} aria-label={name}>
        <Icon name="help" cls="v2-ico" />
      </button>
    </Tooltip>
  );
}
