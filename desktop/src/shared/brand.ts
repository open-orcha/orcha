/** User-facing product name. The app is branded "Embodent"; internal identifiers keep the
 *  historical `orcha` spelling for compatibility (the `orcha` CLI, ORCHA_* env vars, IPC
 *  channels, `orcha://` deep links, compose project names, the appId, userData folder). */
export const PRODUCT_NAME = 'Embodent'

/** The userData folder name from before the rebrand (~/Library/Application Support/Orcha).
 *  Kept so existing installs retain their prefs, session restore, agent settings, hook
 *  token and project-icon cache after the product name changed. */
export const LEGACY_USER_DATA_DIRNAME = 'Orcha'
