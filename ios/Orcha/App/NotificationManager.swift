import BackgroundTasks
import SwiftUI
import UserNotifications

/// Local "needs you" notifications — no server, no cloud. A background app
/// refresh (iOS-scheduled, opportunistic — think "within the hour", not
/// real-time) fetches every paired container's snapshot over whichever address
/// answers (LAN or the Tailscale remote), diffs the needs-you set against what
/// was already seen or notified, and posts one notification per NEW item.
/// Tapping a notification deep-links to the exact task/request screen.
@MainActor
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()
    static let refreshTaskId = "io.openorcha.mobile.refresh"
    private static let seenKey = "orcha_notified_ids"

    /// Assigned by the app root so notification taps can drive navigation.
    weak var model: AppModel?

    // MARK: permission

    func requestPermission() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        return granted
    }

    // MARK: background refresh

    /// Must run before the app finishes launching (called from OrchaApp.init).
    nonisolated static func registerBackgroundTask() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshTaskId, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            Task { await NotificationCoordinator.shared.handleAppRefresh(refresh) }
        }
    }

    nonisolated static func scheduleAppRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handleAppRefresh(_ task: BGAppRefreshTask) async {
        Self.scheduleAppRefresh()   // keep the chain alive regardless of outcome
        let work = Task { await self.sweepAndNotify() }
        task.expirationHandler = { work.cancel() }
        await work.value
        task.setTaskCompleted(success: true)
    }

    // MARK: the sweep

    /// One needs-you item, flattened for diffing + notification content.
    struct Item {
        let key: String            // "cid|kind|id" — stable identity + notification id
        let route: NotifRoute
        let title: String
        let body: String
    }

    struct NotifRoute {
        let containerId: String
        let kind: String           // "task" | "request"
        let id: String
    }

    func sweepAndNotify() async {
        guard ContainerStore().loadNotificationsEnabled() else { return }
        let api = OrchaApiClient()
        var items: [Item] = []
        var first = true
        for stored in ContainerStore().load() {
            guard !Task.isCancelled else { return }
            let snap = await Self.fetchSnapshot(api, stored)
            guard let snap else { continue }
            items.append(contentsOf: Self.needsYou(snap, container: stored))
            // Keep the widget fresh from the same sweep. The on-device headline
            // is generated for the primary (most recent) workspace only — the
            // background window is ~30s and inference isn't free.
            var headline: String?
            if first, #available(iOS 26, *), DecisionAssist.isAvailable {
                headline = try? await DecisionAssist.statusBrief(for: WorkspaceDigest.make(snap)).headline
            }
            first = false
            WidgetPublisher.publish(snap, container: stored, headline: headline)
        }
        let seen = Set(UserDefaults.standard.stringArray(forKey: Self.seenKey) ?? [])
        let fresh = items.filter { !seen.contains($0.key) }

        let center = UNUserNotificationCenter.current()
        for item in fresh {
            let content = UNMutableNotificationContent()
            content.title = item.title
            content.body = item.body
            content.sound = .default
            content.userInfo = [
                "cid": item.route.containerId, "kind": item.route.kind, "id": item.route.id,
            ]
            try? await center.add(UNNotificationRequest(identifier: item.key, content: content, trigger: nil))
        }
        // Seen = everything currently pending (bounded by live items, so it can't
        // grow without limit; resolved items fall out and may re-notify if they
        // ever come back — which is the correct behavior for a re-opened gate).
        UserDefaults.standard.set(items.map(\.key), forKey: Self.seenKey)
        try? await center.setBadgeCount(items.count)
    }

    /// Foreground catch-up: anything visible in the open app counts as seen and
    /// must never fire later from the background sweep.
    func markSeen(_ snap: ContainerSnapshot, container: StoredContainer) {
        let current = Self.needsYou(snap, container: container).map(\.key)
        var seen = Set(UserDefaults.standard.stringArray(forKey: Self.seenKey) ?? [])
        seen.formUnion(current)
        UserDefaults.standard.set(Array(seen), forKey: Self.seenKey)
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: current)
    }

    private static func fetchSnapshot(_ api: OrchaApiClient, _ stored: StoredContainer) async -> ContainerSnapshot? {
        if let snap = try? await api.snapshot(stored.baseUrl, stored.id) { return snap }
        if let remote = stored.remoteBaseUrl, !remote.isEmpty {
            return try? await api.snapshot(remote, stored.id)
        }
        return nil
    }

    /// The same gate set the Home tab surfaces (plans awaiting approval, tasks
    /// awaiting verification, open requests aimed at the paired human).
    static func needsYou(_ snap: ContainerSnapshot, container: StoredContainer) -> [Item] {
        let cid = container.id
        let name = container.displayName
        var items: [Item] = []
        for t in snap.tasks where t.status == "in_progress" && t.planMessage != nil && t.planDecision == nil {
            items.append(Item(
                key: "\(cid)|task|\(t.id)|plan",
                route: NotifRoute(containerId: cid, kind: "task", id: t.id),
                title: "Plan approval — \(name)",
                body: t.title
            ))
        }
        for t in snap.tasks where t.status == "needs_verification" {
            items.append(Item(
                key: "\(cid)|task|\(t.id)|verify",
                route: NotifRoute(containerId: cid, kind: "task", id: t.id),
                title: "Verify task — \(name)",
                body: t.title
            ))
        }
        for r in snap.requests where r.status == "open" && (r.targetId == container.humanAgentId || r.targetId == nil) {
            items.append(Item(
                key: "\(cid)|request|\(r.id)",
                route: NotifRoute(containerId: cid, kind: "request", id: r.id),
                title: "Request for you — \(name)",
                body: String(r.payload.prefix(140))
            ))
        }
        return items
    }

    // MARK: taps → the exact screen

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard
            let cid = info["cid"] as? String,
            let kind = info["kind"] as? String,
            let id = info["id"] as? String
        else { return }
        await MainActor.run {
            let route: WorkspaceRoute = kind == "request" ? .request(id) : .task(id)
            self.model?.openFromNotification(containerId: cid, route: route)
        }
    }

    /// The in-app "Needs you" badge already covers the foreground for REAL
    /// alerts — but the test alert must present in-foreground, or the button
    /// depends on backgrounding the app within 3s and reads as broken when the
    /// race is lost (the notification is discarded without a trace).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        notification.request.identifier == "orcha-test" ? [.banner, .sound] : []
    }

    // MARK: test hook (Settings → "Send test notification")

    /// Posts a real notification 3s out, targeting the first live needs-you item
    /// so the tap exercises the exact deep-link path end-to-end. Every outcome
    /// is reported back — a silent no-op here is indistinguishable from broken.
    func sendTest(model: AppModel) async -> String {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized else {
            return "iOS has notifications blocked for Orcha — allow them in Settings → Apps → Orcha → Notifications, then retry."
        }
        var target: Item?
        if let sel = model.selectedContainer, let snap = model.snapshot {
            target = Self.needsYou(snap, container: sel).first
        }
        let content = UNMutableNotificationContent()
        content.title = target?.title ?? "Orcha — test"
        content.body = target?.body ?? "Notifications are working. Nothing needs you right now."
        content.sound = .default
        if let target {
            content.userInfo = [
                "cid": target.route.containerId, "kind": target.route.kind, "id": target.route.id,
            ]
        }
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 3, repeats: false)
        do {
            try await center.add(
                UNNotificationRequest(identifier: "orcha-test", content: content, trigger: trigger)
            )
            return target == nil
                ? "Arriving in 3 seconds — it shows even while the app is open."
                : "Arriving in 3 seconds — tap it to jump straight to that item. It shows even while the app is open."
        } catch {
            return "Couldn't schedule the alert: \(error.localizedDescription)"
        }
    }
}
