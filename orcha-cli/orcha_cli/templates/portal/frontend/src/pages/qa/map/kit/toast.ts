/** `toast({ title, description, variant })` on Orcha's toast. */
import { useMemo, type ReactNode } from "react";
import { useToast as useOrchaToast } from "../../../../components/ui";
import { nodeText } from "./select";

export type ToastVariant = "default" | "success" | "error";
export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  variant?: ToastVariant;
  duration?: number;
  actions?: { label: string; href?: string; onClick?: () => void }[];
}

export function useToast() {
  const orcha = useOrchaToast();
  return useMemo(() => ({
    toast: ({ title, description, variant = "default", duration, actions }: ToastOptions) => {
      const msg = [nodeText(title), description ? nodeText(description) : ""].filter(Boolean).join(" — ");
      const action = actions?.find((a) => a.onClick);
      orcha(msg, variant === "success" ? "ok" : variant === "error" ? "danger" : "", {
        sticky: variant === "error" || duration === 0,
        ...(duration ? { durationMs: duration } : {}),
        ...(action ? { action: { label: action.label, onClick: action.onClick! } } : {}),
      });
      return 0;
    },
    dismiss: (_id: number) => {},
  }), [orcha]);
}
