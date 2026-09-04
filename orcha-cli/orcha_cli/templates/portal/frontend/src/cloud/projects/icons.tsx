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
