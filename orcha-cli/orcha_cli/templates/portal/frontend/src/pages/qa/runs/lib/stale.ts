/** The "no activity" banner's tone: nothing under 2 minutes, a warning from 2, danger from 5. */
export function staleBannerTone(minutes: number | null | undefined): "warning" | "danger" | null {
  if (minutes == null || minutes < 2) return null;
  return minutes >= 5 ? "danger" : "warning";
}
