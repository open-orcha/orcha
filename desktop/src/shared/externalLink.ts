/** Which URLs the app may hand to the OS browser (shell.openExternal). Web links only —
 *  http(s) (local portals are http://localhost:PORT) — never file://, app schemes or
 *  javascript:, so a terminal program or page can't open anything else on the Mac. */
export function isExternalWebLink(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 8192) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== ''
  } catch {
    return false
  }
}
