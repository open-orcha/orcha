/**
 * V2 page styles shared by the Tasks, Requests and Needs-you screens (owner: D).
 * Tokens only (--v2-*, docs/orcha-v2-design-system.md §1) — no ad-hoc colours,
 * gradients or glow. Colour is reserved for status and interaction; every
 * status also carries its exact label (StatusDot).
 *
 * Fix round 1 (D1–D4): the list + inspector sit flush on the canvas separated
 * by hairlines (no card-in-card), rows are neutral (no coloured left stripes —
 * status/kind is a small glyph + muted label), controls are compact 28 px
 * (hit area grows on coarse pointers, not the visual), authored text renders
 * as markdown, and sticky bars clear the app header + project tab bar.
 *
 * The legacy `tasksPageCss` (pageCss.ts) still styles the carried-over
 * protocol panel, thread attachments and lightbox; it renders in V2 colours
 * through B's legacy-variable mapping.
 */
export const workCss = String.raw`
  /* D5 frame: the shell owns the sticky offset (0 inside the scrolling panel,
     the header block height on narrow layouts where the document scrolls) */
  :root { --wk-sticky-top: var(--v2-sticky-top, 0px); }
  .wk-page { display: flex; flex-direction: column; min-height: 420px;
    height: calc(100dvh - var(--wk-sticky-top) - 40px);
    border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control);
    background: var(--v2-canvas); overflow: hidden; }
  .wk-page > .v2-toolbar { flex: none; background: var(--v2-canvas); }
  .wk-page > .v2-split, .wk-page > .wk-boardwrap { flex: 1; min-height: 0; }
  .wk-page .v2-split-list { background: var(--v2-canvas); }
  .wk-page .v2-split-inspector { background: var(--v2-canvas); border-left: 0; }
  .wk-page .v2-inspector-h { position: sticky; top: 0; z-index: 2; background: var(--v2-canvas);
    display: flex; align-items: flex-start; gap: var(--v2-space-2); padding: var(--v2-space-3) var(--v2-space-4);
    border-bottom: 1px solid var(--v2-border); }
  .wk-full { max-width: 980px; }
  .wk-full .wk-back { margin: 0 0 var(--v2-space-2) calc(-1 * var(--v2-space-2)); }
  .wk-full .v2-inspector { border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control); background: var(--v2-canvas); }
  .wk-full .v2-inspector-h { padding: var(--v2-space-4); border-bottom: 1px solid var(--v2-border); }
  .wk-boardwrap { overflow: auto; }
  .wk-backbar { flex: none; padding: var(--v2-space-2) var(--v2-space-2) 0; }

  /* ---- toolbar controls --------------------------------------------------- */
  .wk-input, .wk-select, .wk-textarea {
    background: var(--v2-surface); color: var(--v2-text); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-control); font: inherit; font-size: 13px; outline: none; }
  .wk-input:hover, .wk-select:hover, .wk-textarea:hover { border-color: var(--v2-border-strong); }
  .wk-input, .wk-select { height: 28px; padding: 0 var(--v2-space-2); }
  .wk-textarea { width: 100%; min-height: 72px; padding: var(--v2-space-2) var(--v2-space-3); resize: vertical; line-height: 1.5; }
  .wk-input:focus-visible, .wk-select:focus-visible, .wk-textarea:focus-visible { box-shadow: var(--v2-focus-ring); border-color: var(--v2-accent); }
  .wk-searchbox { position: relative; display: inline-flex; align-items: center; min-width: 0; }
  .wk-searchbox > .v2-ico { position: absolute; left: 8px; width: 14px; height: 14px; color: var(--v2-text-3); pointer-events: none; }
  .wk-search { width: 240px; max-width: 100%; }
  .wk-searchbox .wk-search { padding-left: 28px; }
  .wk-popbtn .wk-popbtn-n { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; margin-left: 4px;
    border-radius: 8px; background: var(--v2-accent-soft, var(--v2-selected)); color: var(--v2-text); font-size: 11px; font-variant-numeric: tabular-nums; }
  .wk-popbtn.is-on { color: var(--v2-text); background: var(--v2-selected); }
  .wk-filtercount { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .wk-pop { min-width: 232px; max-width: min(320px, calc(100vw - 16px)); max-height: min(70vh, 520px); overflow: auto; padding: 4px; }
  .wk-pop-sec { border: 0; margin: 0; padding: 2px 0 4px; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .wk-pop-sec + .wk-pop-sec { border-top: 1px solid var(--v2-border); padding-top: 4px; }
  .wk-pop-h { padding: 6px 8px 2px; font-size: 11.5px; font-weight: var(--v2-fw-medium); color: var(--v2-text-3); }
  .wk-pop-opt { gap: 8px; cursor: pointer; }
  .wk-pop-opt input { margin: 0; accent-color: var(--v2-accent); }
  .wk-pop-ico { width: 12px; flex: none; }
  .wk-pop-sec > .v2-btn { align-self: flex-start; margin: 2px 6px; }
  /* legacy segmented control (Needs-you Waiting/History) — sized to content */
  .wk-seg { display: inline-flex; flex: none; align-self: flex-start; width: auto; max-width: 100%; overflow-x: auto;
    border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control); background: var(--v2-surface); padding: 2px; gap: 2px; }
  .wk-seg button { height: 22px; padding: 0 var(--v2-space-2); border: 0; border-radius: 4px; background: transparent;
    color: var(--v2-text-2); font: inherit; font-size: 12.5px; font-weight: var(--v2-fw-medium); cursor: pointer; white-space: nowrap; }
  .wk-seg button[aria-pressed="true"], .wk-seg button[aria-selected="true"] { background: var(--v2-selected); color: var(--v2-text); }
  .wk-seg button:focus-visible { box-shadow: inset var(--v2-focus-ring); }
  .wk-lbl { font-size: var(--v2-fs-meta); color: var(--v2-text-3); }
  .wk-chipbtn { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 var(--v2-space-2);
    border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control); background: var(--v2-surface);
    color: var(--v2-text-2); font: inherit; font-size: 13px; font-weight: var(--v2-fw-medium); cursor: pointer; }
  .wk-chipbtn.is-on { color: var(--v2-text); background: var(--v2-selected); }
  .wk-chipbtn:focus-visible { box-shadow: var(--v2-focus-ring); }
  .wk-note { flex: none; padding: 6px var(--v2-space-4); font-size: var(--v2-fs-meta); color: var(--v2-text-2);
    border-bottom: 1px solid var(--v2-border); background: var(--v2-surface); }
  .wk-note b { color: var(--v2-text); font-weight: var(--v2-fw-semibold); }

  /* ---- grouped dense list ------------------------------------------------- */
  .wk-grp { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: var(--v2-space-2);
    height: 32px; padding: 0 var(--v2-space-4); font-size: 12.5px; font-weight: var(--v2-fw-medium); color: var(--v2-text-2);
    background: var(--v2-surface); border-bottom: 1px solid var(--v2-border); }
  .wk-grp .v2-count { margin-left: 2px; color: var(--v2-text-3); }
  .wk-row.v2-row { align-items: center; padding-top: 6px; padding-bottom: 6px; gap: var(--v2-space-3); min-height: 48px;
    border-bottom: 1px solid var(--v2-border); }
  .wk-row.v2-row.is-compact { min-height: 36px; padding-top: 0; padding-bottom: 0; }
  .wk-row .wk-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .wk-row .wk-t { display: flex; align-items: center; gap: var(--v2-space-2); min-width: 0; }
  .wk-row .wk-title { font-weight: var(--v2-fw-medium); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .wk-row .wk-sub { font-size: var(--v2-fs-meta); color: var(--v2-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wk-row .wk-side { display: flex; align-items: center; gap: var(--v2-space-3); flex: none; font-size: var(--v2-fs-meta); color: var(--v2-text-2); }
  .wk-statuslbl { color: var(--v2-text-2); white-space: nowrap; }
  .wk-who { display: inline-flex; align-items: center; gap: 6px; max-width: 150px; min-width: 0; white-space: nowrap; color: var(--v2-text-2); }
  .wk-who .wk-who-n { overflow: hidden; text-overflow: ellipsis; }
  .wk-who.is-none { color: var(--v2-text-3); }
  .wk-avstack { display: inline-flex; align-items: center; flex: none; }
  .wk-avstack .av { flex: none; box-shadow: 0 0 0 2px var(--v2-canvas); }
  .wk-avstack .av + .av { margin-left: -6px; }
  .wk-avmore { margin-left: 3px; font-size: 11px; color: var(--v2-text-3); font-variant-numeric: tabular-nums; }
  .wk-av-empty { width: 18px; height: 18px; flex: none; border-radius: 50%; border: 1px dashed var(--v2-border-strong); }
  .wk-prio { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; color: var(--v2-text-2); font-size: var(--v2-fs-meta); }
  .wk-prio .wk-pico { width: 14px; height: 14px; flex: none; }
  .wk-prio.is-urgent { color: var(--v2-warn); }
  .wk-prio.is-high { color: var(--v2-text); }
  .wk-prio.is-low { color: var(--v2-text-3); }
  .wk-id { font-family: inherit; font-variant-numeric: tabular-nums; font-size: 12px; color: var(--v2-text-3); } /* Linear: IDs in Inter, even-width digits */
  .wk-more { display: flex; width: calc(100% - 2 * var(--v2-space-4)); margin: var(--v2-space-3) var(--v2-space-4); justify-content: center; }
  .wk-empty-list { padding: var(--v2-space-6) var(--v2-space-4); color: var(--v2-text-2); text-align: center; }

  /* ---- board (read-only status view) -------------------------------------- */
  .wk-boardview { display: flex; flex-direction: column; min-height: 100%; }
  .wk-board-note { display: flex; align-items: center; gap: 6px; padding: 8px var(--v2-space-4); font-size: var(--v2-fs-meta); color: var(--v2-text-3); }
  .wk-board-note .v2-ico { width: 13px; height: 13px; flex: none; }
  .wk-board { display: flex; gap: var(--v2-space-3); padding: 0 var(--v2-space-4) var(--v2-space-4); overflow-x: auto; align-items: flex-start;
    scroll-snap-type: x proximity; scroll-padding-left: var(--v2-space-4); outline: none;
    /* scroll shadows: the cover gradients scroll with content, the shade stays — edges darken only when more is off-screen */
    background:
      linear-gradient(to right, var(--v2-canvas) 40%, transparent) left center / 32px 100% no-repeat local,
      linear-gradient(to left, var(--v2-canvas) 40%, transparent) right center / 32px 100% no-repeat local,
      linear-gradient(to right, var(--v2-scroll-shadow), transparent) left center / 14px 100% no-repeat scroll,
      linear-gradient(to left, var(--v2-scroll-shadow), transparent) right center / 14px 100% no-repeat scroll;
    background-color: var(--v2-canvas); }
  .wk-board:focus-visible { box-shadow: inset var(--v2-focus-ring); }
  .wk-col { flex: 0 0 272px; display: flex; flex-direction: column; gap: 6px; scroll-snap-align: start; min-width: 0; }
  .wk-col-h { display: flex; align-items: center; gap: var(--v2-space-2); height: 32px; font-size: 12.5px; font-weight: var(--v2-fw-medium); color: var(--v2-text-2); padding: 0 2px; }
  .wk-col-h .v2-count { color: var(--v2-text-3); }
  .wk-card { display: flex; flex-direction: column; gap: 8px; padding: 10px var(--v2-space-3); text-align: left;
    background: var(--v2-surface); border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control);
    color: var(--v2-text); font: inherit; font-size: 13px; cursor: pointer; }
  .wk-card:hover { background: var(--v2-hover); border-color: var(--v2-border-strong); }
  .wk-card.is-selected { background: var(--v2-selected); border-color: var(--v2-border-strong); }
  .wk-card:focus-visible { box-shadow: var(--v2-focus-ring); }
  .wk-card .wk-title { font-weight: var(--v2-fw-medium); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .wk-card .wk-cm { display: flex; align-items: center; gap: var(--v2-space-2); font-size: var(--v2-fs-meta); color: var(--v2-text-2); }

  /* ---- detail ------------------------------------------------------------- */
  .wk-dtitle { margin: 0; font-size: 17px; font-weight: var(--v2-fw-semibold); line-height: 1.35; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .wk-dmeta { display: flex; align-items: center; gap: var(--v2-space-3); flex-wrap: wrap; margin-top: 6px; font-size: var(--v2-fs-meta); color: var(--v2-text-2); }
  .wk-section { padding: var(--v2-space-4) 0; border-bottom: 1px solid var(--v2-border); }
  .wk-section:last-child { border-bottom: 0; }
  .wk-h { display: flex; align-items: center; gap: var(--v2-space-2); margin: 0 0 var(--v2-space-2); font-size: 13px;
    font-weight: var(--v2-fw-semibold); color: var(--v2-text); flex-wrap: wrap; }
  .wk-h .wk-hint { font-weight: var(--v2-fw-regular); color: var(--v2-text-3); font-size: var(--v2-fs-meta); margin-left: auto; }
  .wk-text { font-size: 13.5px; line-height: 1.6; color: var(--v2-text); overflow-wrap: anywhere; }
  .wk-text.is-muted { color: var(--v2-text-2); }
  .wk-fields { display: grid; grid-template-columns: 120px 1fr; gap: 8px var(--v2-space-3); margin: 0; font-size: 13px; align-items: baseline; }
  .wk-fields dt { color: var(--v2-text-3); }
  .wk-fields dd { margin: 0; min-width: 0; overflow-wrap: anywhere; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .wk-fields dd.wk-dd-list { flex-direction: column; align-items: flex-start; gap: 4px; }
  .wk-fields .dlink { display: inline-flex; align-items: center; gap: 6px; color: var(--v2-text); text-decoration: none; }
  .wk-fields .dlink:hover { text-decoration: underline; text-underline-offset: 2px; }
  .wk-rel { display: block; line-height: 1.5; }
  .wk-rel > .v2-status { display: inline-flex; vertical-align: -2px; margin-right: 6px; }
  .wk-rel > .wk-lbl { margin-left: 6px; }
  .wk-fields .wk-rel .dlink { display: inline; }
  .wk-actions { display: flex; align-items: center; gap: var(--v2-space-2); flex-wrap: wrap; margin-top: var(--v2-space-3); }
  .wk-actions .wk-conseq { font-size: var(--v2-fs-meta); color: var(--v2-text-3); }
  .wk-err { margin-top: var(--v2-space-2); padding: var(--v2-space-2) var(--v2-space-3); border-radius: var(--v2-radius-control);
    background: var(--v2-danger-soft); color: var(--v2-text); font-size: 13px; }
  .wk-err b { color: var(--v2-danger); }
  .wk-tabs-wrap { background: var(--v2-canvas); }
  .wk-tabpanel[hidden] { display: none; }
  .wk-reason-lbl { display: block; margin-bottom: 6px; font-size: 12.5px; font-weight: var(--v2-fw-medium); color: var(--v2-text-2); }
  .wk-cancel .wk-lbl { margin: 0 0 var(--v2-space-2); max-width: 64ch; line-height: 1.5; }
  .wk-disclosure > summary { list-style: none; cursor: pointer; width: max-content; max-width: 100%; }
  .wk-disclosure > summary::-webkit-details-marker { display: none; }
  .wk-disclosure > summary .v2-muted { font-weight: var(--v2-fw-regular); }
  .wk-disclosure .wk-md { margin-top: var(--v2-space-2); }
  .wk-disc-chev { width: 14px; height: 14px; transform: rotate(-90deg); transition: transform var(--v2-dur-fast, .12s) ease; }
  details[open] > summary .wk-disc-chev { transform: none; }
  .wk-proto-empty-b { display: flex; align-items: center; justify-content: space-between; gap: var(--v2-space-3); flex-wrap: wrap; font-size: 13px; }

  /* ---- rendered markdown (lib/format mdText → <Md className="wk-md">) ------
     mdText keeps source newlines; pre-line turns them into breaks, so headings
     and list items stay inline boxes (a block box + newline would double-space). */
  .wk-md { white-space: pre-line; overflow-wrap: anywhere; line-height: 1.6; }
  .wk-md .md-h { font-weight: var(--v2-fw-semibold); color: var(--v2-text); }
  .wk-md .md-li { display: inline-block; position: relative; padding-left: 16px; }
  .wk-md .md-li::before { content: ""; position: absolute; left: 5px; top: .72em; width: 4px; height: 4px; border-radius: 50%; background: var(--v2-text-3); }
  .wk-md .md-li.md-task { padding-left: 4px; }
  /* numbered steps hang: a wrapped line starts under the text, never under the number */
  .wk-md .md-li.md-oli, .wk-md .md-li.md-oli.md-oli { padding-left: 24px; }
  .wk-md .md-oli > .md-num { position: absolute; left: 0; top: 0; width: 20px; min-width: 0; margin: 0; text-align: right; }
  .wk-md .md-li.md-oli::before, .wk-md .md-li.md-task::before { content: none; }
  .wk-md .md-num { color: var(--v2-text-3); margin-right: 6px; font-variant-numeric: tabular-nums; }
  .wk-md .md-cb { display: inline-block; width: 11px; height: 11px; margin-right: 6px; border: 1px solid var(--v2-border-strong); border-radius: 3px; vertical-align: -1px; }
  .wk-md .md-cb.on { background: var(--v2-accent); border-color: var(--v2-accent); }
  .wk-md .md-code { font-family: var(--v2-font-mono); font-size: 12px; padding: 1px 4px; border-radius: 4px; background: var(--v2-raised); border: 1px solid var(--v2-border); }
  .wk-md .md-pre { display: block; margin: 4px 0; padding: 8px 10px; border-radius: var(--v2-radius-control); background: var(--v2-surface);
    border: 1px solid var(--v2-border); overflow: auto; max-height: 320px; white-space: pre; }
  .wk-md .md-pre code { font-family: var(--v2-font-mono); font-size: 12px; }
  .wk-md .md-table { display: block; overflow-x: auto; border-collapse: collapse; font-size: 12.5px; white-space: normal; }
  .wk-md .md-table th, .wk-md .md-table td { border: 1px solid var(--v2-border); padding: 4px 8px; text-align: left; }
  .wk-md .lnk, .wk-md .tref { color: var(--v2-accent); text-decoration: none; }
  .wk-md .lnk:hover, .wk-md .tref:hover { text-decoration: underline; }
  .wk-clamp { position: relative; }
  .wk-clamp.is-clamped > .wk-md { max-height: 260px; overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent); mask-image: linear-gradient(to bottom, #000 72%, transparent); }
  .wk-clamp-btn { margin-top: 4px; }
  .wk-payload { font-size: 13.5px; }
  /* result summary with its PR chip IN the sentence ("Implemented…; ⟟ #102 opened.") */
  .td-result-line { font-weight: inherit; line-height: 1.55; }
  .td-result-line .v2-prchip { vertical-align: -3px; margin: 0 2px; }

  /* ---- primary gate (plan / verification) — the compact Linear card (D10/D12):
     title line, two short labeled lines (result/plan + done-when), evidence as
     one line, Reject / Accept right-aligned. No uppercase labels, no heavy box. */
  .wk-gate { margin: 0; border: 1px solid var(--v2-border); border-radius: var(--v2-radius-card, 8px);
    background: var(--v2-surface); box-shadow: var(--v2-shadow-card, none); }
  .wk-gate-h { display: flex; align-items: center; gap: var(--v2-space-2); min-height: 40px; padding: 6px var(--v2-space-2) 0 var(--v2-space-4); }
  .wk-gate-t { font-weight: var(--v2-fw-medium); display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--v2-text); white-space: nowrap; }
  .td-g-ico { display: inline-flex; flex: none; color: var(--v2-warn); }
  .td-g-ico .v2-ico { width: 14px; height: 14px; }
  .td-g-by { min-width: 0; font-size: 13px; color: var(--v2-text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .td-g-help { flex: none; color: var(--v2-text-3); }
  .td-g-rows { display: flex; flex-direction: column; gap: 6px; padding: 6px var(--v2-space-4) 0; }
  .td-g-row { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: var(--v2-space-3); align-items: baseline; min-width: 0; }
  /* labels sit on the FIRST line of their value (a long plan list never centres them) */
  .td-g-k { align-self: start; font-size: 12.5px; line-height: 20px; color: var(--v2-text-3); white-space: nowrap; }
  .td-g-v { min-width: 0; font-size: 13px; line-height: 1.55; color: var(--v2-text); overflow-wrap: anywhere; }
  .td-g-v .wk-md, .td-g-v .wk-payload { font-size: 13px; }
  .wk-gate .tx, .wk-gate .dod { font-size: 13px; line-height: 1.55; color: var(--v2-text); overflow-wrap: anywhere; }
  .wk-gate .dod { border: 0; padding: 0; background: none; } /* D3: no legacy accent stripe (overlays.css .dod) */
  /* gate evidence: ONE "·"-joined line ("✓ Completed · exit 0 · 42m ago · 3 runs · Open runs").
     Lives HERE (workCss), not detailCss: the gate also renders on Needs you,
     which injects only workCss. */
  .td-ev-line { display: flex; flex-wrap: wrap; align-items: center; column-gap: 0; row-gap: 2px; min-width: 0; line-height: 20px; font-size: 13px; }
  .td-ev-line .v2-si-wrap.has-label { display: inline-flex; align-items: center; gap: 6px; color: var(--v2-text-2); }
  .td-ev-part { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .td-ev-part + .td-ev-part::before { content: "·"; margin-left: 6px; color: var(--v2-text-3); } /* + the part's 6 px gap */
  .td-ev-status { color: var(--v2-text); }
  .td-ev-line .td-ev-link.v2-btn { height: 20px; padding: 0; margin-left: 10px; }
  /* the accent link needs no "·" — and never leaves one orphaned at a wrap */
  .td-ev-part + .td-ev-link::before { content: none; }
  /* VD-06: "Open runs" keeps its 20px visual line but gets a 44px tap area on touch */
  @media (pointer: coarse) {
    .td-ev-line .td-ev-link { position: relative; }
    .td-ev-line .td-ev-link::after { content: ""; position: absolute; left: 50%; top: 50%; width: max(100%, 44px); height: 44px; transform: translate(-50%, -50%); }
    /* the gate's sticky action row (z-index 2) sits right under the evidence
       line and would swallow the lower half of that tap area — leave room */
    .td-ev-line:has(.td-ev-link) { padding-bottom: 12px; }
  }
  .wk-evidence-diff { margin-top: 4px; }
  .wk-evidence-diff > summary { list-style: none; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: var(--v2-text-2); }
  .wk-evidence-diff > summary::-webkit-details-marker { display: none; }
  .wk-evidence-diff > summary:hover { color: var(--v2-text); }
  .wk-gate .wk-actions.actions, .td-g-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--v2-space-2);
    margin: 0; padding: var(--v2-space-3) var(--v2-space-3) var(--v2-space-3) var(--v2-space-4); flex-wrap: wrap; }
  .td-g-actions [data-act="reject"][aria-expanded="true"] { background: var(--v2-selected); color: var(--v2-text); }
  .td-g-why { flex: 1; min-width: 160px; font-size: var(--v2-fs-meta); color: var(--v2-text-3); }
  .wk-gate > .wk-err { margin: 0 var(--v2-space-4) var(--v2-space-3); }
  .wk-gate .reason { display: none; padding: var(--v2-space-3) var(--v2-space-4) 0; border-top: 1px solid var(--v2-border); scroll-margin-bottom: 72px; }
  .wk-gate .reason.show { display: block; }
  .wk-gate .reason .td-g-actions { padding: var(--v2-space-2) 0 var(--v2-space-3); }
  .wk-gate .reason textarea { width: 100%; min-height: 72px; background: var(--v2-canvas); color: var(--v2-text);
    border: 1px solid var(--v2-border-strong); border-radius: var(--v2-radius-control); padding: var(--v2-space-2) var(--v2-space-3);
    font: inherit; font-size: 13px; line-height: 1.5; resize: vertical; outline: none; }
  .wk-gate .reason textarea:focus-visible { box-shadow: var(--v2-focus-ring); border-color: var(--v2-accent); }
  .wk-gate-compact { display: flex; align-items: center; gap: var(--v2-space-2); flex-wrap: wrap; padding: 8px var(--v2-space-3); }
  .wk-gate-compact .wk-gate-sub { font-size: var(--v2-fs-meta); color: var(--v2-text-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wk-caveat { font-size: var(--v2-fs-meta); color: var(--v2-text-2); }
  .wk-decided { display: flex; align-items: center; gap: var(--v2-space-2); margin: 0; padding: 8px var(--v2-space-3);
    border: 1px solid var(--v2-border); border-radius: var(--v2-radius-card, 8px); font-size: 13px; }
  .wk-decided .v2-ico { width: 14px; height: 14px; }
  .wk-decided .wk-dt { font-weight: var(--v2-fw-medium); }
  .wk-decided .wk-dm { color: var(--v2-text-3); }
  .wk-ok { color: var(--v2-ok); } .wk-bad { color: var(--v2-danger); }

  /* ---- runs, thread, proto inside the V2 detail --------------------------- */
  .wk-page .proto, .wk-full .proto { border: 0; border-radius: 0; box-shadow: none; background: transparent; margin-bottom: 0; }
  .wk-page .proto > .ph, .wk-full .proto > .ph { padding: 0 0 var(--v2-space-2); border-bottom: 0; }
  .wk-page .proto .pb, .wk-full .proto .pb { padding: 0; }
  .wk-page .proto .pf, .wk-full .proto .pf { padding: var(--v2-space-2) 0 0; }
  .wk-thread .thread { display: flex; flex-direction: column; gap: var(--v2-space-3); }
  .wk-thread .msg .bubble.wk-md { white-space: pre-line; }
  .wk-runs .run { border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control); margin-bottom: var(--v2-space-3); background: var(--v2-surface); overflow: hidden; }
  .wk-runs .run-h { display: flex; align-items: center; gap: var(--v2-space-2); flex-wrap: wrap; padding: 8px var(--v2-space-3); font-size: 13px; }
  .wk-runs .run-h .when { margin-left: auto; color: var(--v2-text-3); font-size: 11.5px; font-family: var(--v2-font-mono); }
  .wk-run-sec > summary { list-style: none; display: flex; align-items: center; gap: 6px; padding: 6px var(--v2-space-3); cursor: pointer;
    font-size: 12.5px; font-weight: var(--v2-fw-medium); color: var(--v2-text-2); border-top: 1px solid var(--v2-border); }
  .wk-run-sec > summary::-webkit-details-marker { display: none; }
  .wk-run-sec > summary:hover { color: var(--v2-text); background: var(--v2-hover); }
  .wk-run-sec-b { padding: 0 var(--v2-space-3) var(--v2-space-3); }
  .wk-runs .log .ln.ln { border-left-color: transparent; grid-template-columns: 14px auto 1fr; }
  .wk-runs .log .ln.is-plain { grid-template-columns: 14px 1fr; }
  .wk-runs .log .ln .ty { font-weight: var(--v2-fw-medium); letter-spacing: 0; text-transform: none; font-size: 11px; }
  /* tool input / output behind a "Details" disclosure (D4 — never raw JSON inline) */
  .wk-runs .log .det-x { margin-top: 2px; }
  .wk-runs .log .det-x > summary { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; list-style: none; width: max-content;
    color: var(--v2-text-2); font-family: var(--v2-font-sans); font-size: 11.5px; font-weight: var(--v2-fw-medium); padding: 1px 6px; margin-left: -6px; border-radius: 4px; }
  .wk-runs .log .det-x > summary::-webkit-details-marker { display: none; }
  .wk-runs .log .det-x > summary::before { content: "▸"; font-size: 10px; color: var(--v2-text-3); }
  .wk-runs .log .det-x[open] > summary::before { content: "▾"; }
  .wk-runs .log .det-x > summary:hover { color: var(--v2-text); background: var(--v2-hover); }
  .wk-runs .log .det-x > summary:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  .wk-runs .log .det-x .det { display: block; margin-top: 3px; padding: 6px 8px; max-height: 240px; overflow: auto; background: var(--v2-surface);
    border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control); color: var(--v2-text-2); font-size: 11.5px; white-space: pre-wrap; }
  .wk-log-empty { padding: 10px var(--v2-space-3); font-family: var(--v2-font-sans, inherit); font-size: 13px; color: var(--v2-text-3); }
  .none { color: var(--v2-text-2); font-size: 13px; }

  /* ---- new task dialog ---------------------------------------------------- */
  .wk-form { display: flex; flex-direction: column; gap: var(--v2-space-3); }
  .wk-form label, .wk-form-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--v2-fs-meta); color: var(--v2-text-2); }
  .wk-form-row { display: flex; gap: var(--v2-space-3); flex-wrap: wrap; }
  .wk-form-row .wk-form-prio { flex: 0 0 140px; }
  .wk-form-row .wk-form-grow { flex: 1; min-width: 180px; }
  .wk-deps-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .wk-chip { display: inline-flex; align-items: center; gap: 2px; max-width: 280px; height: 24px; padding: 0 2px 0 8px;
    border-radius: var(--v2-radius-control); background: var(--v2-surface); border: 1px solid var(--v2-border); color: var(--v2-text); font-size: 12.5px; }
  .wk-chip-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .wk-chip-x { display: inline-grid; place-items: center; width: 20px; height: 20px; flex: none; border: 0; border-radius: 4px; background: transparent; color: var(--v2-text-3); cursor: pointer; position: relative; }
  .wk-chip-x:hover { background: var(--v2-hover); color: var(--v2-text); }
  .wk-chip-x:focus-visible { box-shadow: var(--v2-focus-ring); }
  .wk-chip-x .v2-ico { width: 12px; height: 12px; }
  .wk-deps-panel { margin-top: 6px; border: 1px solid var(--v2-border-strong); border-radius: var(--v2-radius-control); background: var(--v2-canvas); }
  .wk-deps-search { display: flex; align-items: center; gap: 6px; padding: 0 var(--v2-space-2); border-bottom: 1px solid var(--v2-border); }
  .wk-deps-search .v2-ico { width: 14px; height: 14px; color: var(--v2-text-3); flex: none; }
  .wk-deps-q, .wk-deps-q:focus, .wk-deps-q:focus-visible { flex: 1; min-width: 0; height: 32px; border: 0; background: transparent; color: var(--v2-text);
    font: inherit; font-size: 13px; outline: none; box-shadow: none; padding: 0; }
  .wk-deps-panel:focus-within { border-color: var(--v2-accent); }
  .wk-deps-list { max-height: 208px; overflow: auto; padding: 4px; }
  .wk-form .wk-deps-opt, .wk-deps-opt { flex-direction: row; display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 8px;
    border-radius: 4px; color: var(--v2-text); font-size: 13px; cursor: pointer; }
  .wk-deps-opt:hover { background: var(--v2-hover); }
  .wk-deps-opt input { margin: 0; accent-color: var(--v2-accent); flex: none; }
  .wk-deps-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wk-deps-none { padding: 10px 8px; color: var(--v2-text-3); font-size: 13px; }

  /* ---- requests ----------------------------------------------------------- */
  .wk-flow { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .wk-row .wk-t > .wk-flow, .wk-row .wk-t > .v2-badge, .wk-row .wk-t > .wk-lbl, .wk-row .wk-t > .wk-kind { flex: none; }
  .wk-flow .wk-arrow { color: var(--v2-text-3); }
  .wk-chain { display: flex; flex-direction: column; gap: 2px; }
  .wk-chain .clink { display: flex; align-items: center; gap: var(--v2-space-2); width: 100%; padding: 6px var(--v2-space-3); text-align: left;
    border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control); background: var(--v2-surface); color: var(--v2-text); font: inherit; cursor: pointer; }
  .wk-chain .clink:hover { background: var(--v2-hover); }
  .wk-chain .clink.cur { background: var(--v2-selected); border-color: var(--v2-border-strong); }
  .wk-chain .clink:focus-visible { box-shadow: var(--v2-focus-ring); }
  .wk-chain .clink .cf { flex: 1; min-width: 0; font-size: 13px; }
  .wk-chain .clink .cf .ttl { display: block; font-weight: var(--v2-fw-medium); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wk-chain .clink .cf .sub { display: block; color: var(--v2-text-3); font-size: var(--v2-fs-meta); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wk-chain .rail { width: 1px; height: 8px; margin-left: 18px; background: var(--v2-border-strong); }
  /* D3: answers are marked by their heading + icon, not a coloured side stripe */
  .wk-answer { padding: var(--v2-space-2) var(--v2-space-3); border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control); background: var(--v2-surface); }
  .wk-answer.rej { border-color: var(--v2-border-strong); }
  .ans-in { width: 100%; min-height: 90px; resize: vertical; background: var(--v2-surface); border: 1px solid var(--v2-border-strong);
    color: var(--v2-text); border-radius: var(--v2-radius-control); padding: var(--v2-space-2) var(--v2-space-3); font: inherit; font-size: 13.5px; line-height: 1.5; outline: none; }
  .ans-in:focus-visible { box-shadow: var(--v2-focus-ring); border-color: var(--v2-accent); }

  /* ---- needs you ---------------------------------------------------------- */
  .wk-kind { font-size: var(--v2-fs-meta); color: var(--v2-text-2); white-space: nowrap; }
  .wk-hist { list-style: none; margin: 0; padding: 0; }
  .wk-hist li { display: flex; align-items: center; gap: var(--v2-space-3); min-height: var(--v2-row-h); padding: 6px var(--v2-space-4);
    border-bottom: 1px solid var(--v2-border); font-size: 13px; }
  .wk-hist .wk-when { margin-left: auto; font-size: var(--v2-fs-meta); color: var(--v2-text-3); white-space: nowrap; }
  .wk-projects { width: 100%; border-collapse: collapse; font-size: 13px; }
  .wk-projects th, .wk-projects td { text-align: left; padding: 8px var(--v2-space-4); border-bottom: 1px solid var(--v2-border); }
  .wk-projects th { font-size: var(--v2-fs-meta); color: var(--v2-text-3); font-weight: var(--v2-fw-medium); }
  .wk-projects td.num { font-variant-numeric: tabular-nums; }

  @media (max-width: 900px) {
    /* the page (not the panes) scrolls: sticky bars must clear the app header + project tabs */
    .wk-page { height: auto; min-height: 0; overflow: visible; }
    .wk-page .v2-split-list, .wk-page .v2-split-inspector { overflow: visible; }
    .wk-page .v2-inspector-h { position: static; }
    .wk-page .wk-grp { top: var(--wk-sticky-top); }
    .wk-tabs-wrap { position: sticky; top: var(--wk-sticky-top); z-index: 1; }
    .wk-fields { grid-template-columns: 110px 1fr; }
    .wk-search { width: 100%; }
    .wk-page > .wk-boardwrap { overflow: visible; }
  }
  .wk-full .wk-tabs-wrap { position: sticky; top: var(--wk-sticky-top); z-index: 1; }
  @media (max-width: 560px) {
    .wk-row.v2-row { gap: var(--v2-space-2); }
    .wk-row .wk-side { gap: var(--v2-space-2); }
    .wk-page .v2-toolbar { padding: var(--v2-space-2) var(--v2-space-3); }
    .wk-page .v2-toolbar-main { flex-basis: 100%; flex-wrap: nowrap; }
    .wk-page .v2-toolbar-main .wk-searchbox { flex: 1; }
    .wk-page .v2-toolbar-end { flex-wrap: nowrap; max-width: 100%; margin-left: auto; }
    .wk-fields { grid-template-columns: 96px 1fr; gap: 6px var(--v2-space-2); }
    .wk-dtitle { font-size: 16px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .wk-col { flex-basis: calc(100vw - 64px); }
    .wk-board { scroll-snap-type: x mandatory; padding: 0 var(--v2-space-3) var(--v2-space-3); scroll-padding-left: var(--v2-space-3); }
    /* the decision stays reachable: the gate's action row pins to the viewport bottom while the gate is on screen */
    .wk-gate .wk-actions.actions { position: sticky; bottom: 0; z-index: 2; background: var(--v2-surface);
      border-radius: 0 0 var(--v2-radius-card, 8px) var(--v2-radius-card, 8px); }
    .wk-gate .wk-actions.actions .wk-conseq { flex-basis: 100%; }
    .td-g-row { grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .wk-gate-compact .wk-gate-sub { display: none; }
    /* New task: a full-height sheet with a sticky footer */
    .v2-overlay:has(> .wk-newtask) { padding: 0; place-items: stretch; }
    .v2-dialog.wk-newtask { max-width: none; max-height: none; height: 100dvh; border-radius: 0; border: 0; display: flex; flex-direction: column; }
    .wk-newtask .v2-dialog-b { flex: 1; overflow: auto; }
    .wk-newtask .v2-dialog-f { border-top: 1px solid var(--v2-border); background: var(--v2-raised); }
    .wk-form-row .wk-form-prio { flex: 1 1 120px; }
  }
  @media (pointer: coarse) {
    .wk-input, .wk-select { height: 36px; }
    .wk-deps-opt { min-height: 44px; }
    .wk-chip-x::after { content: ""; position: absolute; inset: -10px; }
    .wk-seg button, .wk-chipbtn { position: relative; }
    .wk-seg button::after, .wk-chipbtn::after { content: ""; position: absolute; inset: -8px 0; }
    /* Requests' shared SortCtl (Time / Priority / direction) was 19-21 px tall
       on a 390 px touch layout (QA): page-scoped 44 px floor (RequestsPage.qa.test #26). */
    .wk-page .sortctl button, .wk-page .sortctl .sortdir { min-height: 44px; min-width: 44px; }
  }
`;
