/**
 * What the map does in Orcha that is not on the map: starting agent work (the Run check dialog) and
 * the addresses of a scenario or a session. The map's parts read it from context, so the view
 * stays free of the page's navigation. Starting work is human-only and stays gated here: without
 * authority a control is disabled with the reason.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Tooltip } from "../../../components/primitives";
import { qaHref } from "../parts";
import type { Platform } from "../qaApi";
import type { QaRunKind } from "../runQa";
import { Button, type ButtonProps } from "./kit";

export interface MapActions {
  platform: Platform;
  /** Opens the Run check dialog preset to `kind`, on `focus` when given. */
  run: (kind: QaRunKind, focus?: string | null) => void;
  can: boolean;
  reason: string | null;
}

const NOBODY: MapActions = { platform: "ios", run: () => {}, can: false, reason: null };
const Ctx = createContext<MapActions>(NOBODY);

export function MapActionsProvider({ value, children }: { value: MapActions; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMapActions(): MapActions {
  return useContext(Ctx);
}

/** The page's links: a scenario, a session, Coverage and Slowest screens. */
export function useMapHrefs() {
  const { platform } = useMapActions();
  return useMemo(() => ({
    scenario: (id: string) => qaHref({ view: "scenarios", platform, scenario: id }),
    session: (id: string) => qaHref({ view: "sessions", platform, session: id }),
    coverage: () => qaHref({ view: "scenarios", platform, sub: "coverage" }),
    slowest: () => qaHref({ view: "map", platform, sub: "slowest" }),
  }), [platform]);
}

/** A button that starts agent work: disabled with the reason for anyone who may not. */
export function RunAction({ kind, focus = null, onClick, ...rest }: { kind: QaRunKind; focus?: string | null } & ButtonProps) {
  const { run, can, reason } = useMapActions();
  const btn = <Button {...rest} disabled={!can || rest.disabled} onClick={(e) => { onClick?.(e); if (focus) run(kind, focus); else run(kind); }} />;
  return can ? btn : <Tooltip label={reason || "Only a person can start QA work"} placement="bottom">{btn}</Tooltip>;
}
