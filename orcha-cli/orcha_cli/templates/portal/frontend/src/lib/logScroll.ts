/**
 * Bottom-follow helpers for the worker-run log feeds.
 *
 * The shared stylesheet gives `.log` `scroll-behavior: smooth`. A plain
 * `el.scrollTop = el.scrollHeight` therefore starts an ASYNC smooth-scroll
 * animation — the very next `scrollTop` read (the vanilla `atBottom` guard,
 * or a scroll listener fired mid-animation) sees a position far from the
 * bottom and the feed permanently stops following. Empirically both the
 * vanilla portal and the first React port ended every painted log stuck at
 * the TOP (boot noise) instead of the latest activity, and a live stream
 * never followed its own lines.
 *
 * `pinToBottom` scrolls INSTANTLY (bypassing the CSS smooth behavior), so a
 * pinned log reads back `scrollTop === scrollHeight - clientHeight` exactly
 * and `nearBottom` stays true across appends of any row height — the feed
 * follows until the human actually scrolls away, and resumes when they
 * return to the bottom. This is the behavior the engine always intended
 * ("stick to the bottom while the reader is at the bottom").
 */

/** True while the reader is (still) effectively at the bottom of the log. */
export function nearBottom(el: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop < 36;
}

/** Instantly pin the log to its bottom (never smooth — see module docs). */
export function pinToBottom(el: Pick<HTMLElement, "scrollHeight" | "scrollTop"> & Partial<Pick<HTMLElement, "scrollTo">>): void {
  if (typeof el.scrollTo === "function") {
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior });
  } else {
    // jsdom / very old engines: direct assignment (no smooth CSS in play there)
    el.scrollTop = el.scrollHeight;
  }
}
