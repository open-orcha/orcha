// Page-scoped styles carried verbatim from static/tasks.html's inline <style>
// block (they are not part of the shared styles.css).
export const tasksPageCss = String.raw`
  /* (the legacy .tlist-card/.tgrp/.trow list styles were retired in V2 — rows
     are the V2 Row primitive + workCss .wk-row; .trow survives only as a hook) */
  /* SPEC-4 protocol panel (ported from docs/portal-redesign-ref/protocol-panel.html) */
  .proto { border: 1px solid var(--border); border-radius: 15px; background: var(--surface); box-shadow: var(--shadow-sm); overflow: hidden; margin-bottom: 18px; }
  .proto > .ph { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--border); cursor: pointer; flex-wrap: wrap; }
  .proto.collapsed > .ph { border-bottom: 0; }
  .proto > .ph .ttl { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .proto > .ph .ttl svg { width: 14px; height: 14px; color: var(--v2-text-3, var(--muted)); }
  .proto > .ph .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .proto > .ph .grow { flex: 1; }
  .proto > .ph .chev { transition: transform .15s; color: var(--muted); display: inline-flex; }
  .proto.collapsed > .ph .chev { transform: rotate(-90deg); }
  .pchip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; white-space: nowrap;
    height: 22px; padding: 0 8px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2); }
  .pchip .lbl { color: var(--faint); font-weight: 500; }
  .pchip.aut { color: var(--text-2); }
  .proto .pb { padding: 6px 16px 16px; display: grid; gap: 2px; }
  .proto.collapsed .pb { display: none; }
  .prow { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 6px 0; align-items: baseline; }
  .prow .k { color: var(--faint); font-size: 13px; font-weight: 400; }
  .prow .v { font-size: 13px; font-weight: 500; line-height: 1.5; }
  .prow .v.notes { font-weight: 450; color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
  .prow .v .arrowchain { font-family: "JetBrains Mono", monospace; font-size: 12.5px; }
  .proto.editing .prow .v { display: none; }
  .prow .edit { display: none; }
  .proto.editing .prow .edit { display: block; }
  .prow input, .prow textarea { width: 100%; background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 13px; outline: none; }
  .prow input:focus, .prow textarea:focus { border-color: var(--accent-line); box-shadow: var(--ring); }
  .prow textarea { min-height: 64px; resize: vertical; }
  .proto .pf { display: none; justify-content: flex-end; gap: 8px; padding: 0 16px 16px; }
  .proto.editing .pf { display: flex; }
  .proto.editing .ph .editbtn { display: none; }
  .empty-proto { color: var(--faint); font-size: 13px; padding: 14px 16px; }
  /* #301: attachment composer (paperclip + drag-drop + staging tray) */
  .reply-wrap { display: flex; flex-direction: column; gap: 8px; }
  .reply-wrap.dragover { outline: 2px dashed var(--accent-line); outline-offset: 3px; border-radius: 11px; }
  .message-composer.message-composer.task-thread-composer { padding: 0; border-top: 0; }
  .attach-tray { display: flex; flex-wrap: wrap; gap: 8px; }
  .attach-tray:empty { display: none; }
  .att-chip { display: inline-flex; align-items: center; gap: 8px; max-width: 230px; padding: 5px 8px;
    border-radius: 9px; border: 1px solid var(--border); background: var(--surface-2); font-size: 12px; }
  .att-chip .thumb { width: 28px; height: 28px; border-radius: 6px; object-fit: cover; flex: 0 0 auto;
    background: var(--surface-3); }
  .att-chip .ic { width: 28px; height: 28px; border-radius: 6px; flex: 0 0 auto; display: inline-flex;
    align-items: center; justify-content: center; background: var(--surface-3); color: var(--muted); }
  .att-chip .ic svg { width: 15px; height: 15px; }
  .att-chip .meta { min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
  .att-chip .nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .att-chip .sz { color: var(--faint); font-size: 10.5px; }
  .att-chip .rm { flex: 0 0 auto; cursor: pointer; color: var(--faint); border: 0; background: none; font-size: 15px;
    line-height: 1; padding: 0 2px; }
  .att-chip .rm:hover { color: var(--danger); }
  .att-chip.uploading { opacity: .6; }
  .att-chip.failed { border-color: var(--danger-line, var(--danger)); }
  /* in-thread rendered attachments (read view) */
  .msg-atts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 7px; }
  .msg-atts .att-img { max-width: 200px; max-height: 150px; border-radius: 9px; border: 1px solid var(--border);
    cursor: zoom-in; display: block; object-fit: cover; }
  .msg-atts .att-file { display: inline-flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 9px;
    border: 1px solid var(--border); background: var(--surface-2); font-size: 12px; color: var(--text); text-decoration: none; }
  .msg-atts .att-file:hover { border-color: var(--accent-line); background: var(--accent-soft); }
  .msg-atts .att-file svg { width: 15px; height: 15px; color: var(--muted); flex: 0 0 auto; }
  .msg-atts .att-file .sz { color: var(--faint); font-size: 10.5px; }
  /* lightbox */
  .att-lightbox { position: fixed; inset: 0; z-index: 2000; background: var(--v2-lightbox-bg); display: flex;
    align-items: center; justify-content: center; padding: 32px; cursor: zoom-out; }
  .att-lightbox img { max-width: 95vw; max-height: 92vh; border-radius: 10px; box-shadow: var(--v2-shadow-lightbox); }
`;
