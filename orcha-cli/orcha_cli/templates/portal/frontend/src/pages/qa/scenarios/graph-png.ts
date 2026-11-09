/**
 * The Map as a PNG, drawn from the graph's own nodes and edges onto a canvas, in the page's theme:
 * no dependency, and text stays sharp at twice the size. A file of the cards and their arrows, not
 * a screenshot of the screen: the status strip and pills are left to the app.
 */
import type { Edge, Node } from "@xyflow/react";
import type { ScenarioNodeData } from "./scenario-node";

const PAD = 40;
const SCALE = 2;
const NODE_W = 260;
const NODE_H = 72;

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > width) out = out.slice(0, -1);
  return `${out}…`;
}

/** The canvas of these nodes and edges, or null with nothing to draw. */
export function drawGraph(nodes: readonly Node<ScenarioNodeData>[], edges: readonly Edge[], style: CSSStyleDeclaration): HTMLCanvasElement | null {
  if (nodes.length === 0) return null;
  const sizes = new Map(nodes.map((n) => [n.id, { w: n.measured?.width ?? NODE_W, h: n.measured?.height ?? NODE_H }]));
  const size = (n: Node<ScenarioNodeData>) => sizes.get(n.id) ?? { w: NODE_W, h: NODE_H };
  const minX = Math.min(...nodes.map((n) => n.position.x));
  const minY = Math.min(...nodes.map((n) => n.position.y));
  const maxX = Math.max(...nodes.map((n) => n.position.x + size(n).w));
  const maxY = Math.max(...nodes.map((n) => n.position.y + size(n).h));
  const canvas = document.createElement("canvas");
  canvas.width = (maxX - minX + PAD * 2) * SCALE;
  canvas.height = (maxY - minY + PAD * 2) * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const bg = token(style, "--color-bg", "#111");
  const panel = token(style, "--color-panel", "#1a1a1a");
  const border = token(style, "--color-border", "#333");
  const fg = token(style, "--color-fg", "#eee");
  const muted = token(style, "--color-muted", "#999");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(PAD - minX, PAD - minY);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.5;
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    const x1 = a.position.x + size(a).w;
    const y1 = a.position.y + size(a).h / 2;
    const x2 = b.position.x;
    const y2 = b.position.y + size(b).h / 2;
    const mid = (x1 + x2) / 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(mid, y1, mid, y2, x2, y2);
    ctx.stroke();
  }
  for (const n of nodes) {
    const { w, h } = size(n);
    ctx.fillStyle = panel;
    ctx.beginPath();
    ctx.roundRect(n.position.x, n.position.y, w, h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = "600 14px system-ui, sans-serif";
    ctx.fillText(fit(ctx, n.data.name, w - 24), n.position.x + 12, n.position.y + 26);
    ctx.fillStyle = muted;
    ctx.font = "12px system-ui, sans-serif";
    const line = `${n.data.category ?? "General"} · ${n.data.criteriaCount} ${n.data.criteriaCount === 1 ? "criterion" : "criteria"} · ${n.data.status}`;
    ctx.fillText(fit(ctx, line, w - 24), n.position.x + 12, n.position.y + 48);
  }
  return canvas;
}

/** Saves the Map as `<name>.png`. */
export function downloadGraph(nodes: readonly Node<ScenarioNodeData>[], edges: readonly Edge[], name: string): boolean {
  const root = document.querySelector(".qa-port") ?? document.documentElement;
  const canvas = drawGraph(nodes, edges, getComputedStyle(root));
  if (!canvas) return false;
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `${name.replace(/[^\w-]+/g, "-").toLowerCase() || "scenarios"}.png`;
  a.click();
  return true;
}
