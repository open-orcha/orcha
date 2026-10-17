/**
 * Tasks list + board styles (Linear "My issues" rows / "Agent tasks" cards,
 * directives D5/D8/D12). Tokens only. The page sits flush inside the D5 panel:
 * no bordered page box, the filter row lives in <Shell toolbar>, rows are one
 * 36 px line (32 px compact), bands are the primitives' GroupHeader.
 */
export const tasksListCss = String.raw`
  /* ---- page frame: flat inside the panel, fills it on wide layouts ---- */
  .wk-page.tl-page { border: 0; border-radius: 0; background: transparent;
    height: var(--v2-content-h); min-height: 320px; border-top: 1px solid var(--v2-border-subtle, var(--v2-border)); }
  .tl-page .v2-split-list, .tl-page .v2-split-inspector { background: transparent; }
  .tl-page .v2-split-inspector { border-left: 1px solid var(--v2-border-subtle, var(--v2-border)); }
  .tl-page .v2-inspector-h { background: var(--v2-panel, var(--v2-canvas)); }

  /* ---- toolbar (Shell toolbar slot) ---- */
  .tl-toolbar { gap: var(--v2-space-2); }
  .tl-toolbar .v2-filterbar-main { display: flex; align-items: center; gap: var(--v2-space-2); min-width: 0; flex: 1; }
  .tl-toolbar .v2-filterbar-actions { display: flex; align-items: center; gap: 6px; flex: none; }
  .tl-search { position: relative; display: inline-flex; align-items: center; min-width: 0; }
  .tl-search > .v2-ico { position: absolute; left: 10px; width: 13px; height: 13px; color: var(--v2-text-3); pointer-events: none; }
  .tl-search-in { width: 200px; max-width: 100%; height: 28px; padding: 0 10px 0 28px; border-radius: var(--v2-radius-full, 999px);
    border: 1px solid var(--v2-border); background: transparent; color: var(--v2-text); font: inherit; font-size: var(--v2-fs-meta, 12px);
    transition: border-color var(--v2-dur-fast, .12s) var(--v2-ease, ease), width var(--v2-dur-fast, .12s) var(--v2-ease, ease); }
  .tl-search-in::placeholder { color: var(--v2-text-3); }
  .tl-search-in:hover { border-color: var(--v2-border-strong); }
  .tl-search-in:focus { outline: none; border-color: var(--v2-border-strong); box-shadow: var(--v2-focus-ring); width: 260px; }
  .tl-search-in::-webkit-search-cancel-button { filter: invert(0.6); }
  .tl-toolbar .v2-iconbtn.is-on { color: var(--v2-text); background: var(--v2-selected); border-color: var(--v2-border-strong); }
  .tl-toolbar .v2-iconbtn[aria-pressed="true"] { color: var(--v2-text); background: var(--v2-selected); border-color: var(--v2-border-strong); }
  /* Linear menu rows in the Filter / Display popovers: the native box is
     visually hidden (kept for keyboard + screen readers), a trailing check
     marks the chosen item and keyboard focus rings the whole row */
  .wk-pop-opt { position: relative; min-height: 30px; }
  .wk-pop-opt input.wk-pop-in { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
  .wk-pop-opt:has(input.wk-pop-in:focus-visible) { background: var(--v2-hover); box-shadow: inset 0 0 0 1px var(--v2-border-strong); }
  .wk-pop-opt:has(input.wk-pop-in:checked) .v2-menu-label { color: var(--v2-text); }
  .wk-pop-check { flex: none; width: 14px; display: inline-flex; justify-content: center; color: var(--v2-text-2); }
  .wk-pop-check .v2-ico { width: 13px; height: 13px; }
  /* phone: the scope pills collapse into one "All tasks ▾" menu */
  .tl-scopemenu.v2-menubtn { flex: 0 1 auto; min-width: 0; padding-left: 10px; border-radius: var(--v2-radius-full, 999px); }
  .tl-scopemenu-n { color: var(--v2-text-3); margin-left: 2px; }
  .tl-filtercount { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-size: var(--v2-fs-meta, 12px); color: var(--v2-text-3); flex: none; }

  /* ---- grouped list ---- */
  .tl-list { padding: 4px var(--v2-space-2) var(--v2-space-4); }
  .tl-group + .tl-group { margin-top: 2px; }
  .tl-grp.v2-group { position: sticky; top: 0; z-index: 1; }
  .tl-rows { display: flex; flex-direction: column; }
  .tl-row.v2-row { display: flex; align-items: center; gap: 10px; min-height: 36px; height: 36px;
    padding: 0 var(--v2-space-3) 0 22px; border: 0; border-radius: 6px; font-size: var(--v2-fs-row, 13px); box-shadow: none; }
  .tl-row.v2-row.is-compact { min-height: 32px; height: 32px; }
  .tl-row.v2-row::before { display: none; }
  .tl-row.v2-row:hover { background: var(--v2-hover); }
  .tl-row.v2-row.is-selected { background: var(--v2-selected); }
  .tl-row.v2-row:focus-visible { outline: none; box-shadow: var(--v2-focus-ring-inset); }
  /* j/k selection moves focus too: the selected fill already marks the row, so
     the ring drops to a quiet 1 px edge (Linear) instead of a second heavy frame */
  .tl-row.v2-row.is-selected:focus-visible { box-shadow: inset 0 0 0 1px var(--v2-border-strong); }
  .tl-row .tl-prio { flex: none; display: inline-flex; color: var(--v2-text-3); }
  .tl-id { flex: none; width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--v2-text-3); font-size: var(--v2-fs-meta, 12px); font-variant-numeric: tabular-nums; letter-spacing: 0.01em; }
  .tl-row .tl-st { flex: none; display: inline-flex; }
  /* D6: row titles 450 (Inter Variable) — specific enough to beat the
     primitive row's own label weight */
  .tl-row .tl-title, .tl-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--v2-text); font-weight: 450; }
  .tl-chips { flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: 42%; overflow: hidden; }
  .tl-who { flex: none; display: inline-flex; align-items: center; justify-content: flex-end; min-width: 20px; }
  .tl-time { flex: none; width: auto; min-width: 34px; text-align: right; font-size: var(--v2-fs-meta, 12px); color: var(--v2-text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* row ⋯ menu: floats over the row's right edge on hover / focus / open, so the
     row never reflows (Linear); touch devices keep it visible in the flow */
  .tl-rowmenu { flex: none; display: inline-flex; }
  @media (hover: hover) {
    .tl-row.v2-row { position: relative; }
    .tl-row .tl-rowmenu { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); opacity: 0;
      border-radius: 50%; background: var(--v2-panel, var(--v2-surface)); transition: opacity var(--v2-dur-fast, .12s) var(--v2-ease, ease); }
    .tl-row:hover .tl-rowmenu, .tl-row:focus-within .tl-rowmenu, .tl-row .tl-rowmenu:has([aria-expanded="true"]) { opacity: 1; }
  }
  .tl-noone { display: inline-block; width: 18px; height: 18px; border-radius: 50%; border: 1px dashed var(--v2-border-strong); flex: none; }
  .tl-noone.is-sm { width: 16px; height: 16px; }
  .tl-page .wk-more { margin: var(--v2-space-3) auto; width: auto; }

  /* ---- board ---- */
  .wk-boardwrap.tl-boardwrap { overflow: hidden; }
  .tl-boardview { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  /* position: the sr-only labels inside cards are absolutely positioned — keep
     them inside the horizontal scroller so they never widen the page */
  .tl-board.v2-board { flex: 1; min-height: 0; padding: var(--v2-space-3) var(--v2-space-4) var(--v2-space-4); }
  .tl-board .tl-id { width: auto; }
  .tl-pchip.v2-chip { padding: 0; width: 22px; justify-content: center; color: var(--v2-text-2); }
  .tl-bmore { list-style: none; display: flex; justify-content: center; }
  /* column actions (⋯ / +) appear on hover or keyboard focus, like Linear */
  @media (hover: hover) {
    .tl-board .v2-bcol-actions { opacity: 0; transition: opacity var(--v2-dur-fast, .12s) var(--v2-ease, ease); }
    .tl-board .v2-bcol:hover .v2-bcol-actions, .tl-board .v2-bcol-actions:focus-within,
    .tl-board .v2-bcol-actions [aria-expanded="true"] { opacity: 1; }
  }
  /* board + "Hidden columns" rail side by side: the board scrolls, the rail is
     a fixed 200 px column outside the scroller (never shrinks, never overlaps) */
  .tl-boardrow { flex: 1; min-height: 0; display: flex; align-items: stretch; min-width: 0; }
  .tl-boardrow > .tl-board.v2-board { flex: 1 1 auto; min-width: 0; }
  .tl-hiddenrail { flex: 0 0 200px; width: 200px; min-width: 0; padding: var(--v2-space-3) 8px; border-left: 1px solid var(--v2-border-subtle, var(--v2-border));
    overflow-y: auto; background: var(--v2-panel, transparent); }
  @media (max-width: 640px) { .tl-hiddenrail { flex-basis: 160px; width: 160px; } }
  /* filter popover: 16 px round avatars lead the assignee options (Linear) */
  .wk-pop-av { width: 16px; height: 16px; flex: none; display: inline-grid; place-items: center; }
  /* "Hidden columns" list (right rail, or one quiet strip above a narrow board) */
  .tl-hiddencols { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .tl-hiddencols-top { padding: var(--v2-space-2) var(--v2-space-3) 0; overflow-x: auto; }
  .tl-hiddencols-top .tl-hiddencols { flex-direction: row; align-items: center; gap: 2px; }
  .tl-hiddencols-top .tl-hiddencols-h { min-height: 28px; padding: 0 6px 0 0; white-space: nowrap; }
  .tl-hiddencols-top .tl-hiddencols-list { flex-direction: row; }
  .tl-hiddencols-top .tl-hiddencol { width: auto; height: 28px; white-space: nowrap; }
  /* flex (not the primitive's equal grid) so the hidden-columns strip stays narrow */
  .tl-board.v2-board { display: flex; align-items: flex-start; }
  .tl-board > .v2-bcol { flex: 1 0 280px; width: 280px; }
  @media (max-width: 560px) { .tl-board > .v2-bcol { flex-basis: 86%; width: 86%; } }
  .tl-hiddencols-h { margin: 0; min-height: 36px; display: flex; align-items: center; padding: 0 8px;
    font-size: var(--v2-fs-meta, 12px); font-weight: var(--v2-fw-medium, 500); color: var(--v2-text-3); }
  .tl-hiddencols-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .tl-hiddencol { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: 6px;
    background: transparent; color: var(--v2-text-2); font: inherit; font-size: var(--v2-fs-row, 13px); cursor: pointer; text-align: left; }
  .tl-hiddencol:hover { background: var(--v2-hover); color: var(--v2-text); }
  .tl-hiddencol:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  .tl-hiddencol-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-hiddencol-n { color: var(--v2-text-3); font-variant-numeric: tabular-nums; }
  /* a selected task hidden by the filters (inspector closed) */
  .tl-hiddensel { display: flex; align-items: center; gap: var(--v2-space-2); flex-wrap: wrap; margin: var(--v2-space-2) var(--v2-space-3) 0;
    padding: 6px 10px; border: 1px solid var(--v2-border); border-radius: 8px; font-size: var(--v2-fs-meta, 12px); color: var(--v2-text-2); }
  .tl-hiddensel-txt { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
  .tl-hiddensel-title { min-width: 0; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--v2-text); font-weight: var(--v2-fw-medium, 500); }
  .tl-hiddensel-why { flex: none; }

  /* ---- narrow: the page scrolls with the document ---- */
  @media (max-width: 900px) {
    .wk-page.tl-page { height: auto; min-height: 0; border-top: 0; }
    .tl-grp.v2-group { top: var(--v2-sticky-top, 0px); }
    .tl-board.v2-board { padding: var(--v2-space-2) var(--v2-space-3) var(--v2-space-3); }
    .wk-boardwrap.tl-boardwrap { overflow: visible; }
  }
  @media (max-width: 560px) {
    .tl-list { padding: 2px 0 var(--v2-space-4); }
    .tl-row.v2-row { gap: 8px; padding: 0 var(--v2-space-3) 0 var(--v2-space-3); border-radius: 0; }
    .tl-row .tl-id, .tl-row .tl-time { display: none; }
    .tl-chips { max-width: 38%; }
    /* phone: the title wins — no reviewer chip, the title keeps ~45% */
    .tl-row .tl-revchip { display: none; }
    .tl-row .tl-title { flex: 1 1 45%; }
    /* the scope pills scroll sideways inside their own strip; the primitive's
       data-fade mask fades whichever edge hides a pill (never a hard cut) */
    .tl-toolbar .v2-filterbar-main { overflow: hidden; min-width: 0; }
    .tl-scopes.v2-pills { flex: 1 1 auto; min-width: 0; max-width: 100%; overflow-x: auto; }
    .tl-search { flex: 1; }
    .tl-search-in, .tl-search-in:focus { width: 100%; }
  }
  @media (pointer: coarse) {
    .tl-row.v2-row, .tl-row.v2-row.is-compact { min-height: 44px; height: 44px; }
  }
`;
