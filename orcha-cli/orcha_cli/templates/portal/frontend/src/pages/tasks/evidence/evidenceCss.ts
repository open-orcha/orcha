/**
 * Proof-of-work evidence styles (owner: proof-verdikt). Tokens only (no hex),
 * no coloured stripes (D3), colour lives in small glyphs/text (D8/D12),
 * hairlines + hover fills, 13 px rows / 12 px meta (D6). Mono only for commands,
 * file paths and branch names (D15).
 */
export const evidenceCss = String.raw`
  .ev-row { min-width: 0; }
  .ev-line { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; min-width: 0; font-size: 13px; line-height: 20px; }
  .ev-part { display: inline-flex; align-items: center; gap: 5px; color: var(--v2-text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ev-part .v2-ico, .ev-part svg { width: 14px; height: 14px; flex: none; }
  /* the "·" sits in the gap BEFORE a part; a part that wraps to the start of a line would
     lead with it, so it is positioned into the gap and the line clips its own left edge */
  .ev-part + .ev-part { position: relative; }
  .ev-part + .ev-part::before { content: "·"; position: absolute; left: -7px; color: var(--v2-text-3); }
  .ev-line, .ev-vk-line { clip-path: inset(-8px -8px -8px 0); }
  .ev-ok { color: var(--v2-ok); }
  .ev-warn { color: var(--v2-warn); }
  .ev-bad { color: var(--v2-danger); }
  .ev-mut { color: var(--v2-text-3); }
  .ev-toggle { margin-left: 2px; }
  .ev-toggle .v2-ico { transform: rotate(-90deg); transition: transform var(--v2-dur-fast, 120ms) ease; }
  .ev-toggle[aria-expanded="true"] .v2-ico { transform: none; }

  .ev-body { display: flex; flex-direction: column; gap: 14px; margin-top: 10px; padding: 10px 0 2px; border-top: 1px solid var(--v2-border); }
  .ev-sec-h { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 12px; font-weight: var(--v2-fw-medium, 500); color: var(--v2-text-3); }
  .ev-sec-h .v2-grow { flex: 1; }
  .ev-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .ev-item { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 8px; padding: 4px 6px; margin: 0 -6px; border-radius: var(--v2-radius-control, 6px); }
  .ev-item:hover { background: var(--v2-hover); }
  .ev-glyph { width: 16px; height: 20px; display: inline-flex; align-items: center; justify-content: center; }
  .ev-glyph svg { width: 14px; height: 14px; }
  .ev-t { color: var(--v2-text); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
  .ev-m { color: var(--v2-text-3); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
  .ev-claim { color: var(--v2-text-3); font-size: 12px; line-height: 18px; font-style: italic; overflow-wrap: anywhere; }
  .ev-claim b { font-style: normal; font-weight: var(--v2-fw-medium, 500); color: var(--v2-text-2); }
  .ev-code { font-family: var(--v2-font-mono); font-size: 12px; color: var(--v2-text-2); overflow-wrap: anywhere; }
  .ev-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .ev-chip { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border: 1px solid var(--v2-border); border-radius: 999px;
    font-size: 12px; color: var(--v2-text-2); background: transparent; }
  .ev-chip .ev-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .ev-chip.ev-warn { color: var(--v2-warn); }
  .ev-chip.ev-bad { color: var(--v2-danger); }
  .ev-chip > span { color: var(--v2-text-2); }
  .ev-links { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 12.5px; }
  .ev-links a { color: var(--v2-accent); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
  .ev-links a:hover { text-decoration: underline; }
  .ev-links .v2-ico { width: 13px; height: 13px; }
  .ev-foot { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--v2-text-3); }

  .ev-vk-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 13px; }
  .ev-vk-actions { display: inline-flex; gap: 6px; margin-left: auto; }
  .ev-shots { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .ev-shot { display: block; width: 132px; border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control, 6px); overflow: hidden; background: var(--v2-surface);
    text-decoration: none; color: var(--v2-text-3); font-size: 11.5px; }
  .ev-shot img { display: block; width: 100%; height: 82px; object-fit: cover; object-position: top; background: var(--v2-canvas); }
  .ev-shot span { display: block; padding: 3px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ev-shot:hover { border-color: var(--v2-border-strong); }
  .ev-shot-miss .ev-shot-ph { display: flex; align-items: center; height: 82px; padding: 6px; white-space: normal; color: var(--v2-text-3); background: var(--v2-canvas); font-size: 11.5px; }
  .ev-inp { height: 26px; padding: 0 8px; border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control, 6px); background: var(--v2-surface);
    color: var(--v2-text); font: inherit; font-size: 13px; }
  .ev-inp:focus-visible { outline: none; box-shadow: var(--v2-focus-ring); border-color: var(--v2-accent); }
  .ev-err { font-size: 12.5px; color: var(--v2-text-2); margin-top: 4px; overflow-wrap: anywhere; }
  .ev-pv { margin-top: 6px; }
  .ev-pv .ev-part { white-space: normal; overflow-wrap: anywhere; }
  .ev-pv-log { margin: 4px 0 0; padding: 6px 8px; max-height: 220px; overflow: auto; border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-control, 6px); background: var(--v2-canvas); color: var(--v2-text-2);
    font-family: var(--v2-font-mono); font-size: 11.5px; line-height: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .ev-vk-hist { margin-top: 8px; font-size: 12px; color: var(--v2-text-3); }
  .ev-vk-hist > summary { cursor: pointer; list-style: none; width: fit-content; }
  .ev-vk-hist > summary::-webkit-details-marker { display: none; }
  .ev-vk-hist > summary:hover { color: var(--v2-text-2); }
  .ev-vk-hist .ev-list { margin-top: 4px; }
  .ev-vk-row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; padding: 2px 6px; margin: 0 -6px; border-radius: var(--v2-radius-control, 6px); }
  .ev-vk-row:hover { background: var(--v2-hover); }
  .ev-vk-row > a { margin-left: auto; }
  .ev-shimmer { background: linear-gradient(90deg, var(--v2-text-3) 0%, var(--v2-text) 50%, var(--v2-text-3) 100%); background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent; animation: ev-shim 1.6s linear infinite; }
  @keyframes ev-shim { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  @media (prefers-reduced-motion: reduce) { .ev-shimmer { animation: none; color: var(--v2-text-2); background: none; } }
`;
