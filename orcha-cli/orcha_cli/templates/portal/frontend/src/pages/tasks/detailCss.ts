/**
 * Task detail styles (owner: tasks-detail) — the Linear issue layout for the
 * split inspector, the narrow pushed detail and the `?full=1` full view
 * (TaskDetail.tsx). Tokens only (docs/orcha-v2-design-system.md §1): no hex,
 * no coloured stripes (D3), hairlines + hover fills, round avatars (D7), the
 * shared status/priority glyphs (D8).
 *
 * The rail is a right column only when the pane itself is wide enough
 * (container query on `.td-pane`, so the 520 px inspector and a 1440 px full
 * view both lay out correctly); narrower it stacks under the gate.
 *
 * The gate card itself is styled in workCss (shared with Needs you).
 */
export const taskDetailCss = String.raw`
  /* ---- pane + header row ------------------------------------------------- */
  .td-pane { display: flex; flex-direction: column; min-height: 100%; container-type: inline-size; container-name: tdpane;
    background: var(--v2-panel); }
  .wk-full { max-width: none; min-height: 100%; display: flex; flex-direction: column; }
  .wk-full > #detailMain { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .wk-full > #detailMain > .td-pane { flex: 1; }
  .td-head { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: var(--v2-space-2);
    height: var(--v2-header-h); padding: 0 var(--v2-space-3) 0 var(--v2-space-4);
    background: var(--v2-panel); border-bottom: 1px solid var(--v2-border-subtle); }
  .td-pane.is-full .td-head, .td-pane.is-narrow .td-head { padding-left: var(--v2-space-3); }
  @media (max-width: 900px) { .td-head { top: var(--v2-sticky-top, 0px); } }
  .td-back { flex: none; }
  .run-stop .v2-ico { color: var(--v2-danger); } /* quiet button, red stop glyph (D2) */
  /* PageHeader / Pager inner layout: shared .v2-pagehead / .v2-pager (v2-shell.css) */
  .td-head .v2-pagehead { flex: 1; height: 100%; }
  .td-head .td-id { font-size: var(--v2-fs-body); color: var(--v2-text-3); font-weight: var(--v2-fw-medium); white-space: nowrap; }
  .td-head .v2-pagehead-actions { gap: 2px; }
  .td-head .v2-pager { gap: 0; margin-right: var(--v2-space-1); }
  /* D5: header actions are 28 px circular icon buttons */
  .td-head .v2-iconbtn.v2-iconbtn-sm, .td-head .v2-iconbtn.v2-iconbtn-md { width: 28px; height: 28px; }
  .td-head .v2-iconbtn .v2-ico { width: 15px; height: 15px; }

  /* ---- body grid: main · rail · activity --------------------------------- */
  .td-body { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: "main" "rail" "acts";
    row-gap: var(--v2-space-6); padding: var(--v2-space-5) var(--v2-space-5) var(--v2-space-8); }
  .td-main { grid-area: main; min-width: 0; display: flex; flex-direction: column; gap: var(--v2-space-4); }
  .td-rail { grid-area: rail; min-width: 0; }
  .td-acts { grid-area: acts; min-width: 0; }
  @container tdpane (min-width: 860px) {
    /* rows: main sizes to content, Activity takes the rest — a rail taller
       than the main column never opens a blank band above Activity */
    .td-body { grid-template-columns: minmax(0, 1fr) 300px; grid-template-areas: "main rail" "acts rail"; grid-template-rows: auto 1fr;
      column-gap: 0; row-gap: var(--v2-space-8); padding: 0; flex: 1; }
    .td-main { padding: var(--v2-space-10) var(--v2-space-10) 0 max(var(--v2-space-10), calc((100cqw - 300px - 760px) / 2)); }
    .td-acts { padding: 0 var(--v2-space-10) var(--v2-space-10) max(var(--v2-space-10), calc((100cqw - 300px - 760px) / 2)); }
    .td-main, .td-acts { max-width: calc(760px + 2 * var(--v2-space-10) + max(0px, (100cqw - 300px - 760px) / 2 - var(--v2-space-10))); }
    /* no rail border (Linear: the column reads by alignment, not a line) */
    .td-rail { grid-row: 1 / span 2; padding: var(--v2-space-6) var(--v2-space-5); }
    .td-railbox { position: sticky; top: calc(var(--v2-header-h) + var(--v2-space-6)); }
  }
  @container tdpane (max-width: 859px) {
    /* stacked: the rail is a compact key/value list between two hairlines */
    .td-rail { border-top: 1px solid var(--v2-border-subtle); border-bottom: 1px solid var(--v2-border-subtle); padding: var(--v2-space-3) 0; }
    .td-railbox { gap: var(--v2-space-3); }
    .td-railbox .v2-prop-row { min-height: 28px; }
  }

  /* ---- main column -------------------------------------------------------- */
  .td-title { margin: 0; font-family: var(--v2-font-display); font-size: var(--v2-fs-display); font-weight: var(--v2-fw-semibold);
    line-height: var(--v2-lh-tight); letter-spacing: var(--v2-ls-display); color: var(--v2-text); overflow-wrap: anywhere; }
  /* inspector: 18px/600, clamped to 3 lines (full title in the tooltip);
     the full view and the narrow pushed detail NEVER clamp the H1 */
  .td-pane.is-inspector .td-title { font-size: 18px; line-height: 1.35; letter-spacing: -0.005em;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .td-pane.is-narrow .td-title { font-size: 20px; line-height: 1.3; }
  .td-pane.is-inspector .td-main, .td-pane.is-narrow .td-main { gap: var(--v2-space-3); }
  /* ONE compact meta line under the inspector title */
  .td-meta { display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; min-width: 0; margin-top: -4px; overflow: hidden;
    font-size: var(--v2-fs-meta); color: var(--v2-text-2); line-height: 20px; white-space: nowrap; }
  .td-meta > * { flex: none; }
  .td-meta > .td-meta-who { flex: 0 1 auto; }
  .td-meta .v2-si-wrap.has-label { display: inline-flex; align-items: center; gap: 6px; }
  .td-meta .td-prio { gap: 6px; }
  .td-meta-sep { width: 3px; height: 3px; border-radius: 50%; background: var(--v2-text-3); opacity: .7; flex: none; }
  .td-meta-who { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .td-meta-who .td-stack { flex: none; }
  .td-meta-names { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
  .td-stack { display: inline-flex; }
  .td-stack > * + * { margin-left: -4px; }
  .td-stack .v2-av { box-shadow: 0 0 0 1.5px var(--v2-panel); border-radius: 50%; }
  /* inspector description: 3 lines + Show more */
  .td-desc-clamp.is-clamped { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .td-desc-clamp .td-desc { font-size: var(--v2-fs-body); }
  .td-desc-more { align-self: flex-start; height: auto; padding: 2px 0; margin-top: 2px; }
  .td-desc-wrap { display: flex; flex-direction: column; }
  /* rail links read as values, not bold headings */
  .td-railbox .dlink, .td-railbox .td-rel .dlink { font-weight: var(--v2-fw-regular); }
  /* full-view header: circular action buttons (copy link / ID / PR) */
  .td-head-acts { display: inline-flex; align-items: center; gap: 6px; margin-right: var(--v2-space-2); }
  .td-pr-btn { text-decoration: none; color: var(--v2-text-2); }
  /* in-place property editors (reviewer): the value itself is the button */
  .td-prop-btn { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; height: 26px; margin-left: -6px; padding: 0 6px;
    border: 0; border-radius: var(--v2-radius-sm); background: transparent; color: var(--v2-text); font: inherit; cursor: pointer; }
  .td-prop-btn:hover, .td-prop-btn[aria-expanded="true"] { background: var(--v2-hover); }
  .td-prop-btn:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  /* TG-35 / VD-13: a hyphenated name ("maya-member") never breaks mid-name —
     one left-aligned line, the text ellipsizes, the avatar keeps its size */
  .td-prop-btn { white-space: nowrap; text-align: left; }
  .td-rev { max-width: 100%; }
  .td-rev .v2-av { flex: none; }
  /* TG-35: the button sits 6px left (margin-left:-6px) inside the shrink-to-fit
     .td-rev, so 100% leaves it 6px short and ellipsizes the name — add it back */
  .td-rev .td-prop-btn { max-width: calc(100% + 6px); }
  .td-rev > span:not(.v2-av), .td-rev .td-prop-btn > span:not(.v2-av) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* rail actions (Assign & wake… / Cancel task…) as quiet one-line buttons */
  .td-railact { padding-top: var(--v2-space-1); }
  .td-railact-btn { margin-left: calc(-1 * var(--v2-space-2)); color: var(--v2-text-2); }
  .td-railact + .td-cancel { padding-top: 0; }
  /* gate evidence (.td-ev-*) lives in workCss — Needs you renders the gate too */
  /* Relations: "Request from lead · converted" on one line */
  .td-spawned { display: flex; align-items: baseline; min-width: 0; white-space: nowrap; }
  .td-railbox .td-spawned .dlink, .td-spawned .dlink { display: block; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .td-spawned-st { flex: none; white-space: pre; }
  /* in-place assignee editor (rail value / inspector meta line) */
  .td-assign { display: inline-flex; min-width: 0; max-width: 100%; }
  .td-assign-btn { height: auto; min-height: 26px; padding: 3px 6px; text-align: left; }
  /* grid, not an inline column-flex: the value takes the rail's free width
     (a lone "frontend-dev" never truncates to "frontend-…") */
  .td-assignees { display: grid; gap: 4px; min-width: 0; max-width: 100%; }
  /* the rail assignee fills its value cell (no "frontend-…" truncation in 156 px) */
  .td-assign-rail { flex: 1 1 auto; }
  .td-assign-rail .td-assign-btn { width: auto; flex: 1 1 auto; max-width: 100%; }
  .td-assign-rail .td-assignees { flex: 1 1 auto; }
  /* "open agent" link beside the picker value */
  .td-assign { align-items: center; gap: 2px; }
  .td-assign-open { flex: none; display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; color: var(--v2-text-3); }
  .td-assign-open .v2-ico { width: 12px; height: 12px; }
  .td-assign-open:hover { color: var(--v2-text); background: var(--v2-hover); }
  .td-assign-open:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  @media (hover: hover) {
    .td-assign .td-assign-open { opacity: 0; transition: opacity var(--v2-dur-fast, .12s) var(--v2-ease, ease); }
    .td-assign:hover .td-assign-open, .td-assign-open:focus-visible { opacity: 1; }
  }
  .td-assignees .td-actor { max-width: 100%; }
  .td-assignees .td-actor > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .td-meta .td-assign-btn { min-height: 22px; height: 22px; padding: 0 4px; margin-left: -4px; color: var(--v2-text-2); font-size: var(--v2-fs-meta); }
  .td-meta .td-assign { flex: 0 1 auto; min-width: 0; max-width: none; }
  .td-meta .td-assign-btn { max-width: none; }
  /* cancel impact: ≤ 2 facts + an ⓘ for the rest */
  .td-impact { display: flex; align-items: center; gap: 6px; margin-top: var(--v2-space-2); }
  /* run log: no gutter caret column */
  .td-acts .wk-runs .log .ln.ln { grid-template-columns: auto minmax(0, 1fr); }
  .td-acts .wk-runs .log .ln.is-plain { grid-template-columns: minmax(0, 1fr); }
  .td-desc { margin: 0; font-size: var(--v2-fs-body-lg); line-height: 1.6; color: var(--v2-text-2); }
  .td-desc.is-empty { color: var(--v2-text-3); font-size: var(--v2-fs-body); }
  .td-main > .td-desc + .td-gate, .td-main > .td-desc + .td-decided { margin-top: var(--v2-space-2); }
  .td-block { display: flex; flex-direction: column; gap: 4px; }
  .td-block-k { font-size: var(--v2-fs-meta); font-weight: var(--v2-fw-medium); color: var(--v2-text-3); }
  .td-block .wk-text { font-size: var(--v2-fs-body); color: var(--v2-text); }
  .td-plan > summary .v2-muted { margin-left: 2px; }

  /* ---- rail --------------------------------------------------------------- */
  .td-railbox { gap: var(--v2-space-5); }
  .td-railbox .v2-prop-v { font-size: var(--v2-fs-body); }
  .td-railbox .v2-si-wrap.has-label { display: inline-flex; align-items: center; gap: 6px; }
  .td-actor, .td-railbox .dlink { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--v2-text); text-decoration: none;
    border-radius: var(--v2-radius-sm); }
  .td-railbox .dlink:hover { text-decoration: underline; text-underline-offset: 2px; }
  .td-railbox .dlink > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .td-prio { display: inline-flex; align-items: center; gap: 8px; }
  .td-rev { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .td-rels { display: flex; flex-direction: column; gap: 4px; min-width: 0; width: 100%; }
  .td-rel { display: flex; align-items: center; gap: 6px; min-width: 0; line-height: 20px; }
  .td-rel .dlink { flex: 1; min-width: 0; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .td-rel-note { flex: none; font-size: var(--v2-fs-meta); }
  .td-rail-note { margin: 0; font-size: var(--v2-fs-meta); color: var(--v2-text-3); line-height: 1.5; }
  /* protocol as a rail section (pageCss .proto carries the legacy card look — flattened here) */
  .td-railbox .proto { border: 0; border-radius: 0; box-shadow: none; background: transparent; margin: 0; overflow: visible; }
  .td-railbox .proto > .ph { padding: 0; border: 0; cursor: default; flex-wrap: nowrap; gap: 6px; margin-bottom: 4px; }
  .td-proto-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; border-radius: var(--v2-radius-sm); }
  .td-proto-toggle:focus-visible { box-shadow: var(--v2-focus-ring); }
  .td-proto-toggle .td-chev { width: 12px; height: 12px; color: var(--v2-text-3); transition: transform var(--v2-dur-fast) var(--v2-ease); }
  .td-proto.collapsed .td-proto-toggle .td-chev { transform: rotate(-90deg); }
  .td-railbox .proto .pb { padding: 0; gap: 0; }
  .td-railbox .prow { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; padding: 5px 0; align-items: baseline; }
  /* TG-36: cloud/projects/projects.css styles a GLOBAL .prow (the project
     table's fixed 44px row). Protocol rows are a different thing — they grow
     with their content (long notes, the edit inputs) and never take the
     table row's hover band. */
  .proto .prow { height: auto; min-height: 0; position: static; color: inherit; font-size: inherit; }
  .proto .prow:hover, .proto .prow:focus-within { background: transparent; }
  .td-railbox .prow.is-notes { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .td-railbox .prow .k { color: var(--v2-text-3); font-size: 12.5px; }
  .td-railbox .prow .v { font-size: var(--v2-fs-body); font-weight: var(--v2-fw-regular); color: var(--v2-text); overflow-wrap: anywhere; }
  .td-railbox .proto .pf { padding: var(--v2-space-2) 0 0; }
  .td-railbox .proto .chips { min-width: 0; overflow: hidden; flex-wrap: nowrap; }
  .td-railbox .pchip { height: 20px; border-radius: var(--v2-radius-full); background: transparent; }
  .td-assign-row { display: flex; align-items: center; gap: 6px; }
  .td-assign-row .wk-select { flex: 1; min-width: 0; height: 28px; }
  .td-cancel { padding-top: var(--v2-space-1); }
  .td-cancel-btn { margin-left: calc(-1 * var(--v2-space-2)); color: var(--v2-text-3); }
  .td-cancel-btn:hover { color: var(--v2-danger); }

  /* ---- Activity | Runs ---------------------------------------------------- */
  .td-tabs.v2-tabs { gap: var(--v2-space-4); border-bottom: 0; margin-bottom: var(--v2-space-3); min-height: 0; }
  .td-tabs .v2-tab { height: 28px; padding: 0; font-size: var(--v2-fs-title); font-weight: var(--v2-fw-semibold); color: var(--v2-text-3); }
  .td-tabs .v2-tab[aria-selected="true"] { color: var(--v2-text); }
  .td-tabs .v2-tab[aria-selected="true"]::after, .td-tabs .v2-tab::after { display: none; }
  .td-tabs .v2-tab .v2-count, .td-tabs .v2-tab-count { font-size: var(--v2-fs-meta); font-weight: var(--v2-fw-regular); color: var(--v2-text-3); }
  .td-tabpanel:focus-visible { outline: none; }
  .td-activity { display: flex; flex-direction: column; gap: var(--v2-space-3); }
  .td-earlier { align-self: flex-start; margin-left: calc(-1 * var(--v2-space-2)); }
  .td-tl-who { display: inline-flex; align-items: center; gap: 6px; height: 20px; vertical-align: top; }
  .td-tl .v2-tl-actor { color: var(--v2-text-2); }
  .td-tl .v2-tl-card { margin: var(--v2-space-2) 0; }
  .td-tl .v2-tl-msg-body .bubble.wk-md { display: block; white-space: pre-line; margin: 0; padding: 0; border: 0; background: none; font-size: var(--v2-fs-body); line-height: 1.55; color: var(--v2-text); }
  .td-tl .msg-atts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .td-thread-note { font-size: var(--v2-fs-body); color: var(--v2-text-3); }
  .td-reply { margin-top: var(--v2-space-2); }
  .td-reply.dragover .v2-composer { border-color: var(--v2-accent); }
  .td-reply .attach-tray { display: flex; flex-wrap: wrap; gap: 6px; }
  .td-acts .wk-runs .log .ln.is-bad .ty, .td-acts .wk-runs .log .ln.is-bad .tx { color: var(--v2-danger); }
  .td-missing { padding: var(--v2-space-6) var(--v2-space-4); }

  /* full view: the header title only once the H1 has scrolled out (D12: never twice) */
  .td-pane.is-full .td-head .v2-pagehead-title { transition: opacity var(--v2-dur-fast, .12s) var(--v2-ease, ease); }
  .td-pane.is-full[data-h1-visible="true"] .td-head .v2-pagehead-title { opacity: 0; visibility: hidden; flex: 0 0 0; max-width: 0; padding: 0; margin: 0; } /* the ⋯ sits right after the ID */
  /* phone: Properties as one disclosure line between the body and Activity */
  .td-rail-toggle { display: flex; align-items: center; gap: 6px; width: 100%; height: 36px; padding: 0; border: 0; background: transparent;
    color: var(--v2-text-2); font: inherit; font-size: var(--v2-fs-body); font-weight: var(--v2-fw-medium); cursor: pointer; text-align: left; }
  .td-rail-toggle:hover { color: var(--v2-text); }
  /* VD-41: a 44 px tap row on touch (the line is full-width and transparent — only taller) */
  @media (pointer: coarse) { .td-rail-toggle { height: 44px; } }
  .td-rail-toggle:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); border-radius: var(--v2-radius-sm); }
  .td-rail-chev { width: 12px; height: 12px; color: var(--v2-text-3); transform: rotate(-90deg); transition: transform var(--v2-dur-fast, .12s) var(--v2-ease, ease); }
  .td-rail-toggle[aria-expanded="true"] .td-rail-chev { transform: none; }
  .td-rail:has(> .td-rail-toggle) { padding: 0; }
  .td-rail-body.is-collapsible { padding: 4px 0 var(--v2-space-3); }
  .td-rail-body[hidden] { display: none; }

  /* ---- phone -------------------------------------------------------------- */
  @media (max-width: 560px) {
    .td-body { padding: var(--v2-space-4) var(--v2-space-4) var(--v2-space-8); row-gap: var(--v2-space-5); }
    .td-title { font-size: 20px; line-height: 1.3; }
    .td-head-acts { display: none; } /* copy link / ID / PR stay in the ⋯ menu on phones */
    .td-desc { font-size: var(--v2-fs-body); }
    .td-head { padding: 0 var(--v2-space-2) 0 var(--v2-space-3); gap: 6px; }
    .td-head .v2-pager-pos { display: none; }
  }
  /* full view: the compact meta line only while the rail is stacked */
  @container tdpane (min-width: 860px) { .td-meta.td-meta-full { display: none; } }
  /* after a verification reject: the feedback near the top, the old result marked */
  .td-changes { border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control); padding: 8px 12px; display: grid; gap: 4px; }
  .td-changes-h { display: flex; align-items: center; gap: 6px; font-size: var(--v2-fs-body, 13px); }
  .td-changes-h .v2-ico { width: 14px; height: 14px; color: var(--v2-danger, var(--v2-text-2)); }
  .td-changes-b { color: var(--v2-text-2); }
  .td-block.is-rejected .wk-text { opacity: .72; }
`;
