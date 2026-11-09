import { Handle, Position, type NodeProps } from "@xyflow/react";
import { urlFor } from "../frames";
import type { Severity } from "../explorations";
import { cn } from "../../map/kit";

export interface ScreenNodeData extends Record<string, unknown> {
  name: string;
  framePath: string;
  depth: number;
  visits: number;
  order: number;
  isRoot: boolean;
  worst: Severity | null;
  findingCount: number;
  /** Card width and screenshot height in canvas units. */
  width: number;
  imageHeight: number;
  /** The node the tour or the inspector is on. */
  active: boolean;
  /** Already reached by the tour (or the whole tree when no tour is playing). */
  reached: boolean;
  /** Stagger for the entrance animation, ms. */
  revealDelay: number;
}

const sevDot: Record<Severity, string> = {
  blocker: "bg-sev-blocker",
  major: "bg-sev-major",
  minor: "bg-sev-minor",
  cosmetic: "bg-sev-cosmetic",
  info: "bg-sev-info",
};

/** One screen the agent reached: its screenshot, name and how often it came back here. */
export function ScreenNode({ data }: NodeProps) {
  const d = data as ScreenNodeData;
  return (
    <div
      className={cn("xmap-node group relative", d.active && "xmap-node-active", !d.reached && "xmap-node-dim")}
      style={{ width: d.width, animationDelay: `${d.revealDelay}ms` }}
      data-screen-node
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
      {d.active ? <span aria-hidden className="xmap-halo" /> : null}
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-panel shadow-sm transition-[transform,border-color] duration-150",
          "group-hover:-translate-y-0.5 group-hover:border-border-strong",
          d.active ? "border-accent group-hover:border-accent" : "border-border",
          d.isRoot && !d.active && "border-border-strong",
        )}
      >
        <div className="relative overflow-hidden bg-bg" style={{ height: d.imageHeight }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local artifact route, sized by the canvas */}
          <img
            src={urlFor(d.framePath)}
            alt={d.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full w-full object-cover object-top"
          />
          <span className="absolute left-2 top-2 rounded-sm bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {d.isRoot ? "root" : `depth ${d.depth}`}
          </span>
          {d.findingCount > 0 && d.worst ? (
            <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-sm bg-black/65 px-1.5 py-0.5 text-[10px] font-medium tabular text-white">
              <span className={cn("h-1.5 w-1.5 rounded-full", sevDot[d.worst])} />
              {d.findingCount}
            </span>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="truncate text-[13px] font-medium text-fg" title={d.name}>
            {d.name}
          </span>
          <span className="shrink-0 text-[11px] tabular text-muted" title="Times the agent was on this screen">
            ×{d.visits}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0 !bg-transparent" />
    </div>
  );
}

export const screenNodeTypes = { screen: ScreenNode };
