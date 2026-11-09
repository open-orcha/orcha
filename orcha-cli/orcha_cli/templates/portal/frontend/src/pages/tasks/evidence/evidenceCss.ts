/**
 * Proof-of-work evidence styles. Tokens only (no hex),
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
  .ev-line { clip-path: inset(-8px -8px -8px 0); }
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
  .ev-proof { display: inline-block; margin-inline-start: 4px; padding: 0 6px; border-radius: var(--v2-radius-control, 6px); font-size: 11.5px; line-height: 17px; white-space: nowrap; vertical-align: 1px; }
  .ev-proof.is-strong { color: var(--v2-text); background: var(--v2-active, var(--v2-hover)); }
  .ev-proof.is-weak { color: var(--v2-text-3); border: 1px dashed var(--v2-border); line-height: 15px; }
  .ev-proof.is-none { color: var(--v2-text-3); }
  .ev-why { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding: 8px 10px; border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control, 6px); }
  .ev-why-h { margin: 0; color: var(--v2-text); font-size: 13px; line-height: 20px; }
  .ev-why-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .ev-why-list li { display: flex; flex-direction: column; min-width: 0; }
  .ev-qa { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
  .ev-qa .ev-links { margin-top: 0; }
  .ev-t a { color: inherit; text-decoration: none; }
  .ev-t a:hover { text-decoration: underline; }
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
`;
