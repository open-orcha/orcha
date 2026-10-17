/**
 * Deliverables styles — Linear-calm rows (36 px, hover fill, no stripes / D3),
 * mono only for file paths and code/diffs (D15), tokens only (no hex).
 */
export const deliverablesCss = String.raw`
  .dlv { display: flex; flex-direction: column; gap: 4px; }
  .dlv-h { display: flex; align-items: center; gap: var(--v2-space-2); min-height: 28px; }
  .dlv-h .td-block-k { flex: 1; }
  .dlv-count { color: var(--v2-text-3); font-variant-numeric: tabular-nums; font-weight: var(--v2-fw-regular); margin-left: 4px; }
  .dlv-list { display: flex; flex-direction: column; border: 1px solid var(--v2-border-subtle, var(--v2-border)); border-radius: var(--v2-radius-control); overflow: hidden; }
  .dlv-item + .dlv-item { border-top: 1px solid var(--v2-border-subtle, var(--v2-border)); }
  .dlv-row { display: flex; align-items: center; gap: var(--v2-space-2); min-height: 36px; padding: 0 var(--v2-space-3);
    width: 100%; background: none; border: 0; color: var(--v2-text); font: inherit; font-size: var(--v2-fs-body); text-align: left; cursor: pointer; }
  .dlv-row:hover { background: var(--v2-hover); }
  .dlv-row:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  .dlv-row[aria-expanded="true"] { background: var(--v2-selected); }
  .dlv-kind { flex: none; width: 16px; height: 16px; color: var(--v2-text-3); }
  .dlv-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--v2-font-mono); font-size: 12.5px; }
  .dlv-dir { color: var(--v2-text-3); }
  .dlv-meta { flex: none; display: inline-flex; align-items: center; gap: var(--v2-space-2); color: var(--v2-text-3);
    font-size: var(--v2-fs-meta); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dlv-ver { border: 1px solid var(--v2-border); border-radius: 999px; padding: 0 6px; line-height: 16px; color: var(--v2-text-2); }
  .dlv-chev { width: 14px; height: 14px; color: var(--v2-text-3); transform: rotate(-90deg); transition: transform .12s ease; }
  .dlv-row[aria-expanded="true"] .dlv-chev { transform: none; }
  @media (max-width: 560px) { .dlv-src, .dlv-size { display: none; } }

  .dlv-open { padding: var(--v2-space-3); display: flex; flex-direction: column; gap: var(--v2-space-3); background: var(--v2-canvas); }
  .dlv-bar { display: flex; flex-wrap: nowrap; align-items: center; gap: var(--v2-space-2); min-width: 0; font-size: var(--v2-fs-meta); color: var(--v2-text-2); }
  /* one row, never wraps (D12): the muted who/when text gives way, controls keep their size */
  .dlv-bar > span:not(.v2-grow) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dlv-bar > label, .dlv-bar > button, .dlv-bar > a { flex: none; white-space: nowrap; }
  /* phones: the history rows right below already say who/when — drop the squeezed copy */
  @media (max-width: 560px) { .dlv-bar > span:not(.v2-grow) { display: none; } }
  .dlv-bar .v2-grow { flex: 1; }
  .dlv-select { height: 24px; border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control); background: var(--v2-surface);
    color: var(--v2-text); font: inherit; font-size: var(--v2-fs-meta); padding: 0 6px; }
  .dlv-select:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  .dlv-link { color: var(--v2-text-2); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
  .dlv-link:hover { color: var(--v2-text); text-decoration: underline; }

  .dlv-preview { max-height: 480px; overflow: auto; border: 1px solid var(--v2-border-subtle, var(--v2-border)); border-radius: var(--v2-radius-sm, 6px);
    background: var(--v2-surface); }
  .dlv-preview.is-md { padding: var(--v2-space-3) var(--v2-space-4); font-size: var(--v2-fs-body); color: var(--v2-text); }
  .dlv-pre { margin: 0; padding: var(--v2-space-3); font-family: var(--v2-font-mono); font-size: 12px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word; color: var(--v2-text); }
  .dlv-table { border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; min-width: 100%; }
  .dlv-table th, .dlv-table td { padding: 4px 10px; border-bottom: 1px solid var(--v2-border-subtle, var(--v2-border)); text-align: left;
    white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  .dlv-table th { position: sticky; top: 0; background: var(--v2-surface); color: var(--v2-text-2); font-weight: var(--v2-fw-medium); }
  .dlv-img { display: block; max-width: 100%; max-height: 460px; margin: 0 auto; object-fit: contain; }
  .dlv-pdf { display: block; width: 100%; height: 460px; border: 0; }
  .dlv-file-card { display: flex; align-items: center; gap: var(--v2-space-3); padding: var(--v2-space-3) var(--v2-space-4); font-size: var(--v2-fs-body); }
  .dlv-file-card .dlv-kind { width: 20px; height: 20px; }
  .dlv-note { font-size: var(--v2-fs-meta); color: var(--v2-text-3); }
  .dlv-err { font-size: var(--v2-fs-meta); color: var(--v2-danger); }

  .dlv-hist { display: flex; flex-direction: column; }
  .dlv-hist-row { display: flex; align-items: center; gap: var(--v2-space-2); min-height: 28px; padding: 0 6px; border-radius: var(--v2-radius-control);
    background: none; border: 0; font: inherit; font-size: var(--v2-fs-meta); color: var(--v2-text-2); text-align: left; cursor: pointer; }
  .dlv-hist-row:hover { background: var(--v2-hover); }
  .dlv-hist-row[aria-current="true"] { background: var(--v2-selected); color: var(--v2-text); }
  .dlv-hist-row:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  .dlv-hist-v { font-variant-numeric: tabular-nums; font-weight: var(--v2-fw-medium); min-width: 22px; color: var(--v2-text); }
  .dlv-hist-note { color: var(--v2-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }

  .dlv-diffstat { display: inline-flex; gap: 6px; font-variant-numeric: tabular-nums; }
  .dlv-add { color: var(--v2-ok, var(--v2-accent)); }
  .dlv-del { color: var(--v2-danger); }

  /* verification gate row (one line + a disclosure) */
  .dlv-ev-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--v2-space-2); }
  .dlv-ev-file { font-family: var(--v2-font-mono); font-size: 12px; color: var(--v2-text-2); }
  .dlv-ev-diff > summary { cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 4px;
    font-size: var(--v2-fs-meta); color: var(--v2-text-2); margin-top: 4px; }
  .dlv-ev-diff > summary::-webkit-details-marker { display: none; }
  .dlv-ev-diff > summary .wk-disc-chev { transform: rotate(-90deg); }
  .dlv-ev-diff[open] > summary .wk-disc-chev { transform: none; }
  .dlv-ev-diffs { display: flex; flex-direction: column; gap: var(--v2-space-3); margin-top: var(--v2-space-2); }
`;
