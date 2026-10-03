/**
 * Onboarding page-scoped CSS (Orcha V2 "Linear pop", D5-D12).
 *
 * Calm, centred column inside the D5 panel: a Display title + one muted lede,
 * then ONE flat card per step (`.ob-panel`: --v2-surface + 1px --v2-border,
 * hairline separators inside). Setup progress sits in the panel's pill row
 * (Shell toolbar). Compact 32 px controls, rounded-full pills/chips, no hero
 * type, no gradients, no coloured stripes, no hard-coded colours — every value
 * is a --v2-* token. Buttons / chips / avatars / glyphs come from the shared
 * primitives; this file only lays out the flow and styles its form fields.
 */
export const PAGE_CSS = `
  .ob-page { padding: 40px 0 56px; }
  .ob-page.is-adding { padding-top: 32px; }
  @media (max-width: 720px) { .ob-page { padding: 12px 0 32px; } }

  /* ---- setup progress: the panel's pill row (Shell toolbar) ---- */
  .ob-progress { gap: 12px; }
  .ob-progress .v2-filterbar-main { min-width: 0; overflow: hidden; }
  .guide-rail { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .guide-rail .steps { display: flex; align-items: center; gap: 4px; list-style: none; margin: 0; padding: 0; min-width: 0; }
  .guide-rail .st { display: inline-flex; align-items: center; gap: 6px; height: var(--v2-pill-h, 28px); padding: 0 10px;
    border-radius: var(--v2-radius-full); border: 1px solid transparent; font-size: var(--v2-fs-body); font-weight: var(--v2-fw-medium);
    color: var(--v2-text-3); white-space: nowrap; }
  .guide-rail .st .v2-si { flex: none; }
  .guide-rail .st.done { color: var(--v2-text-2); }
  .guide-rail .st.cur { color: var(--v2-pill-text-selected, var(--v2-text)); background: var(--v2-pill-bg-selected, var(--v2-selected));
    border-color: var(--v2-pill-border-selected, var(--v2-border)); }
  .guide-rail .st .st-d { color: var(--v2-text-3); font-weight: var(--v2-fw-regular); font-variant-numeric: tabular-nums; }
  .guide-rail .st .st-d::before { content: "·"; margin: 0 6px 0 0; }
  .guide-rail .sep { width: 12px; height: 1px; background: var(--v2-border-strong); flex: none; }
  .guide-rail .st-n { display: none; font-size: var(--v2-fs-meta); color: var(--v2-text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ob-skip { display: inline-flex; align-items: center; gap: 4px; height: var(--v2-pill-h, 28px); padding: 0 8px; border-radius: var(--v2-radius-full);
    font-size: var(--v2-fs-body); font-weight: var(--v2-fw-medium); color: var(--v2-text-2); white-space: nowrap; text-decoration: none; }
  .ob-skip svg { width: 12px; height: 12px; }
  .ob-skip:hover { color: var(--v2-text); background: var(--v2-hover); }
  .ob-skip:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); }
  @media (max-width: 720px) {
    /* phones: ONLY the current step pill + "2 / 3" — never a clipped counter */
    .guide-rail .st:not(.cur), .guide-rail .sep { display: none; }
    .guide-rail .st.cur { padding: 0 10px; }
    /* the walk's "agent 1 of 3" stays visible on phones (it IS the progress);
       the bare "3 / 3" counter yields to it rather than repeating the step */
    .guide-rail .steps { flex: none; }
    .guide-rail .st-n { display: inline; flex: none; }
    .guide-rail.has-detail .st-n { display: none; }
    .ob-skip { font-size: var(--v2-fs-meta); padding: 0 4px; }
  }

  /* ---- column ---- */
  .ob { max-width: 640px; margin: 0 auto; }
  .ob.wide { max-width: 760px; }
  .ob-muted { color: var(--v2-text-2); font-size: var(--v2-fs-body); line-height: 1.5; padding: 4px 0; }
  .ob-muted b { color: var(--v2-text); font-weight: var(--v2-fw-medium); }

  .form-h { margin-bottom: 20px; }
  .form-h h1 { color: var(--v2-text); display: flex; align-items: center; gap: 10px; margin: 0; text-wrap: balance; }
  .form-h p { margin: 6px 0 0; max-width: 60ch; text-wrap: pretty; }
  .propose .gp-goal { color: var(--v2-text-2); }
  @media (max-width: 720px) { .form-h h1 { font-size: var(--v2-fs-title); } .form-h { margin-bottom: 16px; } }

  /* ONE flat card per step; sections inside are split by hairlines */
  .ob-panel { background: var(--v2-surface); border: 1px solid var(--v2-border); border-radius: var(--v2-radius-card, 8px); padding: 16px; }
  .ob-panel.flush { padding: 0; overflow: hidden; }
  .ob-panel + .ob-panel { margin-top: 12px; }

  /* ---- form fields: compact 32px controls ---- */
  .ipt, .sel, .txa { width: 100%; background-color: var(--v2-canvas); border: 1px solid var(--v2-border); color: var(--v2-text);
    border-radius: var(--v2-radius-control, 6px); padding: 5px 10px; font: inherit; font-size: var(--v2-fs-body); line-height: 1.5; outline: none;
    min-height: var(--v2-control-h, 32px); transition: border-color var(--v2-dur-fast, 90ms), box-shadow var(--v2-dur-fast, 90ms), background-color var(--v2-dur-fast, 90ms); }
  .ipt::placeholder, .txa::placeholder { color: var(--v2-text-3); }
  .ipt:hover, .sel:hover, .txa:hover { border-color: var(--v2-border-strong); }
  .ipt:focus, .sel:focus, .txa:focus { border-color: var(--v2-accent); box-shadow: 0 0 0 1px var(--v2-accent); }
  .ipt.invalid, .txa.invalid { border-color: var(--v2-danger); }
  .txa { resize: vertical; display: block; overflow: auto; max-height: 420px; }
  .txa.prompt { line-height: 1.55; }
  /* background-COLOR above keeps this chevron (the shorthand would wipe it) */
  .sel { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%238A8F98' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 8px center; background-size: 14px 14px; padding-right: 28px; cursor: pointer; }
  /* inline "ghost" fields (roster review): quiet until hovered / focused, like Linear's inline edit */
  .ipt.ghost, .txa.ghost { background-color: transparent; border-color: transparent; padding-left: 6px; padding-right: 6px; }
  .ipt.ghost:hover, .txa.ghost:hover { background-color: var(--v2-hover); border-color: transparent; }
  .ipt.ghost:focus, .txa.ghost:focus { background-color: var(--v2-canvas); border-color: var(--v2-accent); }
  /* ghost dropdowns (roster model + assignee): the shared MenuButton, bare
     text + chevron sized to content — no box until hovered (one treatment) */
  .ob-ddl.v2-btn { font-size: var(--v2-fs-meta); font-weight: var(--v2-fw-regular); color: var(--v2-text-2); max-width: 100%; }
  .ob-ddl.v2-btn:hover:not(:disabled) { color: var(--v2-text); }
  .ob-ddl .v2-btn-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (pointer: coarse) {
    .ipt, .sel { min-height: 44px; } .ob-ddl.v2-btn { height: 32px; }
    /* inline roster fields hug their text (a 44px floor left a blank line under one-line roles) */
    .ob .txa.ghost { min-height: 32px; }
  }

  .field2 { margin-bottom: 18px; }
  .field2.tight { margin-bottom: 12px; }
  .field2.last, .field2:last-child { margin-bottom: 0; }
  .field2 .lab { display: flex; align-items: center; gap: 6px; font-size: var(--v2-fs-meta); font-weight: var(--v2-fw-medium); color: var(--v2-text-2); margin-bottom: 6px; min-height: 18px; }
  .field2 .lab label { color: inherit; }
  .field2 .lab .req { color: var(--v2-text-3); }
  .field2 .lab .opt { color: var(--v2-text-3); font-weight: var(--v2-fw-regular); }
  .field2 .lab .grow { flex: 1; }
  .field2 .hint { font-size: var(--v2-fs-meta); color: var(--v2-text-3); margin-top: 6px; line-height: 1.45; }
  .field2 .hint.err { color: var(--v2-danger); }
  .ob-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  .ob-row2 > .field2 { margin-bottom: 18px; }
  @media (max-width: 640px) { .ob-row2 { grid-template-columns: 1fr; } }

  /* ---- welcome ---- */
  .welcome .ob-namerow { display: flex; gap: 8px; align-items: center; }
  .welcome .ob-namerow .ipt { flex: 1; min-width: 0; }
  /* ---- the fork: one list of options, hairline separated ---- */
  .ob-options { padding: 0; }
  .ob-opt { display: flex; align-items: center; gap: 14px; padding: 16px; }
  .ob-opt + .ob-opt { border-top: 1px solid var(--v2-border-subtle, var(--v2-border)); }
  .ob-opt-ic { width: 32px; height: 32px; border-radius: var(--v2-radius-full); flex: none; display: grid; place-items: center;
    border: 1px solid var(--v2-border); color: var(--v2-text-2); align-self: flex-start; }
  .ob-opt-ic svg { width: 15px; height: 15px; }
  .ob-opt.is-rec .ob-opt-ic { color: var(--v2-accent); }
  .ob-opt-b { flex: 1; min-width: 0; }
  .ob-opt-b h2 { font-size: var(--v2-fs-body-lg, 14px); font-weight: var(--v2-fw-semibold); color: var(--v2-text); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0; line-height: 1.4; }
  .ob-opt-b p { color: var(--v2-text-2); font-size: var(--v2-fs-body); line-height: 1.5; margin: 2px 0 0; max-width: 60ch; }
  .ob-opt-b p b { color: var(--v2-text); font-weight: var(--v2-fw-medium); }
  .ob-opt > .v2-btn { flex: none; }
  @media (max-width: 600px) {
    .ob-opt { flex-wrap: wrap; padding: 14px; }
    /* the text takes the full row; the action sits under it (never a 1-word column) */
    .ob-opt-b { flex: 1 1 calc(100% - 46px); }
    .ob-opt > .v2-btn { margin-left: 46px; }
  }

  /* ---- model picker: rounded radio pills grouped by provider ---- */
  .ob-models { display: grid; gap: 8px; }
  .ob-mgroup { display: grid; grid-template-columns: 88px 1fr; gap: 8px; align-items: start; }
  .ob-mgroup:only-child { grid-template-columns: 1fr; }
  .ob-mgroup-h { font-size: var(--v2-fs-meta); color: var(--v2-text-3); line-height: 28px; }
  .ob-mlist { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .ob-mopt { position: relative; display: inline-flex; align-items: center; gap: 6px; height: var(--v2-pill-h, 28px); padding: 0 12px 0 10px;
    border-radius: var(--v2-radius-full); border: 1px solid var(--v2-pill-border, var(--v2-border)); background: var(--v2-pill-bg, transparent);
    cursor: pointer; font-size: var(--v2-fs-body); color: var(--v2-text-2); max-width: 100%; }
  .ob-mopt:hover { background: var(--v2-hover); color: var(--v2-text); }
  .ob-mopt.on { background: var(--v2-pill-bg-selected, var(--v2-selected)); border-color: var(--v2-pill-border-selected, var(--v2-border-strong)); color: var(--v2-pill-text-selected, var(--v2-text)); }
  /* the native radio stays focusable + announced; the dot is its visible stand-in */
  .ob-mopt input { position: absolute; inset: 0; margin: 0; opacity: 0; cursor: pointer; }
  .ob-mopt:has(input:focus-visible) { box-shadow: var(--v2-focus-ring); }
  .ob-mdot { width: 12px; height: 12px; border-radius: var(--v2-radius-full); border: 1.5px solid var(--v2-text-3); flex: none; }
  .ob-mopt.on .ob-mdot { border-color: var(--v2-accent); background: radial-gradient(circle, var(--v2-accent) 0 3px, transparent 3.5px); }
  .ob-mname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 600px) { .ob-mgroup { grid-template-columns: 1fr; gap: 4px; } .ob-mgroup-h { line-height: 1.4; } }
  @media (pointer: coarse) { .ob-mopt { height: 40px; } }

  /* ---- first task ---- */
  .firsttask { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  /* three short pills: wrap instead of scrolling a label off-screen at 390 */
  .firsttask .ftmode { flex-wrap: wrap; overflow: visible; -webkit-mask-image: none; mask-image: none; }
  .firsttask .picklist { display: grid; gap: 2px; }
  .firsttask .pl { display: flex; align-items: flex-start; gap: 10px; padding: 7px 10px; border-radius: var(--v2-radius-control, 6px); cursor: pointer; }
  .firsttask .pl:hover { background: var(--v2-hover); }
  .firsttask .pl.on { background: var(--v2-selected); }
  .firsttask .pl input { accent-color: var(--v2-accent); margin: 3px 0 0; flex: none; }
  .firsttask .pl .grow { flex: 1; min-width: 0; display: grid; gap: 1px; }
  .firsttask .pl .t1 { font-weight: var(--v2-fw-medium); font-size: var(--v2-fs-body); color: var(--v2-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .firsttask .pl .t2 { color: var(--v2-text-3); font-size: var(--v2-fs-meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- footer actions: back · note · primary; stacks on phones ---- */
  .form-actions { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; margin-top: 16px; }
  .form-actions .note { color: var(--v2-text-3); font-size: var(--v2-fs-meta); flex: 1 1 200px; text-align: right; min-width: 0; }
  .form-actions > .v2-btn-primary { flex: none; }
  .ob-back .v2-btn-ico { transform: scaleX(-1); }
  @media (max-width: 600px) {
    .form-actions .note { order: -1; flex-basis: 100%; text-align: left; }
    .form-actions > .v2-btn-primary { flex: 1 1 auto; justify-content: center; }
  }

  /* ---- agent created ---- */
  .form-h h1 .ob-ok { flex: none; }
  .created .ob-panel { padding: 0; }
  .agentcard { display: flex; align-items: center; gap: 12px; padding: 14px 16px; flex-wrap: wrap; }
  .agentcard .ac-meta { flex: 1 1 200px; min-width: 0; }
  .agentcard h2 { font-size: var(--v2-fs-body-lg, 14px); font-weight: var(--v2-fw-semibold); color: var(--v2-text); margin: 0; line-height: 1.35; }
  .agentcard .role { color: var(--v2-text-2); font-size: var(--v2-fs-body); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agentcard .chips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .agentcard .chips .v2-si-wrap { font-size: var(--v2-fs-meta); color: var(--v2-text-2); }
  .brainstorm, .walknext, .held { border-top: 1px solid var(--v2-border-subtle, var(--v2-border)); padding: 14px 16px; }
  .brainstorm { display: flex; align-items: center; gap: 12px 16px; flex-wrap: wrap; }
  .brainstorm .bb { flex: 1 1 260px; min-width: 0; }
  .brainstorm h2 { font-size: var(--v2-fs-body); font-weight: var(--v2-fw-semibold); color: var(--v2-text); margin: 0; }
  .brainstorm p { color: var(--v2-text-2); font-size: var(--v2-fs-body); line-height: 1.5; margin: 2px 0 0; }
  .brainstorm p b { color: var(--v2-text); font-weight: var(--v2-fw-medium); }
  .walknext { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
  .walknext .wn-prog { flex: 1 1 240px; display: flex; align-items: center; gap: 8px; font-size: var(--v2-fs-body); color: var(--v2-text-2); }
  .walknext .wn-prog svg { width: 14px; height: 14px; color: var(--v2-accent); flex: none; }
  .walknext.done .wn-prog svg { color: var(--v2-ok); }
  .held { display: flex; align-items: flex-start; gap: 10px; color: var(--v2-text-3); font-size: var(--v2-fs-meta); line-height: 1.5; }
  .held svg { width: 14px; height: 14px; color: var(--v2-text-3); flex: none; margin-top: 1px; }
  .held a { color: var(--v2-text-2); text-decoration: underline; text-decoration-color: var(--v2-border-strong); text-underline-offset: 2px; }
  .held a:hover { color: var(--v2-text); }
  .created .secondary { display: flex; align-items: center; gap: 4px; margin-top: 12px; flex-wrap: wrap; }

  /* ---- create tasks ---- */
  .taskqueue { list-style: none; margin: 0 0 14px; padding: 0; }
  .tq { display: flex; align-items: flex-start; gap: 10px; padding: 9px 0; }
  .tq + .tq { border-top: 1px solid var(--v2-border-subtle, var(--v2-border)); }
  .tq:first-child { padding-top: 0; }
  .tq .num { min-width: 20px; height: 20px; flex: none; display: grid; place-items: center; font-size: var(--v2-fs-meta); font-weight: var(--v2-fw-medium);
    color: var(--v2-text-3); font-variant-numeric: tabular-nums; }
  .tq .grow { flex: 1; min-width: 0; }
  .tq .tt { font-weight: var(--v2-fw-medium); font-size: var(--v2-fs-body); color: var(--v2-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 20px; }
  .tq .tq-dod { color: var(--v2-text-3); font-size: var(--v2-fs-meta); line-height: 1.45; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tq-empty { margin-bottom: 14px; }
  .taskform { border-top: 1px solid var(--v2-border-subtle, var(--v2-border)); padding-top: 14px; }
  #tqWrap:has(.tq-empty) + .taskform { border-top: 0; padding-top: 0; }
  .taskform .tf-h { font-size: var(--v2-fs-body); font-weight: var(--v2-fw-semibold); color: var(--v2-text); margin-bottom: 10px; }
  .taskform .tf-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
  .taskform .tf-actions .hint { font-size: var(--v2-fs-meta); color: var(--v2-text-3); }
  @media (pointer: coarse) { .taskform .tf-actions .hint { display: none; } }

  /* ---- G2: streaming (WorkedFor disclosure) ---- */
  .thinking .v2-worked-toggle { font-size: var(--v2-fs-body); }
  .thinking .th-t { color: var(--v2-text-3); font-variant-numeric: tabular-nums; }
  .thinking .dots { display: inline-flex; gap: 3px; margin-left: 8px; vertical-align: middle; }
  .thinking .dots i { width: 4px; height: 4px; border-radius: var(--v2-radius-full); background: var(--v2-text-2); opacity: .35; animation: thpulse 1.4s infinite; }
  .thinking .dots i:nth-child(2) { animation-delay: .18s; } .thinking .dots i:nth-child(3) { animation-delay: .36s; }
  @keyframes thpulse { 0%,100% { opacity: .25; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .thinking .dots i { animation: none; opacity: .6; } }
  .thinking .th-body { font-size: var(--v2-fs-body); line-height: 1.55; color: var(--v2-text-2); margin-top: 8px; max-height: 220px; overflow: auto;
    white-space: pre-wrap; overflow-wrap: anywhere; }
  .thinking .v2-worked-body { padding: 0 12px 10px; }
  .thinking.done .th-body { max-height: 160px; color: var(--v2-text-3); }
  .thinking + #pTurn:not(:empty) { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--v2-border-subtle, var(--v2-border)); }
  .clarify .field2 { margin-bottom: 14px; }
  .clarify .field2 .lab { font-size: var(--v2-fs-body); color: var(--v2-text); font-weight: var(--v2-fw-medium); line-height: 1.45; }
  .clarify .cl-actions, .perror .pe-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 4px; }
  .perror .pe-msg { display: flex; gap: 10px; align-items: flex-start; }
  .perror .pe-msg svg { width: 16px; height: 16px; color: var(--v2-warn); flex: none; margin-top: 2px; }
  .perror .pe-msg p { color: var(--v2-text); font-size: var(--v2-fs-body); line-height: 1.55; margin: 0; }
  .perror .pe-detail { color: var(--v2-text-3); font-size: var(--v2-fs-meta); margin: 6px 0 12px 26px; }
  .perror .pe-detail code { font-family: var(--v2-font-mono); font-size: var(--v2-fs-meta); color: var(--v2-text-2); }
  .perror .pe-msg + .pe-actions { margin-top: 14px; }
  /* phones: one full-width column, the primary (Retry) first — never a lone
     wrapped button on its own right-aligned line */
  @media (max-width: 480px) {
    .perror .pe-actions { flex-direction: column-reverse; align-items: stretch; }
    .perror .pe-actions > * { width: 100%; justify-content: center; }
  }
  .ob-denied { margin: 10px 2px 0; font-size: var(--v2-fs-meta); color: var(--v2-text-3); }

  /* ---- G3: editable roster (band headers + quiet inline fields) ---- */
  .rationale { display: flex; align-items: flex-start; gap: 8px; margin: -6px 0 18px; color: var(--v2-text-2); font-size: var(--v2-fs-body); line-height: 1.55; max-width: 72ch; }
  .rationale svg { width: 14px; height: 14px; color: var(--v2-accent); flex: none; margin-top: 3px; }
  .rsec .v2-group { border-bottom: 1px solid var(--v2-border-subtle, var(--v2-border)); }
  .rsec .v2-group-glyph svg { width: 14px; height: 14px; }
  .rcard, .rtask { padding: 10px 12px; }
  .rtask { display: grid; gap: 2px; }
  .rcard + .rcard, .rtask + .rtask { border-top: 1px solid var(--v2-border-subtle, var(--v2-border)); }
  /* avatar | one column of inline-edit fields | remove — avatar top-aligned with the name */
  .rcard { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 0 8px; align-items: start; }
  .rcard > .v2-av, .rcard > [class*="av"] { margin-top: 4px; }
  .rcard > .v2-btn-icon, .rcard > button { margin-top: 2px; }
  .rcard .rc-body { display: grid; gap: 2px; min-width: 0; }
  .rcard .rc-top { display: flex; gap: 4px; align-items: center; min-width: 0; }
  .rcard .rc-name { flex: 1 1 0; min-width: 0; font-weight: var(--v2-fw-medium); text-overflow: ellipsis; }
  /* sized to its (short) display name; never shrunk into "claude-opu…" */
  .rcard .rc-model { flex: none; display: inline-flex; }
  .rcard .rc-role, .rcard .rc-charter, .rtask .rt-dod { resize: none; }
  /* one inline-edit style for every roster field: same box, only the ink differs */
  .rcard .rc-role, .rcard .rc-charter { color: var(--v2-text-2); }
  .rcard .rc-charter { max-height: 220px; }
  .rcard .rc-role:focus, .rcard .rc-charter:focus, .rtask .rt-dod:focus { color: var(--v2-text); }
  .rtask .rt-top { display: flex; gap: 8px; align-items: center; }
  .rtask .rt-title { font-weight: var(--v2-fw-medium); text-overflow: ellipsis; }
  .rtask .rt-dod { color: var(--v2-text-3); }
  .rtask .rt-meta { display: flex; align-items: center; gap: 6px 12px; flex-wrap: wrap; font-size: var(--v2-fs-meta); color: var(--v2-text-2); padding: 4px 6px 2px; }
  .rtask .rt-meta { margin-left: -2px; }
  .rtask .rt-assign { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; }
  .rtask .rt-who { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .rtask .rt-who .rt-noav { width: 14px; height: 14px; color: var(--v2-text-3); flex: none; }
  /* Kickoff = a D8 check chip (screen review r3: the accent-filled square read
     as a native checkbox beside the ghost dropdown). Still a real
     <input type=checkbox> (keyboard + screen reader); the shared .v2-checkbox
     box is the shared dot variant: hollow ring off, filled accent on. */
  .rtask .rt-kick { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; height: 22px; padding: 0 9px 0 8px;
    border: 1px solid var(--v2-border); border-radius: 999px; color: var(--v2-text-2); white-space: nowrap;
    transition: background-color var(--v2-dur-fast, 90ms), border-color var(--v2-dur-fast, 90ms), color var(--v2-dur-fast, 90ms); }
  .rtask .rt-kick:hover { color: var(--v2-text); background: var(--v2-hover); border-color: var(--v2-border-strong); }
  .rtask .rt-kick:has(input:checked) { color: var(--v2-text); background: var(--v2-selected, var(--v2-hover)); border-color: var(--v2-border-strong); }
  .rtask .rt-kick:has(input:focus-visible) { box-shadow: var(--v2-focus-ring); }
  /* the dot itself is the shared .v2-checkbox.v2-check-dot variant (v2-primitives.css) */
  .rtask .rt-kick:has(input[disabled]) { opacity: .5; cursor: not-allowed; }
  .rtask .rt-kick:has(input[disabled]):hover { background: transparent; color: var(--v2-text-2); border-color: var(--v2-border); }
  /* phones: an agent card stays name + role (1 line) + charter (2 lines) until
     tapped; a longer field fades out at the cut (data-over, AutoTextarea) */
  @media (max-width: 600px) {
    .rcard .rc-role[data-clamp]:not(:focus) { max-height: calc(1.5em + 12px); overflow: hidden; }
    .rcard .rc-charter[data-clamp]:not(:focus) { max-height: calc(3em + 12px); overflow: hidden; }
    /* a clipped field drops its bottom padding (moved to margin) so the next
       line can't peek through the padding box */
    .rcard .rc-role[data-over]:not(:focus), .rcard .rc-charter[data-over]:not(:focus) { padding-bottom: 0; margin-bottom: 5px; min-height: 0; }
    .rcard .rc-role[data-over]:not(:focus) { max-height: calc(1.5em + 7px); }
    .rcard .rc-charter[data-over]:not(:focus) { max-height: calc(3em + 7px); }
    .rcard .rc-role[data-over]:not(:focus) { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 56px), transparent calc(100% - 8px)); mask-image: linear-gradient(to right, #000 calc(100% - 56px), transparent calc(100% - 8px)); }
    .rcard .rc-charter[data-over]:not(:focus) { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent calc(100% - 4px)); mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent calc(100% - 4px)); }
  }
  .rt-empty { padding: 14px; }
`;
