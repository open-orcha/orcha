import Foundation

/// Pure mapping between the server's per-user cosmetic prefs bag (mig 040,
/// `GET/PUT /api/prefs`) and the app's theme/skin settings.
///
/// Contract (web `app-prefs.js` parity):
///   * `prefs == null` on GET is the self-host / trust-off / unmapped signal —
///     the app stays pure-local (nothing here runs).
///   * A non-null bag means server prefs are ACTIVE: SERVER WINS — apply
///     theme/skin and mirror them into the local store.
///   * Writes are a WHOLE-BAG replace server-side, so a PUT must carry every key
///     the account holds (sidebar / default_cid included) — `mergedBag` folds the
///     app's theme/skin over the last-fetched bag, never dropping foreign keys.
/// The value vocabulary is shared with the web: theme auto|light|dark, skin
/// classic|swiss — both are exactly the iOS raw values.
enum PrefsSync {

    /// The server's theme pick, when present AND valid — an unknown value is
    /// ignored (never clobber a working local setting with garbage).
    static func resolveTheme(_ prefs: [String: Any]) -> ThemeMode? {
        (prefs["theme"] as? String).flatMap(ThemeMode.init(rawValue:))
    }

    /// The server's skin pick, when present and valid.
    static func resolveSkin(_ prefs: [String: Any]) -> SkinMode? {
        (prefs["skin"] as? String).flatMap(SkinMode.init(rawValue:))
    }

    /// The full bag to PUT after a local theme/skin change: the last-fetched
    /// server bag with the app-managed keys replaced (whole-bag-replace safety —
    /// keys iOS doesn't manage, like `sidebar`/`default_cid`, ride along intact).
    static func mergedBag(_ current: [String: Any]?, theme: ThemeMode, skin: SkinMode) -> [String: Any] {
        var bag = current ?? [:]
        bag["theme"] = theme.rawValue
        bag["skin"] = skin.rawValue
        return bag
    }
}
