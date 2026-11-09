import type { SVGProps } from "react";
import { Globe, Monitor } from "./icons";
import { Chip } from "./chip";
import type { TargetKind } from "./types";
import { cn } from "./cn";

/**
 * Platform marks for iOS / Android / web, and the chip that pairs one with its label.
 *
 * A platform is the thing you scan a list for — "which of these is the Android run?" — and a
 * lowercase word set in the same type as every other chip makes that a reading task instead of
 * a glance. The mark does the identifying; the word stays for anyone who does not read logos,
 * and for screen readers.
 *
 * Apple and Android are brand marks, so they are drawn here rather than pulled from an icon
 * set: lucide ships neither, and an approximation (a phone outline, a generic robot) is worse
 * than no icon because it reads as *some other thing*. Both paths are the plain silhouettes,
 * drawn on a 24×24 grid and filled with `currentColor`, so they inherit type colour and sit on
 * the baseline like any other icon. Web keeps lucide's globe — there is no brand to get wrong —
 * and a desktop app gets lucide's monitor: it runs on the worker's own Mac, whatever stack built it.
 */

export function AppleIcon({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("size-3.5", className)}
      {...rest}
    >
      <path d="M16.36 12.73c-.02-2.1 1.72-3.1 1.8-3.15-.98-1.43-2.5-1.63-3.04-1.65-1.29-.13-2.53.76-3.18.76-.66 0-1.67-.74-2.75-.72-1.41.02-2.72.82-3.45 2.08-1.47 2.55-.38 6.32 1.05 8.39.7 1.01 1.53 2.15 2.62 2.11 1.05-.04 1.45-.68 2.72-.68 1.27 0 1.63.68 2.74.66 1.13-.02 1.85-1.03 2.54-2.05.8-1.17 1.13-2.31 1.15-2.37-.03-.01-2.2-.85-2.22-3.38zM14.3 6.6c.58-.7.97-1.68.86-2.65-.83.03-1.84.55-2.44 1.25-.54.62-1 1.61-.88 2.56.93.07 1.88-.47 2.46-1.16z" />
    </svg>
  );
}

export function AndroidIcon({ className, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("size-3.5", className)}
      {...rest}
    >
      <path d="M17.6 9.48l1.84-3.18a.38.38 0 0 0-.14-.52.38.38 0 0 0-.52.14l-1.86 3.22a11.4 11.4 0 0 0-9.84 0L5.22 5.92a.38.38 0 0 0-.52-.14.38.38 0 0 0-.14.52L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2zm10 0a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2z" />
    </svg>
  );
}

/** The mark for a platform, with no label or pill around it. */
export function PlatformIcon({
  kind,
  className,
}: {
  kind: TargetKind;
  className?: string;
}) {
  if (kind === "ios") return <AppleIcon className={className} />;
  if (kind === "android") return <AndroidIcon className={className} />;
  if (kind === "desktop") return <Monitor className={cn("size-3.5", className)} strokeWidth={1.75} aria-hidden />;
  return <Globe className={cn("size-3.5", className)} strokeWidth={1.75} aria-hidden />;
}

/** Display name for a platform — `iOS`, not `ios`. */
export const PLATFORM_LABELS: Record<TargetKind, string> = {
  ios: "iOS",
  android: "Android",
  web: "Web",
  desktop: "Desktop",
};

/**
 * The standard way to show a platform: mark + name in a chip.
 *
 * `iconOnly` keeps the accessible name while dropping the visible word, for dense rows where
 * the platform is one of many chips competing for width.
 */
export function PlatformChip({
  kind,
  iconOnly = false,
  className,
  ...rest
}: {
  kind: TargetKind;
  iconOnly?: boolean;
  className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const label = PLATFORM_LABELS[kind] ?? kind;
  return (
    <Chip
      className={cn("gap-1", iconOnly && "px-1.5", className)}
      data-platform={kind}
      title={iconOnly ? label : undefined}
      {...rest}
    >
      <PlatformIcon kind={kind} />
      {iconOnly ? <span className="sr-only">{label}</span> : label}
    </Chip>
  );
}
