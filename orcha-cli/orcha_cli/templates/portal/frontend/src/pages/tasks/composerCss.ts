/**
 * New-task composer + in-place people popover styles (owner: tasks-detail).
 * Rendered by NewTaskModal itself (and TaskDetailPane for the rail pickers),
 * so the composer looks the same wherever it opens — the Tasks page or the
 * shell's global composer. Tokens only (docs/orcha-v2-design-system.md §1).
 */
export const composerCss = String.raw`
  /* ---- composer frame ------------------------------------------------------ */
  .nt-composer.v2-dialog { position: relative; max-width: 640px; overflow-x: hidden; }
  .nt-composer .v2-dialog-h { padding: 14px 52px 4px var(--v2-space-5); }
  .nt-composer .v2-dialog-title { font-size: var(--v2-fs-meta); font-weight: var(--v2-fw-medium); color: var(--v2-text-2); }
  .nt-composer .v2-dialog-b { padding: 0 var(--v2-space-5) var(--v2-space-2); }
  .nt-composer .v2-dialog-f { border-top: 1px solid var(--v2-border-subtle); padding: 10px var(--v2-space-4); }
  .nt-x { position: absolute; top: 10px; right: 12px; }
  .nt-body { display: flex; flex-direction: column; gap: 6px; }

  /* borderless title + description (Linear composer) */
  .nt-title, .nt-desc, .nt-dod-in { width: 100%; border: 0; background: transparent; color: var(--v2-text); font: inherit; padding: 0; margin: 0;
    outline: none; box-shadow: none; resize: none; }
  .nt-title { font-family: var(--v2-font-display); font-size: 20px; font-weight: var(--v2-fw-semibold); letter-spacing: -0.01em; line-height: 1.3; height: 32px; margin-top: 4px; }
  .nt-desc { font-size: var(--v2-fs-body-lg); line-height: 1.55; color: var(--v2-text-2); min-height: 48px; max-height: 240px; overflow: auto; }
  .nt-title::placeholder, .nt-desc::placeholder, .nt-dod-in::placeholder { color: var(--v2-text-3); opacity: 1; }
  .nt-title:focus-visible, .nt-desc:focus-visible, .nt-dod-in:focus-visible { outline: none; box-shadow: none; }

  /* "Done when" — a borderless required line under a hairline (same treatment
     as the title + description; the leading check glyph marks the field) */
  .nt-dod { display: flex; align-items: flex-start; gap: 10px; min-height: 36px; padding: 10px 0 2px; margin-top: 6px;
    border: 0; border-top: 1px solid var(--v2-border-subtle); border-radius: 0; background: transparent; }
  .nt-dod.is-invalid .nt-dod-l { color: var(--v2-danger); }
  .nt-dod-l { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 20px; font-size: var(--v2-fs-meta); font-weight: var(--v2-fw-medium);
    color: var(--v2-text-3); white-space: nowrap; cursor: default; }
  .nt-dod-in { font-size: var(--v2-fs-body); line-height: 20px; min-height: 20px; max-height: 160px; overflow: auto; }

  /* inline field error: one muted-red line under its field */
  .nt-err { display: flex; align-items: center; gap: 6px; font-size: var(--v2-fs-meta); color: var(--v2-danger); line-height: 18px; }
  .nt-err .v2-ico { width: 13px; height: 13px; flex: none; }

  /* property chips — rounded-full, 1px border (D8) */
  .nt-props { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
  .nt-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; max-width: 260px; padding: 0 10px;
    border: 1px solid var(--v2-border); border-radius: var(--v2-radius-full); background: transparent; color: var(--v2-text-2);
    font: inherit; font-size: var(--v2-fs-meta); font-weight: var(--v2-fw-medium); cursor: pointer; white-space: nowrap; }
  button.nt-chip:hover { background: var(--v2-hover); color: var(--v2-text); }
  button.nt-chip:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  /* "Custom…" priority: the exact integer beside the chip */
  .nt-pri-n { width: 64px; height: 26px; padding: 0 8px; border: 1px solid var(--v2-border); border-radius: var(--v2-radius-full);
    background: transparent; color: var(--v2-text); font: inherit; font-size: var(--v2-fs-meta); font-variant-numeric: tabular-nums; flex: none; }
  .nt-pri-n:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  .nt-pri-n[aria-invalid="true"] { border-color: var(--v2-danger, var(--v2-border)); }
  .nt-chip[aria-expanded="true"] { background: var(--v2-selected); color: var(--v2-text); border-color: var(--v2-border-strong); }
  .nt-chip .v2-ico { width: 13px; height: 13px; color: var(--v2-text-3); flex: none; }
  .nt-chip.is-empty { color: var(--v2-text-3); }
  .nt-chip.is-dep { padding: 0 2px 0 8px; gap: 5px; color: var(--v2-text); cursor: default; }
  .nt-chip.is-dep .wk-chip-x { width: 20px; height: 20px; border-radius: var(--v2-radius-full); }
  /* dependency picker: an anchored popover (portaled above the dialog) */
  .nt-deps-pop { width: min(380px, calc(100vw - 16px)); padding: 6px; }
  .nt-deps-pop .nt-deps-panel { border: 0; padding: 0; margin: 0; background: transparent; }
  .nt-deps-pop .wk-deps-list { max-height: 260px; overflow: auto; }
  .nt-deps-pop .wk-deps-q::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; } /* Esc clears */
  .nt-deps-panel { width: 100%; min-width: 0; }
  .nt-deps-panel .wk-deps-opt { min-width: 0; }
  .nt-deps-panel .wk-deps-t { min-width: 0; }

  /* protocol: borderless lines under one hairline, placeholder-as-label */
  .nt-proto { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--v2-border-subtle); }
  .nt-proto[hidden] { display: none; }
  .nt-proto-row { display: block; }
  .nt-proto-in { display: block; width: 100%; min-height: 28px; max-height: 120px; padding: 4px 0; margin: 0; border: 0; background: transparent;
    color: var(--v2-text); font: inherit; font-size: var(--v2-fs-body); line-height: 20px; resize: none; outline: none; box-shadow: none; overflow: auto; }
  .nt-proto-in::placeholder { color: var(--v2-text-3); opacity: 1; }
  .nt-proto-in:focus-visible { outline: none; box-shadow: none; }

  /* ⌘↵ hint on the primary button */
  .nt-kbd { margin-left: 6px; padding: 0 4px; border-radius: 4px; font: inherit; font-size: 11px; line-height: 16px;
    background: rgb(255 255 255 / 0.16); color: inherit; opacity: .85; }

  /* dependency picker rows: the checkbox is visually hidden — a trailing check marks the pick */
  .wk-deps-opt .wk-deps-check { width: 14px; height: 14px; flex: none; display: inline-grid; place-items: center; color: var(--v2-accent); }
  .wk-deps-opt .wk-deps-check .v2-ico { width: 14px; height: 14px; }
  .wk-deps-opt:focus-within { background: var(--v2-hover); box-shadow: inset 0 0 0 1px var(--v2-accent); }

  /* priority menu: the bars glyph leads each item */
  .td-people-ico { width: 16px; height: 16px; flex: none; display: inline-grid; place-items: center; }

  @media (max-width: 560px) {
    .nt-composer.v2-dialog { max-width: none; }
    .nt-title { font-size: 18px; }
    .nt-dod { flex-direction: column; gap: 2px; }
    .nt-chip { max-width: 100%; }
  }
  /* phone: ONE property row that scrolls sideways — never a lone wrapped chip */
  @media (max-width: 480px) {
    .nt-props { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; padding: 2px; margin-left: -2px; margin-right: -2px;
      -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); }
    .nt-props::-webkit-scrollbar { display: none; }
    .nt-chip, .nt-chip.is-dep { flex: none; }
    .nt-chip.is-dep { max-width: 200px; }
    .nt-kbd { display: none; }
  }

  /* ---- people popover (reviewer / assignee / assign & wake) --------------- */
  .td-people { min-width: 200px; max-width: 280px; }
  .td-people .v2-menu-inner { max-height: 280px; overflow: auto; }
  .td-people-item { gap: 8px; }
  .td-people-item .v2-av { flex: none; }
  .td-people-none { width: 16px; height: 16px; flex: none; border-radius: 50%; border: 1px dashed var(--v2-text-3); }
  .td-people .v2-menu-check { margin-left: 4px; }
`;
