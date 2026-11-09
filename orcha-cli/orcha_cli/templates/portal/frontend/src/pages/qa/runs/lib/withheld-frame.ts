import type { Json } from "../types";

/**
 * A step frame the recorder withheld because a typed password could be on screen (#163,
 * `recording/withhold.py`). The stored image is a placeholder of the real size with the reason
 * written on it; the step's `args.frame_withheld` says so, so the replay can add a plain note
 * instead of leaving a reader to guess why the screen is blank.
 */
export const WITHHELD_FRAME_NOTE =
  "Screenshot withheld: a password was on screen. Frames resume once the run leaves that screen.";

export function isFrameWithheld(args: Json | undefined): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    (args as { frame_withheld?: Json }).frame_withheld === true
  );
}
