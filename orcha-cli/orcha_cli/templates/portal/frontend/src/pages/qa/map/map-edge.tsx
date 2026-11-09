import type { EdgeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import styles from "./app-map.module.css";
import { LABEL, routeLength, routePath, type PlacedLabel, type Route } from "./layout";

/** How an edge reads: navigation inside a region, the half of a line between regions (from a
 * screen to its region's port, or from a port to a screen), the zoomed-out summary of navigation
 * between regions, data calls, reads and writes, and a picked test flow. */
export type EdgeTone = "nav" | "cross" | "link" | "calls" | "reads" | "writes" | "flow";

export interface MapEdgeData extends Record<string, unknown> {
  route: Route;
  tone: EdgeTone;
  width: number;
  /** Run a dash along the edge in the direction of travel. */
  flowing: boolean;
  /** Small particles carrying data along it; `reverse` sends them from target to source (a read
   * flows up from the entity). Zero under reduced motion. */
  particles: number;
  reverse?: boolean;
  dim: boolean;
  active: boolean;
  /** Only the code says this way exists: no run or test has taken it. */
  dashed?: boolean;
  /** Placed by `placeLabels` (room checked, cut to fit), or null. */
  label: PlacedLabel | null;
  /** Draw only the label: the screens layer draws its labels as a last layer of their own, so no
   * line runs over one. */
  labelOnly?: boolean;
  /** The full label, for the hover title when the placed one is cut. */
  title?: string | null;
  /** The picked flow's segments draw one after another. */
  delay?: number;
}

/** An edge drawn along the layout's route rather than between React Flow's handles, so routes
 * between regions keep to the gutters. */
export function MapEdge({ id, data, markerStart, markerEnd }: EdgeProps) {
  const d = data as MapEdgeData;
  if (d.labelOnly) return d.label ? <EdgeLabel label={d.label} active={d.active} /> : null;
  const path = routePath(d.route);
  if (!path) return null;
  if (d.tone === "flow") {
    const len = Math.round(routeLength(d.route) * 1.6 + 40);
    return (
      <g data-map-edge={id} data-tone="flow">
        <path d={path} className={styles.flowGlow} strokeWidth={14} />
        <path d={path} className={styles.flowPath} strokeWidth={4} markerEnd={markerEnd} style={{ "--len": len, "--d": `${d.delay ?? 0}ms` } as CSSProperties} />
      </g>
    );
  }
  // About 260 canvas units a second, so a long route is not a blur.
  const dur = Math.max(1.6, Math.min(4.5, routeLength(d.route) / 260));
  return (
    <g className={styles.edge} data-tone={d.tone} data-dim={d.dim ? "true" : "false"} data-active={d.active ? "true" : "false"} data-dashed={d.dashed ? "true" : undefined} data-map-edge={id}>
      {d.tone === "nav" || d.tone === "cross" ? (
        // A wider invisible stroke, so a thin edge can be hovered for its label.
        <path d={path} className={styles.edgeHit} strokeWidth={14}>
          {d.title ? <title>{d.title}</title> : null}
        </path>
      ) : null}
      <path d={path} className={styles.edgePath} strokeWidth={d.width} markerStart={markerStart} markerEnd={markerEnd} />
      {d.flowing && !d.dim ? <path d={path} className={styles.edgeRun} strokeWidth={Math.max(2.5, d.width + 1)} /> : null}
      {!d.dim
        ? Array.from({ length: d.particles }, (_, i) => (
            <circle key={i} r={Math.max(3, d.width + 1.5)} className={styles.particle}>
              <animateMotion
                dur={`${dur.toFixed(2)}s`}
                // Started in the past, evenly spaced: a particle that has not begun would sit at the
                // canvas origin.
                begin={`-${((i * dur) / d.particles).toFixed(2)}s`}
                repeatCount="indefinite"
                path={path}
                keyPoints={d.reverse ? "1;0" : "0;1"}
                keyTimes="0;1"
                calcMode="linear"
              />
            </circle>
          ))
        : null}
      {d.label ? <EdgeLabel label={d.label} active={d.active} /> : null}
    </g>
  );
}

/** A small pill on its line, never free-floating: the theme's surface, the UI font. */
function EdgeLabel({ label, active }: { label: PlacedLabel; active: boolean }) {
  return (
    <g className={styles.edgeLabelGroup} data-active={active ? "true" : "false"} data-map-edge-label>
      <rect x={label.x - label.w / 2} y={label.y - LABEL.h / 2} width={label.w} height={LABEL.h} rx={LABEL.h / 2} className={styles.edgeLabelBox} />
      <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="central" fontSize={LABEL.size} className={styles.edgeLabel}>
        {label.text}
      </text>
    </g>
  );
}

export const mapEdgeTypes = { map: MapEdge };
