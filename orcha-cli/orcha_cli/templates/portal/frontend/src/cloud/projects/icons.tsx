/**
 * Icons the vanilla pages use that the open ui.tsx Icon map doesn't carry
 * (app-ui.js paths, verbatim): phone (the per-card "Pair phone" button) and
 * alert (pairing warnings). Same svg wrapper/class contract as ui.tsx Icon.
 */
const LOCAL_I: Record<string, string> = {
  phone: '<rect x="6" y="2.5" width="8" height="15" rx="2"/><path d="M8.8 5h2.4M9.5 15.2h1"/>',
  alert: '<path d="M10 3 17 16H3z"/><path d="M10 7.2v4.2M10 14.2h.01"/>',
  // Connect-repo picker's "This machine" section (Orcha Cloud local run,
  // Addendum 2) — a plain folder glyph for the local-repo entry.
  folder: '<path d="M3 6a1.5 1.5 0 0 1 1.5-1.5H8l1.6 2H15.5A1.5 1.5 0 0 1 17 8v6.5A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z"/>',
};

export function CloudIcon({ name, cls = "ico" }: { name: string; cls?: string }) {
  return (
    <svg
      className={cls || "ico"}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: LOCAL_I[name] || "" }}
    />
  );
}

/** GitHub mark (filled, 16-unit grid) — the repo cell's glyph for a GitHub binding. */
export function GitHubMark({ cls = "ico" }: { cls?: string }) {
  return (
    <svg className={cls} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
