import { CircleHelp, TriangleAlert } from "../map/kit/icons";
import { PlatformIcon } from "./ui";
import { PLATFORM_NAMES } from "./ui";
import type { BuildSource, TargetKind } from "./types";
import { cn } from "./ui";
import { PRODUCTION_MEANS, buildWords, TONE_WORDS, backendHost, backendTone, platformOrder, targetBackend, type DetectedBackends } from "./backends";
import type { FoundBackend, PlatformKind } from "./contract";

const TONE_CLASS = {
  production: "border-danger/40 bg-danger/5 text-danger",
  local: "border-border bg-panel-2 text-fg-2",
  hosted: "border-border bg-panel-2 text-fg-2",
} as const;

/**
 * The We found sheet's Backend line (#453): each backend the repository names for the platforms
 * on, per build, marked Production or Local, the one runs use marked so, and a platform whose
 * backend cannot be told said plainly. Production's meaning is spelled out in one line.
 */
export function FoundBackends({
  detected,
  targets,
  reading,
}: {
  detected: DetectedBackends | null;
  /** The enabled platforms, with the build and locator that decide which backend runs reach. */
  targets: readonly { kind: TargetKind; locator: string; build: { source: BuildSource } }[];
  /** The repository is still being read. */
  reading: boolean;
}) {
  const kinds = new Set(targets.map((t) => t.kind));
  const list = (detected?.list ?? []).filter((b) => b.platforms.some((k) => kinds.has(k)));
  const used = new Set<FoundBackend>(targets.map((t) => targetBackend(detected, t)).filter((b): b is FoundBackend => b !== null));
  const unknown = platformOrder(Object.keys(detected?.unknown ?? {}) as PlatformKind[]).filter((k) => kinds.has(k));
  if (!detected) {
    return reading ? (
      <span className="text-muted" role="status">
        Reading the repository…
      </span>
    ) : (
      <span className="text-muted">Not read: there is no folder on this Mac to read it from. Set it with Edit.</span>
    );
  }
  if (list.length === 0 && unknown.length === 0) {
    return <span className="text-muted">None named in the code or config.</span>;
  }
  return (
    <span className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1.5" data-found-backends>
        {list.map((b) => {
          const tone = backendTone(b);
          return (
            <li key={`${b.build}:${b.url}:${b.platforms.join()}`} className="flex flex-col" data-found-backend={b.build} data-found-backend-production={b.production ? "" : undefined}>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="flex shrink-0 items-center gap-1" aria-label={platformOrder(b.platforms).filter((k) => kinds.has(k)).map((k) => PLATFORM_NAMES[k]).join(" and ")}>
                  {platformOrder(b.platforms)
                    .filter((k) => kinds.has(k))
                    .map((k) => (
                      <PlatformIcon key={k} kind={k} className="size-3.5 text-fg-2" />
                    ))}
                </span>
                <span className="shrink-0 font-medium">{b.service}</span>
                <span className="min-w-0 truncate font-mono text-xs text-fg-2" title={b.url}>
                  {backendHost(b.url)}
                </span>
                <span className={cn("inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border px-1.5 text-2xs font-medium", TONE_CLASS[tone])}>
                  {tone === "production" ? <TriangleAlert className="size-2.5" aria-hidden /> : null}
                  {TONE_WORDS[tone]}
                </span>
                {used.has(b) ? (
                  <span className="shrink-0 text-2xs font-medium text-primary" data-found-backend-used>
                    Runs use this
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted">
                {buildWords(b)} · <span className="font-mono">{b.source}</span>
              </span>
            </li>
          );
        })}
        {unknown.map((k) => (
          <li key={`unknown:${k}`} className="flex items-start gap-2" data-found-backend-unknown={k}>
            <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            <span className="flex flex-col">
              <span>Embodent cannot tell which backend {PLATFORM_NAMES[k]} builds from this checkout talk to.</span>
              <span className="text-xs text-muted">{detected.unknown[k]}. If it could be production, set it with Edit before the live pass.</span>
            </span>
          </li>
        ))}
      </ul>
      {list.some((b) => b.production) ? (
        <span className="flex items-start gap-1.5 text-xs text-fg-2" data-found-production-means>
          <TriangleAlert className="mt-px size-3 shrink-0 text-danger" aria-hidden />
          {PRODUCTION_MEANS}
        </span>
      ) : null}
    </span>
  );
}
