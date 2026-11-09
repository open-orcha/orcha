import { Tooltip } from "../../../components/primitives";
import { Button, cn, Link } from "../map/kit";
import { Loader2, RefreshCw } from "../map/kit/icons";
import styles from "./atlas.module.css";
import { AtlasEmptyScene } from "./empty-scene";
import type { AtlasRefresh } from "./types";

/** "Refresh atlas"; `asks`: it opens the device dialog first; `reason`: why this person cannot start one. */
export function RefreshButton({
  refresh,
  onClick,
  busy = false,
  asks = true,
  can = true,
  reason = null,
  size = "md",
  label = "Refresh atlas",
}: {
  refresh: AtlasRefresh;
  onClick: () => void;
  busy?: boolean;
  /** It opens the device dialog first. */
  asks?: boolean;
  can?: boolean;
  reason?: string | null;
  size?: "md" | "lg";
  label?: string;
}) {
  const running = refresh.state === "running";
  const button = (
    <Button
      size={size}
      onClick={onClick}
      disabled={busy || running || !can}
      aria-busy={busy || running || undefined}
      aria-haspopup={asks ? "dialog" : undefined}
      title={can ? `Runs the high-level map pass: one look at the entry screen and each main area, about ${refresh.minutes} minutes` : undefined}
      data-atlas-refresh
    >
      {busy || running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      {running ? "Filling in" : label}
    </Button>
  );
  return can ? button : <Tooltip label={reason || "Only a person can start QA work"} placement="bottom">{button}</Tooltip>;
}

/**
 * No screens yet: the atlas shown working (`AtlasEmptyScene`: screens flying from the app's areas
 * into a storyboard, platforms side by side, badges, then the flow), what it is in four steps lit
 * in time with it, and the map pass that starts it. Reduced motion: the finished storyboard, still.
 */
export function AtlasEmpty({ refresh, onRefresh, asks, busy, can, reason, mapHref }: { refresh: AtlasRefresh; onRefresh: () => void; asks?: boolean; busy?: boolean; can?: boolean; reason?: string | null; mapHref: string }) {
  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto px-4 py-6 md:items-center md:px-6">
      <AtlasEmptyScene
        className={cn(styles.emptyStage, "w-full max-w-[1120px] p-6 md:p-10")}
        intro={
          <>
            <h2 className="text-xl font-semibold text-fg">See every screen at a glance</h2>
            <p className="mt-2 max-w-md text-base text-fg-2">
              The atlas is a storyboard of the app, built from the screenshots Embodent already takes. It fills in by itself as mapping runs, explorations and checks see screens.
            </p>
          </>
        }
        actions={
          <div data-atlas-empty>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <RefreshButton refresh={refresh} onClick={onRefresh} asks={asks} busy={busy} can={can} reason={reason} size="lg" label="Map the main screens" />
              <Link href={mapHref} className="text-sm text-muted hover:text-fg hover:underline">
                Open the App map
              </Link>
            </div>
            <p className="mt-2 text-xs text-muted">One look at the entry screen and each main area, about {refresh.minutes} minutes on a device. Nothing deeper.</p>
          </div>
        }
      />
    </div>
  );
}
