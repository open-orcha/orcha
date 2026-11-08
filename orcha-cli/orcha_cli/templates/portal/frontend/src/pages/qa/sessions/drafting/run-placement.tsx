import type { HTMLAttributes } from "react";
import { PLATFORM_LABELS, PlatformIcon, cn, type TargetKind } from "../../map/kit";

/** Where a run runs, as every line of the drafting page says it. */
export interface Placement {
  kind: TargetKind;
  /** The device's name, or what the platform runs on by default. */
  device: string;
  isDefault: boolean;
  platform: string;
}

const DEFAULT_DEVICE: Record<string, string> = { ios: "iOS Simulator", android: "Android emulator", web: "Chromium", desktop: "This Mac" };

export function runPlacement({ kind, device, deviceName }: { kind: TargetKind; device?: string | null; deviceName?: string | null }): Placement {
  const name = (deviceName || device || "").trim();
  return { kind, device: name || (DEFAULT_DEVICE[kind] ?? "Default device"), isDefault: !name, platform: PLATFORM_LABELS[kind] ?? kind };
}

/**
 * Where a run runs, the one way every screen says it: platform mark + platform name · device
 * name.
 */
export function RunPlacement({
  placement,
  size = "sm",
  showPlatform = true,
  className,
  ...rest
}: {
  placement: Placement;
  size?: "sm" | "md";
  /** False where the platform is already said next to it (a column of one platform). */
  showPlatform?: boolean;
  className?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "title">) {
  return (
    <span
      {...rest}
      className={cn("inline-flex min-w-0 items-center gap-1.5", size === "md" ? "text-sm" : "text-xs", className)}
      data-placement={placement.kind}
      title={`${placement.platform} · ${placement.device}`}
    >
      <PlatformIcon kind={placement.kind} className={cn("shrink-0", size === "md" ? "size-3.5" : "size-3")} />
      {showPlatform ? <span className="shrink-0 text-fg-2">{placement.platform}</span> : null}
      {showPlatform ? (
        <span aria-hidden className="text-muted">
          ·
        </span>
      ) : null}
      <span className={cn("min-w-0 truncate", placement.isDefault ? "text-muted" : "text-fg")} data-placement-device>
        {placement.device}
      </span>
    </span>
  );
}
