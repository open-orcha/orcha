/**
 * "Embodent was updated · Reload" — the portal noticing it was upgraded underneath it.
 *
 * A long-lived tab (and every desktop-embedded portal view) keeps running the bundle it
 * loaded, so after `orcha upgrade` people kept seeing the old UI and new features looked
 * missing. Every minute, and whenever the tab regains focus, fetch the page shell uncached
 * and compare its entry script with the one this page is running; when they differ, show a
 * calm one-line notice with a Reload button. Dev servers (no hashed entry) never notify.
 */
import { useEffect, useState } from "react";

const ENTRY_RE = /\/assets\/dist\/assets\/(index-[A-Za-z0-9_-]+\.js)/;
export const UPDATE_CHECK_MS = 60_000;

/** The hashed entry bundle a page-shell HTML loads, or null (dev server, unexpected shape). */
export function entryScriptOf(html: string): string | null {
  const m = ENTRY_RE.exec(html);
  return m ? m[1] : null;
}

/** The entry bundle this page is running. */
export function runningEntry(doc: Document = document): string | null {
  for (const s of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    const e = entryScriptOf(s.getAttribute("src") || "");
    if (e) return e;
  }
  return null;
}

export function useNewVersion(intervalMs = UPDATE_CHECK_MS): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const current = runningEntry();
    if (!current) return; // dev server / tests: nothing to compare
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState === "hidden") return;
      try {
        const res = await fetch(window.location.pathname || "/", { cache: "no-store", headers: { Accept: "text/html" } });
        if (!res.ok) return;
        const next = entryScriptOf(await res.text());
        if (!stop && next && next !== current) setAvailable(true);
      } catch {
        /* offline — StaleBar already says so */
      }
    };
    const id = window.setInterval(check, intervalMs);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      stop = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [intervalMs]);
  return available;
}

export function UpdateNotice() {
  const available = useNewVersion();
  if (!available) return null;
  return (
    <div className="v2-update-notice" role="status" data-testid="update-notice">
      <span className="v2-update-dot" aria-hidden="true" />
      <span>Embodent was updated. Reload to get the latest version.</span>
      <button type="button" className="v2-update-btn" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
