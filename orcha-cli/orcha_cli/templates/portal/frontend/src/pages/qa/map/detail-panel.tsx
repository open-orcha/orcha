import { ArrowUpRight, CircleDashed, Compass, Database, Eye, FileCode2, FlaskConical, Lock, Radio, Route as RouteIcon, Server, Smartphone, X } from "./kit/icons";
import { Maximize2, Minimize2, PanelBottomClose, PanelBottomOpen, PanelRightClose } from "./kit/icons";
import { useState, type ReactNode } from "react";
import { COVERAGE_LABEL, STATE_DOT } from "./coverage-words";
import { buttonVariants, cn, fmtDate, fmtRelative, ImageLightbox, Link } from "./kit";
import { DraftTestsAction } from "./draft-action";
import styles from "./app-map.module.css";
import type { Region } from "./layout";
import { RunAction, useMapHrefs } from "./map-actions";
import { CoveredBy, RegionCoverLine } from "./map-coverage";
import { connectionsOf, endpointTitle, featureSummaryLine, flowSteps, frameSrc, platformLabel, plural, quoteLabel, unlinkedReason, whyNotSeen, type Connection } from "./model";
import { PanelContext, PanelIconButton, Section, usePanelFull, usePanelTip } from "./panel-frame";
import { usePanelMode, useSectionState, type PanelMode } from "./panel-state";
import { SIDE_LABEL, STATE_LABEL, STORE_LABEL, type AppMap, type AppMapNode, type CodeRef, type NodeKind } from "./types";

/** What the panel shows: one node of the map, or one feature's region. */
export type Selection = { kind: "node"; id: string } | { kind: "region"; key: string };

const KIND_ICON: Record<NodeKind, typeof Smartphone> = { screen: Smartphone, endpoint: Server, entity: Database, flow: RouteIcon };
const KIND_LABEL: Record<NodeKind, string> = { screen: "Screen", endpoint: "Endpoint", entity: "Data", flow: "Test flow" };

/** A node's state as a dot: seen, blocked or only declared. */
const NODE_DOT = { seen: "bg-[var(--cov-strong)]", blocked: "bg-warning", declared: "bg-transparent border border-dashed border-muted" } as const;

function codeLine(ref: CodeRef): string {
  return ref.line ? `${ref.path}:${ref.line}` : ref.path;
}

function StateLine({ node }: { node: AppMapNode }) {
  const Icon = node.state === "seen" ? Eye : node.state === "blocked" ? Lock : CircleDashed;
  return (
    <span className={cn("inline-flex items-center gap-1", node.state === "seen" ? "text-[var(--cov-strong)]" : node.state === "blocked" ? "text-warning" : "text-muted")}>
      <Icon className="size-3.5" aria-hidden />
      {STATE_LABEL[node.state]}
    </span>
  );
}

function NodeLinks({ title, list, onGo, i }: { title: string; list: Connection[]; onGo: (id: string) => void; i: number }) {
  if (list.length === 0) return null;
  return (
    <Section name={`links:${title}`} title={title} i={i}>
      <ul className="grid gap-0.5">
        {list.map(({ node: n, edge }) => {
          const Icon = KIND_ICON[n.kind];
          return (
            <li key={n.id}>
              <button type="button" onClick={() => onGo(n.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-hover" data-map-connection={n.id}>
                <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
                <span className={cn("min-w-0 flex-1 truncate", n.kind === "endpoint" ? "font-mono text-xs text-fg" : "text-fg")}>{n.kind === "endpoint" ? endpointTitle(n) : n.label}</span>
                {edge.label ? <span className="max-w-[45%] shrink-0 truncate text-xs text-muted">{quoteLabel(edge.label)}</span> : null}
                {edge.count > 1 ? <span className="shrink-0 text-xs tabular-nums text-muted">×{edge.count}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Facts({ node }: { node: AppMapNode }) {
  const d = node.detail;
  const rows: [string, ReactNode][] = [];
  if (d.route) rows.push(["Route", <code key="r">{d.route}</code>]);
  if (d.platform) rows.push(["Platform", platformLabel(d.platform)]);
  if (node.kind === "endpoint") {
    rows.push(["Call", <code key="c">{endpointTitle(node)}</code>]);
    if (d.side) rows.push(["Where", d.side === "both" ? "Called by the app, served by its backend" : d.side === "client" ? "Called by the app" : "A server route"]);
    if (d.statuses.length) rows.push(["Statuses", d.statuses.join(", ")]);
    if (d.body_keys.length) rows.push(["Body", <code key="b">{d.body_keys.join(", ")}</code>]);
    if (d.handler) rows.push(["Handler", <code key="h">{d.handler}</code>]);
  }
  if (d.store) rows.push(["Store", STORE_LABEL[d.store]]);
  if (d.fields.length) rows.push(["Fields", <code key="f">{d.fields.join(", ")}</code>]);
  if (d.anchors.length) rows.push(["Anchors", d.anchors.join(", ")]);
  if (rows.length === 0 && d.actions.length === 0) return null;
  return (
    <Section name="facts" title="Facts" i={2}>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 select-text break-words text-fg [&_code]:font-mono [&_code]:text-xs">{v}</dd>
          </div>
        ))}
      </dl>
      {d.actions.length ? (
        <div className="mt-2 flex flex-wrap gap-1" data-map-actions>
          {d.actions.map((a) => (
            <span key={a} className="rounded-md border border-border bg-panel-2 px-1.5 py-0.5 text-xs text-fg-2">
              {quoteLabel(a)}
            </span>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

/** Every claim with its source: the file and line, the test and its framework, the runs. */
function Evidence({ node }: { node: AppMapNode }) {
  const { code, tests, live } = node.evidence;
  const hrefs = useMapHrefs();
  const runLink = live?.last_run_id ? hrefs.session(live.last_run_id) : null;
  // Full screen: long lists get the room, and paths wrap instead of being cut.
  const full = usePanelFull();
  const cap = full ? 40 : 6;
  const line = full ? "break-all" : "truncate";
  return (
    <Section name="evidence" title="Where this comes from" i={3}>
      <ul className="grid gap-2.5 text-sm">
        <li className="flex gap-2" data-map-evidence="code">
          <FileCode2 className={cn("mt-0.5 size-3.5 shrink-0", code.length ? "text-fg-2" : "text-border-strong")} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-fg-2">Code</p>
            {code.length ? (
              code.slice(0, cap).map((c) => (
                <p key={codeLine(c)} className={cn(line, "select-text font-mono text-xs text-fg")} title={codeLine(c)}>
                  {codeLine(c)}
                </p>
              ))
            ) : (
              <p className="text-xs text-muted">Not found in the code.</p>
            )}
          </div>
        </li>
        <li className="flex gap-2" data-map-evidence="tests">
          <FlaskConical className={cn("mt-0.5 size-3.5 shrink-0", tests.length ? "text-fg-2" : "text-border-strong")} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-fg-2">Tests</p>
            {tests.length ? (
              tests.slice(0, cap).map((t) => (
                <div key={`${t.path}:${t.test_name}:${t.line}`} className="min-w-0">
                  <p className={cn(line, "select-text text-xs text-fg")}>
                    {t.test_name}
                    {t.framework ? <span className="ml-1.5 rounded border border-border px-1 text-2xs text-muted">{t.framework}</span> : null}
                  </p>
                  {t.path ? <p className={cn(line, "select-text font-mono text-2xs text-muted")}>{t.line ? `${t.path}:${t.line}` : t.path}</p> : null}
                </div>
              ))
            ) : (
              <p className="text-xs text-muted">No existing test touches it.</p>
            )}
          </div>
        </li>
        <li className="flex gap-2" data-map-evidence="live">
          <Radio className={cn("mt-0.5 size-3.5 shrink-0", live ? "text-fg-2" : "text-border-strong")} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-fg-2">Live</p>
            {live ? (
              <>
                <p className="text-xs text-fg">
                  {node.kind === "endpoint" ? "Called" : node.kind === "entity" ? "Written" : "Seen"} in {plural(live.runs, "run")}
                  {live.last_seen_at ? (
                    <span className="text-muted" title={fmtDate(live.last_seen_at)}>
                      {" "}
                      · last {fmtRelative(live.last_seen_at)}
                    </span>
                  ) : null}
                </p>
                {runLink ? (
                  <Link href={runLink} className="mt-0.5 inline-flex items-center gap-1 text-xs text-accent hover:underline" data-map-last-run>
                    Open the last run <ArrowUpRight className="size-3" aria-hidden />
                  </Link>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-muted">No run has reached it yet.</p>
            )}
          </div>
        </li>
      </ul>
    </Section>
  );
}

/** A seen screen's frame. A click opens it full size in the app's lightbox (never a browser tab
 * on a localhost URL); Esc closes the lightbox first and leaves the panel as it was. */
function NodeFrame({ src, node, full }: { src: string; node: AppMapNode; full: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-3 block w-full cursor-zoom-in overflow-hidden rounded-lg border border-border bg-panel-2 transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        title="View the frame full size"
        aria-label={`View ${node.label} full size`}
        data-map-frame
      >
        <img src={src} alt={node.label} className={cn("w-full object-contain object-top", full ? "max-h-[calc(100dvh-220px)]" : "max-h-[280px]")} />
      </button>
      <ImageLightbox
        open={open}
        onClose={() => setOpen(false)}
        src={src}
        alt={node.label}
        title={node.label}
        description={node.detail.route ?? undefined}
        dataAttrs={{ "data-map-frame-lightbox": node.id }}
      />
    </>
  );
}

/** The top of a node's panel: its feature, its frame, why no run reached it and what to do next. */
function NodeLead({ map, node, src, steps, onRegion }: { map: AppMap; node: AppMapNode; src: string | null; steps: AppMapNode[]; onRegion: (key: string) => void }) {
  const why = node.kind === "screen" ? whyNotSeen(node) : null;
  const feature = node.feature ? map.features.find((f) => f.key === node.feature) : null;
  const full = usePanelFull();
  return (
    <>
      <div className={cn("px-4 py-3", styles.rise)}>
        {feature ? (
          <button type="button" onClick={() => onRegion(feature.key)} className="mb-2 inline-flex items-center gap-1.5 text-sm text-fg-2 hover:text-fg hover:underline" data-map-panel-feature>
            <span className={cn("size-2 rounded-full", STATE_DOT[feature.coverage])} aria-hidden />
            {feature.name}
          </button>
        ) : null}
        {src ? <NodeFrame src={src} node={node} full={full} /> : null}
        {why ? (
          <div className="rounded-lg border border-border bg-panel-2 px-3 py-2" data-map-why-not-seen>
            <p className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted">Why not seen</p>
            <p className="mt-0.5 text-sm text-fg">{why}</p>
          </div>
        ) : null}
        {node.kind === "flow" && (steps.length === 0 || node.detail.skipped) ? (
          <div className="rounded-lg border border-border bg-panel-2 px-3 py-2" data-map-flow-unlinked>
            <p className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted">{steps.length === 0 ? "Not tied to screens yet" : "Skipped"}</p>
            <p className="mt-0.5 text-sm text-fg">{steps.length === 0 ? unlinkedReason(node) : node.detail.skip_reason ?? "The test is skipped."}</p>
          </div>
        ) : null}
        {node.kind === "screen" && node.state !== "seen" ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <RunAction kind="explore" focus={node.detail.route ?? node.label} variant="default" size="md" data-map-explore-node>
              <Compass /> Explore to reach it
            </RunAction>
            <DraftTestsAction map={map} area={{ kind: "node", node }} variant="ghost" />
          </div>
        ) : null}
      </div>
    </>
  );
}

function NodeBody({ map, node, onGo, onRegion }: { map: AppMap; node: AppMapNode; onGo: (id: string) => void; onRegion: (key: string) => void }) {
  const c = connectionsOf(map, node.id);
  const src = node.state === "seen" ? frameSrc(node.frame_url) : null;
  const steps = node.kind === "flow" ? flowSteps(map, node.id) : [];
  const full = usePanelFull();
  const lead = <NodeLead map={map} node={node} src={src} steps={steps} onRegion={onRegion} />;
  const walks = steps.length ? (
    <Section name="steps" title={`Walks ${plural(steps.length, "screen")}`} i={1}>
      <ol className="grid gap-0.5">
        {steps.map((s, i) => (
          <li key={`${s.id}-${i}`}>
            <button type="button" onClick={() => onGo(s.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-hover">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-fg">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{s.label}</span>
              <StateLine node={s} />
            </button>
          </li>
        ))}
      </ol>
    </Section>
  ) : null;
  const facts = (
    <>
      <Facts node={node} />
      <CoveredBy node={node} i={2} map={map} />
    </>
  );
  const rest = (
    <>
      <Evidence node={node} />
      <NodeLinks title="Leads to" list={c.to} onGo={onGo} i={4} />
      <NodeLinks title="Reached from" list={c.from} onGo={onGo} i={5} />
      <NodeLinks title="Calls" list={c.calls} onGo={onGo} i={6} />
      <NodeLinks title="Called from" list={c.calledBy} onGo={onGo} i={7} />
      <NodeLinks title="Reads" list={c.reads} onGo={onGo} i={8} />
      <NodeLinks title="Writes" list={c.writes} onGo={onGo} i={9} />
      <NodeLinks title="Read by" list={c.readBy} onGo={onGo} i={10} />
      <NodeLinks title="Written by" list={c.writtenBy} onGo={onGo} i={11} />
      <NodeLinks title="Existing tests that walk it" list={c.flows} onGo={onGo} i={12} />
    </>
  );
  if (!full)
    return (
      <>
        {lead}
        {walks}
        {facts}
        {rest}
      </>
    );
  // Full screen: the frame large on the left and everything else in a readable column beside it;
  // without a frame, the facts and what covers it are the left column.
  return src ? (
    <Columns
      left={lead}
      right={
        <>
          {walks}
          {facts}
          {rest}
        </>
      }
    />
  ) : (
    <Columns
      left={
        <>
          {lead}
          {walks}
          {facts}
        </>
      }
      right={rest}
    />
  );
}

/** The full-screen panel's two columns, each scrolling on its own (one column on a narrow window). */
function Columns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="md:grid md:min-h-0 md:flex-1 md:grid-cols-[minmax(0,1fr)_minmax(340px,560px)]" data-map-panel-columns>
      <div className="md:min-h-0 md:overflow-y-auto" data-map-panel-col="left">
        {left}
      </div>
      <div className="md:min-h-0 md:overflow-y-auto md:border-l md:border-border md:[&>section:first-child]:border-t-0" data-map-panel-col="right">
        {right}
      </div>
    </div>
  );
}

function RegionBody({ map, region, onGo }: { map: AppMap; region: Region; onGo: (id: string) => void }) {
  // A region holds one feature, the small ones together ("Other areas") or the screens no feature claims.
  const screens = map.nodes.filter((n) => n.kind === "screen" && region.members.includes(n.feature ?? "~other"));
  const order = { seen: 0, declared: 1, blocked: 2 } as const;
  // "Other areas" lists its features; a feature's summary from the scan drops its screen count.
  const summary = region.kind === "areas" ? region.summary : featureSummaryLine(region.summary);
  const full = usePanelFull();
  const hrefs = useMapHrefs();
  const lead = (
    <div className={cn("px-4 py-3", styles.rise)}>
      <p className="text-base text-fg">
        {region.screens ? `${region.seen} of ${plural(region.screens, "screen")} seen` : "No screens known yet"}
        {region.blocked ? `, ${region.blocked} blocked` : ""}.
      </p>
      <RegionCoverLine screens={screens} />
      {summary ? (
        <p className="mt-1 text-sm text-muted" data-map-region-summary>
          {summary}
        </p>
      ) : null}
      {region.kind === "feature" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <DraftTestsAction
            map={map}
            area={{ kind: "feature", key: region.key }}
            draftLabel="Draft scenarios for this feature"
            variant={region.coverage === "untested" || region.coverage === "thin" ? "primary" : "default"}
          />
          <Link href={hrefs.coverage()} className={buttonVariants({ variant: "ghost", size: "md" })}>
            Coverage
          </Link>
        </div>
      ) : null}
    </div>
  );
  const list = screens.length ? (
    <Section name="screens" title="Screens" i={1}>
      <ul className="grid gap-0.5">
        {[...screens]
          .sort((a, b) => order[a.state] - order[b.state] || a.label.localeCompare(b.label))
          .map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onGo(s.id)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-hover">
                <span className="min-w-0 flex-1 truncate text-fg">{s.label}</span>
                <StateLine node={s} />
              </button>
            </li>
          ))}
      </ul>
    </Section>
  ) : null;
  return full ? (
    <Columns left={lead} right={list} />
  ) : (
    <>
      {lead}
      {list}
    </>
  );
}

/**
 * The side panel for one node or one feature: its state, every fact with the source that says
 * so (code `path:line`, the test and its framework, how many runs saw it and the last one), what
 * it connects to, and for a screen no run has reached why not and what to do next. A sheet over
 * the canvas on a narrow window, a panel at its right edge on a wide one.
 *
 * Its `mode` (held by the map view, remembered per viewer): docked as above; full over the whole
 * canvas (the whole height on a narrow window) in two columns; or collapsed to a rail at the right
 * edge (a bar at the bottom on a narrow window) that opens it again, the selection kept. Each
 * section folds, and stays folded for this viewer.
 */
export function DetailPanel({
  map,
  selection,
  region,
  mode: given,
  onMode: setGiven,
  onGo,
  onRegion,
  onClose,
}: {
  map: AppMap;
  selection: Selection;
  /** The selected region's box, when a region is selected. */
  region: Region | null;
  /** The frame, when the map view holds it (its Esc leaves full first); else the panel's own. */
  mode?: PanelMode;
  onMode?: (mode: PanelMode) => void;
  onGo: (id: string) => void;
  onRegion: (key: string) => void;
  onClose: () => void;
}) {
  const own = usePanelMode();
  const mode = given ?? own[0];
  const onMode = setGiven ?? own[1];
  const sections = useSectionState();
  const full = mode === "full";
  const reopenTip = usePanelTip("Open the panel");
  const node = selection.kind === "node" ? map.nodes.find((n) => n.id === selection.id) : undefined;
  if (!node && !region) return null;
  const Icon = node ? KIND_ICON[node.kind] : null;
  const title = node ? (node.kind === "endpoint" ? endpointTitle(node) : node.label) : region!.label;
  const dot = <span className={cn("size-2.5 shrink-0 rounded-full", node ? NODE_DOT[node.state] : STATE_DOT[region!.coverage])} aria-hidden data-map-panel-dot />;
  const id = node ? node.id : `region:${region!.key}`;

  if (mode === "collapsed")
    return (
      <aside
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex h-12 items-stretch border-t border-border bg-panel shadow-[var(--shadow-md)] md:absolute md:inset-x-auto md:bottom-3 md:right-3 md:top-[56px] md:z-20 md:h-auto md:w-11 md:rounded-xl md:border",
          styles.panel,
        )}
        aria-label={`${title} on the map`}
        data-map-panel={id}
        data-map-panel-mode="collapsed"
      >
        <button
          type="button"
          onClick={() => onMode("docked")}
          aria-label={`Open the panel: ${title}`}
          aria-expanded={false}
          className="flex min-w-0 flex-1 items-center gap-2 px-4 text-left transition-colors hover:bg-hover md:flex-col md:gap-3 md:rounded-xl md:px-0 md:py-3"
          data-map-panel-reopen
          {...reopenTip.trigger}
        >
          {Icon ? <Icon className="size-4 shrink-0 text-fg-2" aria-hidden /> : null}
          <span className={cn("min-h-0 min-w-0 flex-1 truncate text-sm font-medium text-fg", node?.kind === "endpoint" && "font-mono text-xs", styles.railTitle)}>{title}</span>
          {dot}
          <PanelBottomOpen className="size-4 shrink-0 text-muted md:hidden" aria-hidden />
        </button>
        {reopenTip.tip}
        <PanelIconButton label="Close" tip="Close (Esc)" onClick={onClose} className="mr-2 self-center md:hidden">
          <X />
        </PanelIconButton>
      </aside>
    );

  return (
    <PanelContext.Provider value={{ ...sections, full }}>
      <aside
        className={cn(
          "fixed z-40 overflow-y-auto border-border bg-panel shadow-[var(--shadow-md)]",
          full
            ? "inset-0 md:absolute md:z-30 md:flex md:flex-col md:overflow-hidden"
            : "inset-x-0 bottom-0 max-h-[78vh] rounded-t-xl border md:absolute md:inset-x-auto md:bottom-3 md:right-3 md:top-[56px] md:z-20 md:max-h-none md:w-[380px] md:rounded-xl",
          styles.panel,
        )}
        aria-label={`${title} on the map`}
        data-map-panel={id}
        data-map-panel-mode={mode}
        data-map-node-panel
      >
        <header className="sticky top-0 z-10 flex shrink-0 items-start gap-2 border-b border-border bg-panel/95 px-4 py-3 backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {Icon ? <Icon className="size-4 shrink-0 text-fg-2" aria-hidden /> : <span className={cn("size-2.5 shrink-0 rounded-full", STATE_DOT[region!.coverage])} aria-hidden />}
              <h2 className={cn("select-text truncate text-lg font-semibold text-fg", node?.kind === "endpoint" && "font-mono text-base")}>{title}</h2>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-sm text-fg-2">
              {node ? (
                <>
                  <span>{KIND_LABEL[node.kind]}</span>
                  {node.kind !== "flow" ? <StateLine node={node} /> : null}
                  {node.kind === "endpoint" && node.detail.side ? <span className="rounded-full border border-border px-1.5 text-2xs">{SIDE_LABEL[node.detail.side]}</span> : null}
                </>
              ) : (
                <span>{region!.kind === "feature" ? `Feature · ${COVERAGE_LABEL[region!.coverage]}` : region!.kind === "areas" ? plural(region!.members.length, "small feature") : "Not tied to a feature"}</span>
              )}
            </div>
          </div>
          <div className="-mr-1 flex shrink-0 items-center gap-0.5" data-map-panel-controls>
            <PanelIconButton
              label={full ? "Exit full screen" : "Full screen"}
              tip={full ? "Exit full screen (Esc)" : "Full screen"}
              onClick={() => onMode(full ? "docked" : "full")}
              data-map-panel-full
            >
              {full ? <Minimize2 /> : <Maximize2 />}
            </PanelIconButton>
            <PanelIconButton label="Collapse the panel" onClick={() => onMode("collapsed")} data-map-panel-collapse>
              <PanelRightClose className="max-md:hidden" />
              <PanelBottomClose className="md:hidden" />
            </PanelIconButton>
            <PanelIconButton label="Close" tip="Close (Esc)" onClick={onClose}>
              <X />
            </PanelIconButton>
          </div>
        </header>
        {node ? <NodeBody map={map} node={node} onGo={onGo} onRegion={onRegion} /> : <RegionBody map={map} region={region!} onGo={onGo} />}
      </aside>
    </PanelContext.Provider>
  );
}
