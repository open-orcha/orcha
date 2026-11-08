/** What the scenario screens share: the project, who may decide, and the Run check dialog. */
import type { Conditions } from "../conditions/conditions";
import { cloneElement, createContext, useContext, type ReactElement, type ReactNode } from "react";
import { Tooltip } from "../../../components/primitives";
import type { QaAuthority } from "../authority";
import type { Platform } from "../qaApi";
import type { QaRunKind } from "../runQa";

export interface ScenariosContext {
  cid: string;
  auth: QaAuthority;
  platform: Platform;
  runQa: (kind?: QaRunKind, focus?: string | null, options?: { scenarioIds?: string[]; platform?: Platform | null; conditions?: Conditions | null; askConditions?: boolean }) => void;
}

const Ctx = createContext<ScenariosContext | null>(null);

export function ScenariosProvider({ value, children }: { value: ScenariosContext; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScenarios(): ScenariosContext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useScenarios outside ScenariosProvider");
  return v;
}

/** The project, where a part is also drawn outside the page (a test of the map alone). */
export function useProjectId(): string | null {
  return useContext(Ctx)?.cid ?? null;
}

/** The server decides who may act; this mirrors it. Anyone who cannot sees the control disabled,
 * with the reason on hover. */
export function HumanGate({ children, placement = "top" }: { children: ReactElement<{ disabled?: boolean }>; placement?: "top" | "bottom" | "left" | "right" }) {
  const { auth } = useScenarios();
  if (auth.can) return children;
  return <Tooltip label={auth.reason || "Only a person can decide"} placement={placement}>{cloneElement(children, { disabled: true })}</Tooltip>;
}
