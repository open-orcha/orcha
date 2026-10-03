/**
 * /requests page-local styles (layered on top of pages/tasks/workCss.ts for
 * the shared form / error / markdown bits).
 * - detailCss: rendered by RequestDetail itself so the Needs-you queue (which
 *   embeds RequestDetail) gets the same payload / decision card / timeline /
 *   rail styling.
 * - listCss: rendered by RequestsPage — the Linear Inbox layout (narrow list
 *   of two-line items + wide detail pane inside the D5 panel).
 * Linear rules (D2/D3/D5/D12): tokens only, no coloured left stripes, hover /
 * selected fills instead of borders, one compact card for the decision.
 */
export const detailCss = `
  .rq-detail { container-type: inline-size; display: block; }
  .rq-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--v2-space-8); }
  @container (min-width: 780px) {
    .rq-grid { grid-template-columns: minmax(0, 1fr) 232px; gap: var(--v2-space-10); }
    .rq-rail { position: sticky; top: var(--v2-space-4); align-self: start; }
  }
  @container (max-width: 779px) {
    .rq-rail { margin-top: var(--v2-space-2); }
    /* stacked under Activity: the same 15px/600 section title, not a 12px label */
    .rq-rail .v2-rail-sec-title { font-size: var(--v2-fs-title); font-weight: var(--v2-fw-semibold); letter-spacing: var(--v2-ls-title);
      color: var(--v2-text); text-transform: none; }
    .rq-rail .v2-rail-sec-h { margin-bottom: var(--v2-space-2); }
  }
  .rq-main { min-width: 0; }

  /* meta line: from → to · status · marker */
  .rq-flowline { display: flex; align-items: center; gap: var(--v2-space-2); flex-wrap: wrap; font-size: var(--v2-fs-body); color: var(--v2-text-2); }
  .rq-flowline .node { display: inline-flex; align-items: center; gap: 6px; color: var(--v2-text); text-decoration: none; font-weight: var(--v2-fw-medium); }
  .rq-flowline a.node:hover { text-decoration: underline; text-underline-offset: 2px; }
  .rq-flowline .wk-arrow { color: var(--v2-text-3); display: inline-flex; }
  .rq-flowline .wk-arrow .v2-ico { width: 14px; height: 14px; }
  .rq-flowline .v2-si-label { color: var(--v2-text-2); }
  .rq-sep { color: var(--v2-text-3); }

  /* links: accent, underline on hover */
  .rq-detail .dlink, .rq-page .dlink { color: var(--v2-accent); text-decoration: none; }
  .rq-detail .dlink:hover, .rq-page .dlink:hover { color: var(--v2-accent-hover); text-decoration: underline; text-underline-offset: 2px; }
  .rq-detail .rq-flowline a.node.dlink { color: var(--v2-text); }

  /* task reference (Linear "Duplicate ENG-1998 …"): glyph + muted id + regular title, accent on hover only */
  .rq-tasklink { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; color: var(--v2-text);
    font-weight: var(--v2-fw-regular); text-decoration: none; border-radius: var(--v2-radius-sm); }
  .rq-tasklink .v2-si { flex: none; }
  .rq-tasklink-id { flex: none; font-size: var(--v2-fs-meta); color: var(--v2-text-3); font-variant-numeric: tabular-nums; }
  .rq-tasklink-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rq-tasklink:hover .rq-tasklink-t { color: var(--v2-accent-hover); text-decoration: underline; text-underline-offset: 2px; }
  .rq-tasklink:focus-visible { box-shadow: var(--v2-focus-ring); outline: none; }
  .rq-rail .rq-tasklink { display: flex; }

  /* description = the readable payload */
  .rq-desc { margin-top: var(--v2-space-5); }
  .rq-payload { font-size: var(--v2-fs-body-lg); line-height: 1.6; color: var(--v2-text-2); overflow-wrap: anywhere; }
  .rq-md { margin-top: 0; white-space: pre-wrap; }
  .rq-md p { margin: 0 0 8px; }
  .rq-md p:last-child { margin-bottom: 0; }
  .rq-md ul, .rq-md ol { margin: 4px 0 8px; padding-left: 20px; }
  .rq-md code { font-family: var(--v2-font-mono); font-size: 12px; background: var(--v2-raised); padding: 1px 5px; border-radius: var(--v2-radius-sm); border: 1px solid var(--v2-border); }
  .rq-lead { margin-bottom: var(--v2-space-3); color: var(--v2-text); }
  .rq-kv { display: grid; grid-template-columns: minmax(96px, 140px) minmax(0, 1fr); column-gap: var(--v2-space-4); row-gap: 2px; margin: 0; font-size: var(--v2-fs-body); line-height: 1.5; }
  .rq-kv-row { display: contents; }
  .rq-kv dt, .rq-kv dd { padding: 4px 0; }
  .rq-kv dt { color: var(--v2-text-3); }
  .rq-kv dd { margin: 0; min-width: 0; color: var(--v2-text); }
  .rq-kv-nested { grid-template-columns: minmax(64px, 110px) minmax(0, 1fr); }
  .rq-kv-nested dt, .rq-kv-nested dd { padding: 0 0 2px; }
  .rq-num { font-variant-numeric: tabular-nums; }
  .rq-muted { color: var(--v2-text-3); }
  .rq-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
  .rq-code { margin: 0; padding: var(--v2-space-2) var(--v2-space-3); max-height: 320px; overflow: auto; white-space: pre;
    font-family: var(--v2-font-mono); font-size: 12px; line-height: 1.5; color: var(--v2-text-2);
    background: var(--v2-surface); border: 1px solid var(--v2-border); border-radius: var(--v2-radius-card); }
  .rq-raw { margin-top: var(--v2-space-3); }
  .rq-raw > summary { cursor: pointer; font-size: var(--v2-fs-meta); color: var(--v2-text-3); width: max-content;
    border-radius: var(--v2-radius-sm); padding: 2px 0; }
  .rq-raw > summary:hover { color: var(--v2-text); }
  .rq-raw > summary:focus-visible { box-shadow: var(--v2-focus-ring); outline: none; }
  .rq-raw[open] > summary { margin-bottom: 6px; }

  /* decision card (Linear "Triage" card) */
  .rq-card { margin-top: var(--v2-space-6); padding: var(--v2-space-3) var(--v2-space-4) 14px; background: var(--v2-surface);
    border: 1px solid var(--v2-border); border-radius: var(--v2-radius-panel); box-shadow: var(--v2-shadow-card); }
  .rq-card-h { display: flex; align-items: center; gap: var(--v2-space-2); min-height: 24px; margin-bottom: 10px;
    font-size: var(--v2-fs-body); font-weight: var(--v2-fw-medium); color: var(--v2-text); }
  .rq-card-ico { width: 14px; height: 14px; color: var(--v2-text-2); }
  .rq-card-h .v2-av { flex: none; }
  .rq-card:not(.is-mine) .rq-card-t { font-weight: var(--v2-fw-regular); color: var(--v2-text-2); }
  .rq-help { margin-left: auto; display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: var(--v2-radius-full); color: var(--v2-text-3); cursor: help; }
  .rq-help .v2-ico { width: 14px; height: 14px; }
  .rq-help:hover { color: var(--v2-text-2); background: var(--v2-hover); }
  .rq-help:focus-visible { box-shadow: var(--v2-focus-ring); outline: none; }
  /* answered question: the answer in the card (clamped), Resolve primary */
  .rq-card-when { color: var(--v2-text-3); font-weight: var(--v2-fw-regular); font-size: var(--v2-fs-meta, 12px); font-variant-numeric: tabular-nums; }
  .rq-qa-body { margin: 0 0 var(--v2-space-3); }
  .rq-qa-answer { max-height: 6.2em; overflow: hidden; position: relative; font-size: var(--v2-fs-body); color: var(--v2-text); line-height: 1.55; }
  .rq-qa-answer .rq-payload { margin: 0; }
  .rq-qa-answer:not(.is-open)::after { content: ""; position: absolute; inset: auto 0 0 0; height: 1.6em;
    background: linear-gradient(to bottom, transparent, var(--v2-surface)); pointer-events: none; }
  .rq-qa-answer.is-open { max-height: none; }
  .rq-qa-answer.is-open::after { display: none; }
  .rq-qa-more { margin-top: 6px; }
  .rq-qa-link { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; font: inherit;
    font-size: var(--v2-fs-meta, 12px); color: var(--v2-text-2); cursor: pointer; text-decoration: none; }
  .rq-qa-link:hover { color: var(--v2-text); text-decoration: underline; text-underline-offset: 2px; }
  .rq-qa-link .v2-ico { width: 12px; height: 12px; }
  .rq-qa-link:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); border-radius: 4px; }
  .rq-card.is-resolving { background: transparent; box-shadow: none; display: flex; align-items: center; gap: var(--v2-space-3); padding: 10px 12px 10px var(--v2-space-4); }
  .rq-card.is-resolving .rq-card-h { margin: 0; flex: 1 1 auto; }
  /* where a code-thread question lives: one chip + the anchor (mono path, D15) */
  .rq-src { display: flex; align-items: center; gap: var(--v2-space-2); flex-wrap: wrap; margin-top: var(--v2-space-3); }
  .rq-thread-chip { text-decoration: none; color: var(--v2-text); }
  .rq-thread-chip .v2-ico { width: 12px; height: 12px; color: var(--v2-text-2); }
  .rq-src-path { font-family: var(--v2-font-mono, ui-monospace, monospace); font-size: 11.5px; color: var(--v2-text-3); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  /* portal paths inside request/answer text render as link chips (lib/format.ts) */
  .rq-md .plink, .rq-payload .plink { text-decoration: none; color: var(--v2-text); vertical-align: baseline; }
  .rq-card-kv { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 8px var(--v2-space-3); margin: 0 0 var(--v2-space-3); font-size: var(--v2-fs-body); align-items: center; }
  .rq-card-kv dt { color: var(--v2-text-3); }
  .rq-card-kv dd { margin: 0; min-width: 0; color: var(--v2-text); overflow-wrap: anywhere; }
  .rq-card .rq-raw { margin: 0 0 var(--v2-space-3); }
  .rq-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--v2-space-2); flex-wrap: wrap; }
  .rq-actions .rq-lead-slot { margin-right: auto; }
  .rq-idle { display: flex; align-items: center; gap: var(--v2-space-3); flex-wrap: wrap; font-size: var(--v2-fs-body); color: var(--v2-text-2); }
  .rq-idle .rq-push { margin-left: auto; }
  .rq-card.is-inline { display: flex; align-items: center; flex-wrap: wrap; gap: var(--v2-space-2) var(--v2-space-3); padding: 10px 12px 10px var(--v2-space-4); }
  .rq-card.is-inline .rq-card-h { margin: 0; flex: none; }
  .rq-card.is-inline .rq-help { margin-left: 0; }
  .rq-card.is-inline > .rq-actions, .rq-card.is-inline > .rq-idle { flex: 0 1 auto; margin-left: auto; }
  .rq-card.is-inline:not(.is-mine) { background: transparent; box-shadow: none; }
  .rq-card.is-inline > .rq-idle { flex: 1 1 240px; }
  .rq-card.is-answering { padding: 0; background: transparent; border: 0; box-shadow: none; }
  .rq-card.is-answering .rq-card-h { margin-bottom: var(--v2-space-2); }
  .rq-answer .v2-composer { background: var(--v2-surface); }

  /* sections: chain + activity */
  .rq-sec { margin-top: var(--v2-space-8); }
  /* a task request's proposed task (requests.detail title + definition of done) */
  .rq-proposed { margin-top: var(--v2-space-5); }
  .rq-proposed .rq-card-kv { margin: 0; align-items: start; }
  .rq-proposed-t { display: inline-flex; align-items: center; gap: 6px; font-weight: var(--v2-fw-medium); }
  .rq-proposed-t > svg, .rq-proposed-t > span:first-child { flex: none; }
  /* escalated flow: "lead → backend-dev · ⚑ escalated to you" */
  .rq-esc-to { display: inline-flex; align-items: center; gap: 4px; color: var(--v2-text-2); }
  .rq-esc-to .v2-ico { width: 12px; height: 12px; color: var(--v2-text-3); }
  .rq-h2 { display: flex; align-items: baseline; gap: var(--v2-space-2); margin: 0 0 var(--v2-space-2); font-size: var(--v2-fs-title);
    font-weight: var(--v2-fw-semibold); letter-spacing: var(--v2-ls-title); color: var(--v2-text); }
  .rq-h2-count { font-size: var(--v2-fs-body); font-weight: var(--v2-fw-regular); color: var(--v2-text-3); font-variant-numeric: tabular-nums; }
  .rq-ok, .rq-bad { display: inline-flex; margin-right: 4px; vertical-align: -2px; }
  .rq-ok { color: var(--v2-ok); } .rq-bad { color: var(--v2-danger); }
  .rq-ok .v2-ico, .rq-bad .v2-ico { width: 13px; height: 13px; }
  .rq-sec .v2-tl-card { margin: 6px 0; }
  .rq-sec .v2-tl-msg-body .rq-payload { font-size: var(--v2-fs-body); color: var(--v2-text); }

  /* chain: one line per request, joined by the timeline connector */
  .rq-chain .v2-tl-line { flex: 1; min-width: 0; }
  .rq-cnode { display: flex; align-items: baseline; gap: var(--v2-space-2); width: calc(100% + 12px); min-width: 0; margin: -2px -6px; padding: 2px 6px;
    background: transparent; border: 0; border-radius: var(--v2-radius-control); color: var(--v2-text-2); cursor: pointer; font: inherit; text-align: left; }
  .rq-cnode:hover { background: var(--v2-hover); }
  .rq-cnode.cur { background: var(--v2-selected); }
  .rq-cnode:focus-visible { box-shadow: var(--v2-focus-ring); outline: none; }
  .rq-cnode .ttl { flex: 0 1 auto; min-width: 0; color: var(--v2-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rq-cnode.cur .ttl { font-weight: var(--v2-fw-medium); }
  .rq-cnode .sub { flex: none; font-size: var(--v2-fs-meta); color: var(--v2-text-3); white-space: nowrap; }
  @container (max-width: 520px) {
    .rq-cnode { flex-direction: column; align-items: flex-start; gap: 0; }
    .rq-cnode .ttl { max-width: 100%; }
  }

  /* properties rail */
  .rq-rail .rq-num { margin-left: 2px; }
  .rq-rail .v2-prop-v { font-size: var(--v2-fs-body); }
  .rq-rail .wk-lbl { color: var(--v2-text-3); }
  .rq-expired { color: var(--v2-danger); }
  .rq-soon { color: var(--v2-warn); }
  /* ID shown once (host header): text + copy icon on hover / focus (same as Needs you) */
  .rq-id { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px; margin: 0 -4px; border: 0; border-radius: 4px;
    background: none; cursor: pointer; font: inherit; font-size: var(--v2-fs-meta); color: var(--v2-text-3); font-variant-numeric: tabular-nums; }
  .rq-id .wk-id { font-size: var(--v2-fs-meta); font-weight: var(--v2-fw-regular); color: inherit; letter-spacing: 0.01em; }
  .rq-id:hover { color: var(--v2-text); background: var(--v2-hover); }
  .rq-id .rq-id-copy { width: 12px; height: 12px; opacity: 0; transition: opacity 120ms; }
  .rq-id:hover .rq-id-copy, .rq-id:focus-visible .rq-id-copy { opacity: 1; }
  @media (hover: none) { .rq-id .rq-id-copy { opacity: .7; } }
  .rq-id:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  .rq-syncing { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }

  /* status tones (text labels) */
  .rq-tone-ok { color: var(--v2-ok); } .rq-tone-warn { color: var(--v2-warn); } .rq-tone-danger { color: var(--v2-danger); }
  .rq-tone-info { color: var(--v2-info); } .rq-tone-accent { color: var(--v2-accent); } .rq-tone-neutral { color: var(--v2-text-2); }

  @media (max-width: 560px) {
    .rq-kv { grid-template-columns: 96px minmax(0, 1fr); column-gap: var(--v2-space-3); }
    .rq-card-kv { grid-template-columns: 96px minmax(0, 1fr); }
    .rq-actions { justify-content: flex-start; }
    .rq-actions > .v2-btn { flex: 0 0 auto; }
    /* roster suggestion: ⋯ + Reassign + Create stay together, right-aligned (primary last) */
    .rq-actions.rq-sugg-acts { justify-content: flex-end; }
  }
  @media (max-width: 480px) {
    /* label over value (the Needs gate card rule) — "Proposed agent" never wraps into its value */
    .rq-card-kv { grid-template-columns: minmax(0, 1fr); row-gap: 2px; }
    .rq-card-kv dd + dt { margin-top: var(--v2-space-2); }
    /* the three suggestion actions fit one line at 390 ("Reassign…" — full name in aria-label) */
    .rq-sugg-acts .rq-wide-only { display: none; }
  }
`;

export const listCss = `
  /* D5 panel: the page fills the panel below the shell header; list and
     detail scroll on their own (flush — no page box). Like Needs you, the list
     column owns its head (pills + circular tools) and the detail header sits
     level with it at the top of the panel (Linear Inbox, image 12). */
  .rq-page { display: flex; flex-direction: column; height: var(--v2-content-h, calc(100dvh - 60px)); min-height: 320px; }
  .rq-page > .v2-split { flex: 1; min-height: 0; }
  .rq-page .v2-split-list { flex: 1 1 0; min-width: 300px; background: transparent; }
  .rq-page .v2-split-inspector { flex: 0 1 var(--v2-inspector-w); width: auto; min-width: 0; background: transparent; }
  .rq-page .v2-split-handle { background: var(--v2-border-subtle); }
  /* keyboard focus belongs to rows, never a ring around the whole list / pane */
  .rq-page .v2-list:focus-visible, .rq-page .v2-split-list:focus-visible, .rq-page .v2-split-inspector:focus-visible,
  .rq-page .v2-list:focus, .rq-page .v2-split-list:focus { outline: none; box-shadow: none; }

  .rq-listhead-wrap { position: sticky; top: 0; z-index: 3; background: var(--v2-panel, var(--v2-canvas));
    border-bottom: 1px solid var(--v2-border-subtle); }
  .rq-listhead { display: flex; align-items: center; gap: 6px; height: var(--v2-pillbar-h, 44px); padding: 0 var(--v2-space-3); }
  .rq-listhead .v2-pills { min-width: 0; flex: 0 1 auto; }
  /* r2: four pills + counts must fit the ~465px list column beside the three circular tools
     (the "To a human N" count was clipped by 16px) — slightly tighter pills, same 24px height */
  .rq-listhead .v2-pills { gap: 4px; }
  .rq-listhead .v2-pills-sm .v2-pill { padding: 0 8px; }
  .rq-listhead > .v2-iconbtn, .rq-listhead > .v2-btn { flex: none; }
  .rq-searchrow { padding: 0 var(--v2-space-3) var(--v2-space-2); }
  .rq-listbody { padding: 6px 8px 16px; }
  /* the shared centred EmptyState (same as Needs you / Activity) */
  .rq-empty { padding: var(--v2-space-8) var(--v2-space-5); }
  .rq-empty.is-none { padding-top: clamp(48px, 14vh, 140px); }

  /* inbox items: two lines, round avatar left, glyph + age right */
  .rq-list .v2-list { display: flex; flex-direction: column; gap: 1px; }
  .rq-page .rq-row.v2-row { min-height: 56px; padding: 8px 10px; gap: var(--v2-space-3); border-radius: var(--v2-radius-card); border-bottom: 0; }
  .rq-page .rq-row.v2-row.is-selected::before { display: none; }
  /* row focus (keyboard / after closing the detail): a quiet inset ring, not a 2px accent box */
  .rq-page .rq-row.v2-row:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--v2-border-strong); background: var(--v2-hover); }
  .rq-row .rq-av { flex: none; display: inline-flex; --v2-av-ring: var(--v2-panel); }
  .rq-row .wk-main { gap: 2px; }
  .rq-row .rq-l1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .rq-row .rq-title { font-weight: var(--v2-fw-medium); color: var(--v2-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .rq-row .rq-meta { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: var(--v2-fs-body); color: var(--v2-text-3);
    white-space: nowrap; overflow: hidden; }
  .rq-row .rq-meta > * { flex: none; }
  .rq-row .rq-meta .rq-party { flex: 0 0 auto; max-width: 72%; overflow: hidden; text-overflow: ellipsis; }
  .rq-row .rq-meta .rq-trail { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .rq-row .rq-rowst { display: inline-flex; }
  .rq-row .rq-side { flex: none; align-self: stretch; display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 4px; min-width: 32px; }
  .rq-row .rq-age { font-size: var(--v2-fs-meta); color: var(--v2-text-3); font-variant-numeric: tabular-nums; }
  /* list-only state (detail closed): keep Linear's inbox width instead of 1170px rows */
  .rq-page:not(.has-detail):not(.is-empty) .rq-listbody { max-width: 760px; }
  .rq-page:not(.has-detail) .rq-searchrow { max-width: 760px; }
  /* …and the pills + search / filter / sort stay beside the list, not 400px away at the panel edge */
  .rq-page:not(.has-detail):not(.is-empty) .rq-listhead { max-width: 760px; }
  .rq-listfoot { display: flex; align-items: center; gap: var(--v2-space-2); padding: var(--v2-space-3) 10px; font-size: var(--v2-fs-meta); color: var(--v2-text-3); }

  /* toolbar end: compact rounded search */
  .rq-search { display: flex; align-items: center; gap: 6px; height: 28px; width: 100%; padding: 0 10px;
    border: 1px solid var(--v2-border-strong); border-radius: var(--v2-radius-full); color: var(--v2-text-3);
    transition: width var(--v2-dur-fast, 120ms) var(--v2-ease, ease), border-color var(--v2-dur-fast, 120ms); }
  .rq-search:focus-within { border-color: var(--v2-accent); box-shadow: var(--v2-focus-ring); }
  .rq-search .v2-ico { width: 14px; height: 14px; flex: none; }
  .rq-search input { flex: 1; min-width: 0; height: 100%; padding: 0; background: transparent; border: 0; outline: none;
    color: var(--v2-text); font: inherit; font-size: var(--v2-fs-body); }
  .rq-search input:focus, .rq-search input:focus-visible { outline: none; box-shadow: none; }
  .rq-search input::placeholder { color: var(--v2-text-3); }
  .rq-search input::-webkit-search-cancel-button { filter: grayscale(1) opacity(0.6); }

  /* detail pane: Linear issue — 44px bar, Display title, content column */
  .rq-pane { display: flex; flex-direction: column; min-height: 100%; }
  .rq-bar.v2-pagehead { position: sticky; top: 0; z-index: 3; flex: none; gap: 8px;
    height: var(--v2-pillbar-h, 44px); padding: 0 var(--v2-space-3) 0 var(--v2-space-5, 24px); background: var(--v2-panel, var(--v2-canvas));
    border-bottom: 1px solid var(--v2-border-subtle); }
  .rq-bar .v2-pagehead-id { font-size: var(--v2-fs-meta); }
  .rq-bar .v2-pagehead-title { color: var(--v2-text-2); }
  .rq-bar .v2-pagehead-actions { gap: 6px; }
  .rq-bar .v2-pager { margin-left: 6px; }
  .rq-scroll { width: 100%; max-width: 1080px; margin: 0 auto; padding: var(--v2-space-8) clamp(16px, 4%, 48px) var(--v2-space-12); }
  .rq-dtitle.wk-dtitle { margin: 0 0 var(--v2-space-3); font-size: var(--v2-fs-display); font-weight: var(--v2-fw-semibold);
    line-height: var(--v2-lh-tight); letter-spacing: var(--v2-ls-display); font-variation-settings: "opsz" 32;
    display: block; -webkit-line-clamp: unset; overflow: visible; }

  @media (max-width: 900px) {
    /* the page (not the panes) scrolls; the bar sticks under the sticky header */
    .rq-page { height: auto; min-height: 0; }
    .rq-listhead-wrap, .rq-bar.v2-pagehead { top: var(--v2-sticky-top, 0px); }
    .rq-page .v2-split { height: auto; }
    .rq-page .v2-split-list, .rq-page .v2-split-inspector { overflow: visible; }
    .rq-page .v2-split-inspector { flex: 1 1 auto; width: 100%; }
    .rq-page .v2-split-list { min-width: 0; }
    .rq-bar.v2-pagehead { padding-left: var(--v2-space-3); }
    .rq-scroll { padding: var(--v2-space-5) var(--v2-space-4) var(--v2-space-10); }
    .rq-dtitle.wk-dtitle { font-size: 20px; }
    .rq-listbody { padding: 4px 6px 16px; }
  }
  @media (pointer: coarse) {
    .rq-page .rq-row.v2-row { min-height: 60px; }
    .rq-help { width: 44px; height: 44px; margin-right: -11px; }
  }
`;
