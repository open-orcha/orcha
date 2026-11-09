import { useState, type CSSProperties } from "react";
import { Flag, OctagonX, Square } from "../../map/kit/icons";
import { severityDot } from "../../map/kit";
import { ScreenThumb } from "../screen-thumb";
import { urlFor } from "../frames";
import type { Exploration, ResultFinding } from "../explorations";
import { cn } from "../../map/kit";
import { frameIndexFor, routeSize, spread, type ExplorationRoute, type RouteFrame } from "./home-model";
import styles from "./explore.module.css";

const ROTATE = [-5, -1.5, 2.5, 5.5];

export function isPhone(kind: string | null | undefined): boolean {
  return kind === "ios" || kind === "android";
}

/**
 * A card's screenshot fan: a few screens from its route, overlapping like prints on a table,
 * spreading out when the card is hovered or focused. Decorative: the card's route button says
 * the same thing in words.
 */
export function ScreenFan({ route, kind, onClick }: { route: ExplorationRoute; kind: string | null; onClick?: () => void }) {
  const phone = isPhone(kind);
  const shots = spread(route.frames, 4);
  return (
    <span
      aria-hidden
      onClick={onClick}
      className={cn("relative flex shrink-0 cursor-pointer items-center pr-1 pt-1", styles.fan)}
      style={{ "--n": shots.length } as CSSProperties}
      data-screen-fan={shots.length}
    >
      {shots.map((f, k) => (
        <FanShot key={f.seq} frame={f} k={k} phone={phone} />
      ))}
    </span>
  );
}

/** One print of the fan; a screenshot no longer on disk leaves a blank print, not a broken image. */
function FanShot({ frame, k, phone }: { frame: RouteFrame; k: number; phone: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <span
      className={cn(
        "relative block overflow-hidden border border-border-strong bg-panel-2 shadow-[0_2px_8px_-2px_rgb(0_0_0/0.25)]",
        phone ? "h-[86px] w-[40px] rounded-[7px]" : "h-[70px] w-[112px] rounded-[5px]",
        k > 0 && (phone ? "-ml-[18px]" : "-ml-[64px]"),
        styles.fanItem,
      )}
      style={{ "--k": k, "--r": `${ROTATE[k % ROTATE.length]}deg`, zIndex: k } as CSSProperties}
    >
      {broken ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- a local run artifact
        <img
          src={urlFor(frame.path)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setBroken(true)}
          className={cn("absolute inset-0 size-full object-cover", phone ? "object-top" : "object-center")}
        />
      )}
    </span>
  );
}

function pinsByFrame(frames: readonly RouteFrame[], findings: readonly ResultFinding[]): Map<number, ResultFinding[]> {
  const out = new Map<number, ResultFinding[]>();
  for (const f of findings) {
    if (typeof f.step_seq !== "number") continue;
    const i = frameIndexFor(frames, f.step_seq);
    out.set(i, [...(out.get(i) ?? []), f]);
  }
  return out;
}

/**
 * The expedition log: the screens an exploration reached, in order, drawn in one after another
 * with the path between them, an issue pinned on the screen it was found at, and how the route
 * ended (the report, or where it was stopped). Each screen opens full size.
 */
export function RouteStrip({ id, exploration: e, route }: { id: string; exploration: Exploration; route: ExplorationRoute }) {
  const phone = isPhone(e.platform);
  const findings = e.result?.findings ?? [];
  const pins = pinsByFrame(route.frames, findings);
  const End = e.status === "done" ? Flag : e.status === "failed" ? OctagonX : Square;
  const endLabel = e.status === "done" ? "Report" : e.status === "failed" ? "Ended here" : e.status === "cancelled" ? "Stopped here" : "So far";
  const total = route.screens ?? route.captured;
  const sampled = route.frames.length < total;

  return (
    <div id={id} className={cn("mt-3 flex flex-col gap-2 border-t border-border pt-3", styles.route)} data-route-strip={route.frames.length}>
      <p className="text-xs text-muted">
        The route: {routeSize(route)} in the order Embodent took them
        {sampled ? `, ${route.frames.length} shown` : ""}
        {route.screens != null && route.captured > route.screens ? ` (${route.captured} screenshots)` : ""}.
      </p>
      <ol className="-mx-1 flex items-start overflow-x-auto px-1 pb-2 pt-1" aria-label="Route">
        {route.frames.map((f, i) => {
          const here = pins.get(i) ?? [];
          return (
            <li key={f.seq} className="flex shrink-0 items-start">
              {i > 0 ? (
                <span aria-hidden className={cn("mx-1 h-px w-5 bg-primary/50", phone ? "mt-[64px]" : "mt-[50px]", styles.leg)} style={{ "--i": i } as CSSProperties} />
              ) : null}
              <div className={cn("flex flex-col items-center gap-1", styles.routeFrame)} style={{ "--i": i } as CSSProperties}>
                <div className="relative">
                  <ScreenThumb
                    src={urlFor(f.path)}
                    label={`Screen ${i + 1} of the route, step ${f.seq}`}
                    description={`Step ${f.seq} of ${e.name}`}
                    imgClassName={phone ? "h-[128px] w-[59px] rounded-[9px]" : "h-[100px] w-[160px]"}
                  />
                  {here.length > 0 ? (
                    <span
                      className={cn(
                        "pointer-events-none absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-panel px-1 text-[10px] font-bold text-white",
                        severityDot[here[0].severity],
                        styles.pin,
                      )}
                      style={{ "--i": i } as CSSProperties}
                      title={here.map((x) => x.title).join("\n")}
                    >
                      {here.length}
                      <span className="sr-only">{here.length === 1 ? " issue found here" : " issues found here"}</span>
                    </span>
                  ) : null}
                </div>
                <span className="text-2xs tabular text-muted">{i === 0 ? "Start" : `Step ${f.seq}`}</span>
              </div>
            </li>
          );
        })}
        <li className="flex shrink-0 items-start" aria-label={endLabel}>
          <span aria-hidden className={cn("mx-1 h-px w-5 bg-border-strong", phone ? "mt-[64px]" : "mt-[50px]", styles.leg)} style={{ "--i": route.frames.length } as CSSProperties} />
          <span
            className={cn("flex flex-col items-center gap-1", styles.routeFrame, phone ? "pt-[48px]" : "pt-[34px]")}
            style={{ "--i": route.frames.length } as CSSProperties}
          >
            <span
              className={cn(
                "flex size-8 items-center justify-center rounded-full border",
                e.status === "done" ? "border-success/50 bg-success/10 text-success" : e.status === "failed" ? "border-danger/40 bg-danger/10 text-danger" : "border-border-strong bg-panel-2 text-muted",
              )}
            >
              <End aria-hidden className="size-3.5" strokeWidth={2} />
            </span>
            <span className="text-2xs text-muted">{endLabel}</span>
          </span>
        </li>
      </ol>
      {findings.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Issues on this route">
          {findings.slice(0, 4).map((f) => (
            <li key={f.fingerprint || f.title} className="flex min-w-0 items-center gap-2 text-xs text-fg-2">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", severityDot[f.severity])} />
              <span className="min-w-0 truncate">{f.title}</span>
              <span className="shrink-0 text-muted">
                {f.severity}
                {typeof f.step_seq === "number" ? ` · step ${f.step_seq}` : ""}
              </span>
            </li>
          ))}
          {findings.length > 4 ? <li className="text-xs text-muted">and {findings.length - 4} more in the report</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
