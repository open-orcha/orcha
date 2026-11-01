// orcha-status-writer: writes the widget's status.json into the app's own App Group
// container (GH #397). Ships at Contents/MacOS/orcha-status-writer and is signed with the
// main app's entitlements (scripts/macSign.cjs), so it is the entitled process macOS
// expects to touch the group container. The Electron app never touches Group Containers
// itself; it pipes the JSON here on stdin.
//
// Before any folder access it checks that this binary is entitled to `<team>.orcha`
// AND that <team> is the TeamIdentifier it is actually signed with (an ad-hoc or
// other-team signature can claim the entitlement but does not own the group), then
// gets the folder from containerURL(forSecurityApplicationGroupIdentifier:) instead of
// building the path by hand.
//
// Exit codes (read by src/main/statusFile.ts):
//   0 written  1 transient failure  2 bad input  3 no owned group  4 access denied
import Foundation
import Security

let appGroupSuffix = ".orcha"
let maxInputBytes = 256 * 1024

/// The TeamIdentifier of this process's own signature, or nil (ad-hoc / unsigned).
func signingTeam() -> String? {
  var code: SecCode?
  guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
  var info: CFDictionary?
  let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
  guard SecCodeCopySigningInformation(staticCode, flags, &info) == errSecSuccess,
        let dict = info as? [String: Any],
        let team = dict[kSecCodeInfoTeamIdentifier as String] as? String,
        !team.isEmpty
  else { return nil }
  return team
}

/// The app groups this running process is entitled to (as enforced at runtime).
func entitledGroups() -> [String] {
  guard let task = SecTaskCreateFromSelf(nil),
        let value = SecTaskCopyValueForEntitlement(task, "com.apple.security.application-groups" as CFString, nil)
  else { return [] }
  return (value as? [String]) ?? []
}

/// `<team>.orcha`, only when the signing team owns it and the entitlement claims it.
func ownedGroup() -> String? {
  guard let team = signingTeam() else { return nil }
  let group = team + appGroupSuffix
  return entitledGroups().contains(group) ? group : nil
}

func isDenied(_ error: Error) -> Bool {
  let ns = error as NSError
  if ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteNoPermissionError { return true }
  let posix = (ns.userInfo[NSUnderlyingErrorKey] as? NSError) ?? ns
  return posix.domain == NSPOSIXErrorDomain && (posix.code == Int(EPERM) || posix.code == Int(EACCES))
}

guard let group = ownedGroup(),
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
else { exit(3) }

let input = FileHandle.standardInput.readDataToEndOfFile()
guard !input.isEmpty, input.count <= maxInputBytes,
      (try? JSONSerialization.jsonObject(with: input)) is [String: Any]
else { exit(2) }

do {
  try input.write(to: container.appendingPathComponent("status.json"), options: .atomic)
  exit(0)
} catch {
  exit(isDenied(error) ? 4 : 1)
}
