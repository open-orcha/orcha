/** Tests only: what the map's parts read from the page, the router and who may start work. */
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { MapActionsProvider, type MapActions } from "./map-actions";

export function withPage(child: ReactNode, actions: Partial<MapActions> = {}, path = "/qa?view=map") {
  const value: MapActions = { platform: "ios", run: () => {}, can: true, reason: null, ...actions };
  return (
    <MemoryRouter initialEntries={[path]}>
      <MapActionsProvider value={value}>{child}</MapActionsProvider>
    </MemoryRouter>
  );
}
