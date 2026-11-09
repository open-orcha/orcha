import { Skeleton } from "../../map/kit";

/**
 * What the Sessions view shows while it reads the explorations: its own shape, the header with
 * its four figures and three quick starts, the territory's tiles and the first
 * expeditions on their rail, so nothing jumps when the page arrives. It says what it is doing.
 */
export function ExploreSkeleton() {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-hidden px-4.5 py-5" aria-busy="true" aria-label="Loading explorations" data-explore-skeleton>
        <p className="sr-only" role="status">
          Reading this project&apos;s explorations and feature map.
        </p>
        <div className="flex flex-col gap-5 rounded-xl border border-border bg-panel p-5 sm:p-6" aria-hidden>
          <div className="flex items-start gap-4">
            <Skeleton className="size-11 shrink-0 rounded-xl" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full max-w-[520px]" delay={60} />
            </div>
            <Skeleton className="h-8 w-36 rounded-md" delay={90} />
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-2 rounded-lg border border-border px-3.5 py-3">
                <Skeleton className="h-2.5 w-20" delay={i * 70} />
                <Skeleton className="h-6 w-14" delay={i * 70 + 30} />
                <Skeleton className="h-2.5 w-24 opacity-70" delay={i * 70 + 60} />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3 rounded-lg border border-border p-3">
                <Skeleton className="h-14 w-[88px] shrink-0 rounded-md max-xl:hidden" delay={i * 80} />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-28" delay={i * 80} />
                  <Skeleton className="h-2.5 w-full" delay={i * 80 + 40} />
                  <Skeleton className="h-2.5 w-2/3" delay={i * 80 + 80} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3" aria-hidden>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-10 w-full rounded-lg" delay={40} />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex h-[104px] flex-col gap-2 rounded-lg border border-dashed border-border-strong bg-panel-2 p-3">
                <Skeleton className="h-3 w-24" delay={i * 90} />
                <Skeleton className="h-2.5 w-16" delay={i * 90} />
                <Skeleton className="mt-auto h-2.5 w-28" delay={i * 90} />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2.5 pl-9" aria-hidden>
          {[0, 1].map((i) => (
            <div key={i} className="flex h-[112px] items-start gap-3 rounded-xl border border-border bg-panel p-3.5">
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-40" delay={i * 100} />
                <Skeleton className="h-2.5 w-72 max-w-full" delay={i * 100 + 40} />
                <Skeleton className="h-5 w-56 max-w-full rounded-full" delay={i * 100 + 80} />
              </div>
              <Skeleton className="size-[46px] shrink-0 rounded-full" delay={i * 100 + 120} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
