/** parity r1: SG-06 (paused project) and the run/task statuses that rendered
 *  the grey "unknown" glyph (rate_limited, orphaned, not_ready, killed). */
import { describe, expect, it } from "vitest";
import { statusColor, statusShape } from "./StatusIcon";

describe("StatusIcon shapes for statuses that used to fall through to unknown", () => {
  it.each([
    ["paused", "paused", "warn"],
    ["rate_limited", "paused", "warn"],
    ["not_ready", "dashed", "todo"],
    ["orphaned", "stopped", "muted"],
    ["killed", "cancelled", "muted"],
  ])("%s → %s / %s", (status, shape, color) => {
    expect(statusShape(status)).toBe(shape);
    expect(statusColor(status)).toBe(color);
  });
  it("a human-stopped run is not drawn as a failure", () => {
    expect(statusShape("killed")).not.toBe(statusShape("failed"));
  });
});
