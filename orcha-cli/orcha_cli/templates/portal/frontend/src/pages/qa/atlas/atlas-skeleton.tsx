import type { CSSProperties } from "react";
import { Skeleton } from "../map/kit";
import { cn } from "../map/kit";
import styles from "./atlas.module.css";
import board from "./board.module.css";
import hero from "./hero.module.css";
import { CARD_PAD, FRAME, FRAME_GAP } from "./model";

/** A card's outline: its name, three device frames (two phones and a browser), its badge. */
function CardBones({ i }: { i: number }) {
  const d = i * 90;
  return (
    <div className={cn(styles.card, "!static shrink-0")} style={{ padding: CARD_PAD, width: FRAME.phone.w * 2 + FRAME.browser.w + FRAME_GAP * 2 + CARD_PAD * 2 }} aria-hidden>
      <Skeleton className="h-3 w-28" delay={d} />
      <Skeleton className="mt-2 h-2.5 w-16 opacity-70" delay={d} />
      <div className="mt-4 flex items-start" style={{ gap: FRAME_GAP }}>
        <Skeleton className="rounded-[18px]" style={{ width: FRAME.phone.w, height: FRAME.phone.h }} delay={d + 40} />
        <Skeleton className="rounded-[18px]" style={{ width: FRAME.phone.w, height: FRAME.phone.h }} delay={d + 80} />
        <Skeleton className="rounded-[9px]" style={{ width: FRAME.browser.w, height: FRAME.browser.h }} delay={d + 120} />
      </div>
      <Skeleton className="mt-3 h-5 w-24 rounded-full" delay={d + 160} />
    </div>
  );
}

/**
 * What the Atlas shows while the atlas is read: its own shape, its header (the number, the
 * platforms, the bar, the two figures), the filter bar, and two areas of cards with their device
 * frames, so nothing jumps when the atlas arrives. It says what it is doing in words.
 */
export function AtlasSkeleton() {
  return (
    <>
      <div className={cn(styles.palette, "flex min-h-0 flex-1 flex-col overflow-hidden")} aria-busy="true" aria-label="Loading the atlas" data-atlas-skeleton>
        <div className={hero.hero}>
          <div className={hero.main}>
            <Skeleton className="h-2.5 w-36" />
            <div className="mt-3 flex items-end gap-4">
              <Skeleton className="h-9 w-40" delay={40} />
              <Skeleton className="h-3 w-64 opacity-70" delay={60} />
            </div>
            <div className="mt-4 flex gap-1.5">
              {[150, 170, 150].map((w, i) => (
                <Skeleton key={i} className="h-[26px] rounded-full" style={{ width: w }} delay={80 + i * 50} />
              ))}
            </div>
            <Skeleton className="mt-5 h-2.5 max-w-[600px] rounded-full" delay={120} />
            <div className="mt-3 flex gap-4">
              {[70, 64, 150, 120].map((w, i) => (
                <Skeleton key={i} className="h-3" style={{ width: w }} delay={160 + i * 40} />
              ))}
            </div>
          </div>
          <div className={hero.side}>
            <div className="flex gap-1.5">
              {[110, 76, 170, 84].map((w, i) => (
                <Skeleton key={i} className="h-7 rounded-md" style={{ width: w }} delay={i * 50} />
              ))}
            </div>
            <div className="flex gap-2.5">
              <Skeleton className="h-[62px] w-[200px] rounded-[14px]" delay={120} />
              <Skeleton className="h-[62px] w-[230px] rounded-[14px]" delay={170} />
            </div>
          </div>
        </div>
        <div className={board.filters} style={{ position: "static" }}>
          {[164, 210, 300, 156].map((w, i) => (
            <Skeleton key={i} className="h-[30px] rounded-full" style={{ width: w }} delay={i * 50} />
          ))}
          <span className="ml-auto text-xs text-muted" role="status">
            Reading the atlas from the App map and its runs
          </span>
        </div>
        {[0, 1].map((r) => (
          <div key={r} className="px-4 py-6 md:px-6" style={{ "--i": r } as CSSProperties}>
            <div className="mb-4 flex items-center gap-3">
              <Skeleton className="h-[22px] w-[26px] rounded-[7px]" delay={r * 120} />
              <Skeleton className="h-4 w-28" delay={r * 120} />
              <Skeleton className="h-2.5 w-52 opacity-70" delay={r * 120 + 40} />
            </div>
            <div className="flex gap-11 overflow-hidden">
              {[0, 1, 2].map((c) => (
                <CardBones key={c} i={r * 3 + c} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
