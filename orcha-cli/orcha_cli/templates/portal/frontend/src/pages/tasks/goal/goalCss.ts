/**
 * Goal-chain breadcrumb styles. Tokens only (docs/orcha-v2-design-system.md §1):
 * no hex, no stripes (D3), 12 px muted meta line (D6), one line with ellipsis
 * (D12), circular 20 px edit control (D2/D5).
 */
export const goalChainCss = String.raw`
  .gc { display: flex; align-items: center; gap: var(--v2-space-1); min-width: 0; max-width: 100%;
    margin: 0 0 var(--v2-space-1); font-size: var(--v2-fs-meta); line-height: 20px; color: var(--v2-text-3); }
  .gc-list { display: flex; align-items: center; min-width: 0; margin: 0; padding: 0; list-style: none; overflow: hidden; }
  .gc-crumb { display: inline-flex; align-items: center; min-width: 0; flex: 0 1 auto; white-space: nowrap; }
  .gc-crumb.gc-task, .gc-crumb.gc-note { flex: none; }
  /* when space is short the objective gives way first, then far ancestors;
     the nearest parent (the li right before "This task") keeps the most room */
  .gc-crumb.gc-objective { flex-shrink: 6; min-width: 7ch; }
  .gc-crumb.gc-parent { flex-shrink: 3; min-width: 7ch; }
  .gc-crumb.gc-parent.is-nearest { flex-shrink: 1; }
  .gc-sep { width: 12px; height: 12px; flex: none; margin: 0 2px; color: var(--v2-text-3); opacity: .7; }
  .gc-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .gc-obj, .gc-link, .gc-self { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 28ch;
    padding: 0 4px; border-radius: var(--v2-radius-sm); }
  .gc-obj { max-width: 32ch; color: var(--v2-text-2); }
  .gc-obj.is-empty { color: var(--v2-text-3); }
  .gc-obj-ico { width: 12px; height: 12px; flex: none; }
  .gc-link { color: var(--v2-text-2); text-decoration: none;
    transition: background var(--v2-dur-fast) var(--v2-ease), color var(--v2-dur-fast) var(--v2-ease); }
  .gc-link:hover { background: var(--v2-hover); color: var(--v2-text); }
  .gc-link:focus-visible, .gc-edit:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  .gc-self { color: var(--v2-text-3); }
  .gc-edit { flex: none; display: inline-grid; place-items: center; width: 20px; height: 20px; padding: 0;
    border: 1px solid transparent; border-radius: var(--v2-radius-full); background: none; color: var(--v2-text-3);
    cursor: pointer; opacity: 0; transition: opacity var(--v2-dur-fast) var(--v2-ease), background var(--v2-dur-fast) var(--v2-ease); }
  .gc-edit .v2-ico { width: 12px; height: 12px; }
  .gc:hover .gc-edit, .gc-edit:focus-visible, .gc-edit[aria-expanded="true"] { opacity: 1; }
  .gc-edit:hover:not(:disabled) { background: var(--v2-hover); border-color: var(--v2-border-subtle); color: var(--v2-text); }
  .gc-edit:disabled { cursor: default; }
  @media (hover: none) { .gc-edit { opacity: 1; } }
  /* phone: the objective shows as its flag (full text in the tooltip) and far
     ancestors fold away — the nearest parent is what matters at a glance; the
     nav's title / accessible name still carries the whole chain */
  @media (max-width: 560px) {
    .gc-crumb.gc-objective .gc-label { display: none; }
    .gc-crumb.gc-objective { min-width: 0; flex-shrink: 0; }
    .gc-crumb.gc-parent.is-far, .gc-crumb.gc-fold { display: none; }
    .gc-crumb.gc-parent.is-far + .gc-crumb.gc-parent.is-nearest::before { content: "…"; margin: 0 2px; }
  }
  .gc-menu { width: 320px; }
  .gc-menu .v2-menu-inner { max-height: 320px; overflow-y: auto; }
  .gc-search { width: 100%; box-sizing: border-box; margin: 0 0 var(--v2-space-1); padding: 4px 8px; font: inherit;
    font-size: var(--v2-fs-body); color: var(--v2-text); background: none; border: 0;
    border-bottom: 1px solid var(--v2-border-subtle); outline: none; }
  .gc-opt .v2-menu-label, .gc-clear .v2-menu-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gc-empty { padding: 6px 8px; font-size: var(--v2-fs-meta); }
  @media (prefers-reduced-motion: reduce) { .gc-link, .gc-edit { transition: none; } }
`;
