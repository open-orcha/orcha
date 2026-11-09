import { useId, useRef, useState } from "react";
import { Button, Chip, IconButton, StatusIcon } from "../../components/primitives";
import { Icon } from "../../components/ui";

export interface GraphTask { id: string; title: string; status: string; label: string; assignee: string; dependsOn: string[]; draft?: boolean; changedDependencies?: string[];
  /** A Quality or Triage step's mark: its live status in words. */
  qa?: { word: string; tone: "ok" | "danger" | "warn" | "neutral"; kind?: "quality" | "triage" };
  /** The Quality workflow this step came from: one outline and label around its steps. */
  block?: { id: string; name: string };
  /** Ways back to an earlier step. `active`: a round really went back, or is about to. */
  returns?: { to: string; label: string; active?: boolean }[] }

const NODE_W = 264;
const NODE_H = 96;
/** How far under the nodes a way back runs. */
const RETURN_DROP = 44;

/** Only declared prerequisites produce edges. Ordering and worker turns never do. */
export function graphPositions(tasks: GraphTask[]) {
  const levels = new Map<string, number>();
  const level = (id: string, visiting = new Set<string>()): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (visiting.has(id)) return 0;
    const node = tasks.find((t) => t.id === id);
    const parents = node?.dependsOn.filter((p) => tasks.some((t) => t.id === p)) ?? [];
    const next = new Set(visiting).add(id);
    const value = parents.length ? Math.max(...parents.map((p) => level(p, next))) + 1 : 0;
    levels.set(id, value); return value;
  };
  const columns = new Map<number, number>();
  return tasks.map((t) => { const col = level(t.id); const row = columns.get(col) ?? 0; columns.set(col, row + 1); return { ...t, x: col * 300 + 16, y: row * 112 + 16 }; });
}

export function WorkflowGraph({ tasks, selected, onSelect, onAdd, onAfter, onEdit, disabledReason, editDisabledReason }: {
  tasks: GraphTask[]; selected: string | null; onSelect: (id: string) => void;
  onAdd?: () => void; onAfter?: (id: string) => void; onEdit?: (id: string) => void; disabledReason?: string | null; editDisabledReason?: string | null;
}) {
  const [scale, setScale] = useState(1);
  const region = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, "");
  const current = tasks.find((t) => t.id === selected);
  const related = new Set([selected, ...(current?.dependsOn ?? []), ...tasks.filter((t) => selected && t.dependsOn.includes(selected)).map((t) => t.id)]);
  // Keep the selected node even when a large neighbourhood exceeds the cap.
  const shown = (current ? [current, ...tasks.filter((t) => t.id !== current.id && related.has(t.id))] : tasks).slice(0, 30);
  const positions = graphPositions(shown);
  const width = Math.max(300, ...positions.map((t) => t.x + 280));
  const returns = positions.flatMap((t) => (t.returns ?? []).flatMap((r) => {
    const to = positions.find((n) => n.id === r.to);
    if (!to) return [];
    const [sx, ex] = [t.x + NODE_W / 2, to.x + NODE_W / 2];
    const [sy, ey] = [t.y + NODE_H, to.y + NODE_H + 3];
    const low = Math.max(sy, ey) + RETURN_DROP;
    return [{ key: `${t.id}:${r.to}`, label: r.label, active: !!r.active, tone: t.qa?.tone === "ok" ? "neutral" : r.active ? "danger" : "neutral", sx, sy, ex, ey, low }];
  }));
  const height = Math.max(110, ...positions.map((t) => t.y + NODE_H + 4)) + (returns.length ? RETURN_DROP + 24 : 0);
  const blocks = [...new Map(positions.filter((t) => t.block).map((t) => [t.block!.id, t.block!])).values()].map((b) => {
    const nodes = positions.filter((t) => t.block?.id === b.id);
    const [x, y] = [Math.min(...nodes.map((n) => n.x)), Math.min(...nodes.map((n) => n.y))];
    return { ...b, x: x - 8, y: y - 8, w: Math.max(...nodes.map((n) => n.x)) - x + NODE_W + 16, h: Math.max(...nodes.map((n) => n.y)) - y + NODE_H + 16 };
  });
  return <section className="wf-graph-view" aria-label="Workflow dependency graph">
    <div className="wf-graph-tools">
      {onAdd && <Button icon="plus" disabled={!!disabledReason} title={disabledReason ?? undefined} onClick={onAdd}>Add task</Button>}
      {current && onAfter && <Button disabled={!!disabledReason} title={disabledReason ?? undefined} onClick={() => onAfter(current.id)}>Add task after this</Button>}
      {current && onEdit && <Button disabled={!!editDisabledReason} title={editDisabledReason ?? undefined} onClick={() => onEdit(current.id)}>Edit prerequisites</Button>}
      <IconButton icon="plus" label="Zoom in" onClick={() => setScale((s) => Math.min(2, s + .25))} />
      <IconButton icon="minus" label="Zoom out" onClick={() => setScale((s) => Math.max(.25, s - .25))} />
      <Button variant="ghost" onClick={() => setScale(Math.max(.25, Math.min(1, (region.current?.clientWidth ?? width) / width)))}>Fit graph</Button>
      <Button variant="ghost" onClick={() => setScale(1)}>Reset zoom</Button>
      {selected && <Button variant="ghost" onClick={() => onSelect("")}>Reset selection</Button>}
    </div>
    <p className="wf-muted">Arrows point from a prerequisite to the task that needs its acceptance. They do not show turn order or promise simultaneous starts. Dashed lines and nodes are not saved.{returns.length ? " The curve underneath is where a step can send work back." : ""}</p>
    <p className="wf-muted">{shown.length} of {tasks.length} tasks in the graph. {current ? "Showing the selected task and its neighbours." : "Showing up to 30 tasks."} Full relationships remain in the list.</p>
    <div ref={region} className="wf-graph" tabIndex={0} role="region" aria-label="Dependency diagram; scroll to explore">
      <div style={{ width: width * scale, height: height * scale }}><div className="wf-graph-canvas" style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <svg width={width} height={height} aria-hidden="true"><defs><marker id={marker} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="currentColor" /></marker>
          {returns.length > 0 && ["neutral", "danger"].map((tone) => <marker key={tone} id={`${marker}-${tone}`} className={`wf-gback-m is-${tone}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" /></marker>)}</defs>
          {positions.flatMap((t) => t.dependsOn.map((id) => { const p = positions.find((n) => n.id === id); return p ? <path key={`${id}:${t.id}`} d={`M ${p.x + 264} ${p.y + 40} C ${p.x + 282} ${p.y + 40}, ${t.x - 18} ${t.y + 40}, ${t.x} ${t.y + 40}`} fill="none" stroke="currentColor" strokeDasharray={t.draft || t.changedDependencies?.includes(id) ? "5 4" : undefined} markerEnd={`url(#${marker})`} /> : null; }))}
          {returns.map((r) => <path key={r.key} className={`wf-gback is-${r.tone}${r.active ? " is-active" : ""}`} data-return={r.active ? "active" : "route"} d={`M ${r.sx} ${r.sy} C ${r.sx} ${r.low + 18}, ${r.ex} ${r.low + 18}, ${r.ex} ${r.ey}`} fill="none" strokeDasharray={tasks.some((t) => t.draft) ? "5 4" : undefined} markerEnd={`url(#${marker}-${r.tone})`} />)}
        </svg>
        {blocks.map((b) => <div key={b.id} className="wf-gblock" data-graph-block={b.name} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}><span>{b.name}</span></div>)}
        {positions.map((t) => <button type="button" key={t.id} className={`wf-gnode${selected === t.id ? " is-selected" : ""}${t.draft ? " is-draft" : ""}${t.qa ? ` is-qa is-${t.qa.kind ?? "quality"}` : ""}`} style={{ left: t.x, top: t.y }} aria-pressed={selected === t.id} onClick={() => onSelect(t.id)}>
          <span><StatusIcon status={t.status} label={t.label} /> <strong>{t.title}</strong>{t.qa && <span className="wf-gnode-tile" aria-hidden="true"><Icon name={t.qa.kind === "triage" ? "eye" : "shield"} cls="v2-ico" /></span>}</span><span className="wf-muted">{t.label} · {t.assignee || "Unassigned"}</span>{(t.qa || t.draft) && <span className="wf-gnode-chips">{t.qa && <Chip size="sm" dot={t.qa.tone}>{t.qa.word}</Chip>}{t.draft && <Chip size="sm">Not saved</Chip>}</span>}
        </button>)}
        {returns.map((r) => <span key={r.key} className={`wf-gback-label is-${r.tone}${r.active ? " is-active" : ""}`} data-return-label style={{ left: (r.sx + r.ex) / 2, top: r.low + 2 }}>{r.label}</span>)}
      </div></div>
    </div>
  </section>;
}
