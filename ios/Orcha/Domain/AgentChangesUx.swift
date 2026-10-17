import Foundation

/// Pure helpers for the live-changes list.
enum AgentChangesUx {
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tif", "tiff", "ico"]

    static func isImage(_ path: String) -> Bool {
        guard let ext = path.split(separator: ".").last, path.contains(".") else { return false }
        return imageExtensions.contains(ext.lowercased())
    }

    /// Plain status words — no raw git letters.
    static func statusLabel(_ status: String) -> String {
        switch status.prefix(1) {
        case "A", "?": "Added"
        case "D": "Deleted"
        case "R": "Renamed"
        case "C": "Copied"
        default: "Modified"
        }
    }

    static func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// Plain copy for an unavailable payload's reason.
    static func unavailableCopy(_ reason: String?, detail: String?) -> String {
        switch reason {
        case "no_checkout": "This run has no checkout to read changes from."
        case "not_found", "missing": "The run's checkout is no longer on disk."
        default: detail ?? "Changes are not available for this run."
        }
    }
}
