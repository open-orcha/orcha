/** Route-derived presentation for an embedded portal view.
 *
 * Generic Code Space keeps the ordinary desktop/portal chrome. Only the
 * task-linked review mode (`/code?task=…`) owns the whole window, matching the
 * portal's own shell-less mode and avoiding surprising chrome changes for the
 * existing standalone Code Space.
 */
export function isTaskCodeSpaceUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, 'http://localhost')
    return url.pathname === '/code' && !!url.searchParams.get('task')
  } catch {
    return false
  }
}
