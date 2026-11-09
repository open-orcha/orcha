import { useState } from "react";
import { Button } from "../map/kit";
import { useToast } from "../map/kit";
import { errText } from "../parts";
import { useScenarios } from "./context";
import { releaseQuarantine } from "./api";
import type { QaScenario } from "../qaApi";

/** "Release now": takes a scenario out of flaky quarantine, so its failures fail a check run again. */
export function ReleaseQuarantineButton({
  scenarioId,
  onReleased,
  size = "sm",
}: {
  scenarioId: string;
  onReleased?: (scenario: QaScenario) => void;
  size?: "sm" | "md";
}) {
  const { toast } = useToast();
  const { auth } = useScenarios();
  const [busy, setBusy] = useState(false);

  async function release() {
    setBusy(true);
    try {
      const row = await releaseQuarantine(scenarioId, auth.human?.id ?? null);
      toast({ title: "Released from quarantine", description: "Its failures fail a check run again." });
      onReleased?.(row);
    } catch (err) {
      toast({ title: "Could not release the scenario", description: errText(err), variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button size={size} onClick={release} disabled={busy || !auth.can} data-release-quarantine={scenarioId}>
      {busy ? "Releasing…" : "Release now"}
    </Button>
  );
}
