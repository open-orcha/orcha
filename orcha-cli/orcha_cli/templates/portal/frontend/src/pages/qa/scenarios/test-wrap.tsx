/** Tests only: what the scenario screens read from the page. */
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { ScenariosProvider, type ScenariosContext } from "./context";

export function withScenarios(child: ReactElement, over: Partial<ScenariosContext> = {}) {
  const value: ScenariosContext = { cid: "c1", auth: { can: true, human: { id: "h1" } as never, reason: "" } as never, platform: "ios", runQa: () => {}, ...over };
  return (
    <MemoryRouter>
      <ScenariosProvider value={value}>{child}</ScenariosProvider>
    </MemoryRouter>
  );
}
