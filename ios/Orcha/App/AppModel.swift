import Foundation
import Observation

/// Per-card reachability + glance counts for the Containers home (flow 04 H1).
struct ContainerHealth: Equatable {
    var state: String            // live | polling | unreachable | probing
    var agents: Int = 0
    /// GH sidebar/iOS count mismatch: open (non-terminal) task count — was
    /// `snap.tasks.count`, the length of the capped/priority-ordered snapshot array
    /// (the "counting a fetched page's length instead of a server total" bug); now
    /// `ContainerSnapshot.taskOpenTotal` (additive server field, graceful fallback).
    var tasks: Int = 0
    var needsYou: Int = 0
    /// The bound GitHub repo ("owner/name"), shown on the card's secondary line.
    var githubRepo: String?
}

/// Flow 09: lazily-fetched agent-detail sections (each best-effort).
struct AgentExtras {
    var persona: PersonaResponse?
    var digest: DigestDto?
    var inboxCount: Int?
    var inboxPreview: String?
    var outboxOpen: Int?
    var outboxAnswered: Int?
}

enum WorkspaceTab: Hashable {
    case home, tasks, requests, agents, search
}

/// Collab v1 — the Settings members-roster load state. `restricted` mirrors the
/// server's roster privacy: the list holds only the caller's own row.
enum MembersState: Equatable {
    case idle
    case loading
    case loaded([MemberDto], restricted: Bool)
    case failed(String)
}

/// The app's single source of truth — a 1:1 port of the Android `OrchaViewModel`
/// (same state fields, same action surface), driving SwiftUI via @Observable.
@MainActor
@Observable
final class AppModel {
    private let store = ContainerStore()
    // `internal` (not `private`): the per-feature `AppModel+*` extensions live in their
    // own files and drive their loads through this same client (github hub).
    let api = OrchaApiClient()
    private let webAuth = WebAuthSession()
    private var pollTask: Task<Void, Never>?
    /// Issue 3 — the live run-log collector; cancelled on leaving RunDetailScreen.
    private var runStreamTask: Task<Void, Never>?
    private var lastRunSeq = -1
    /// Issue 4 — task-thread keyset cursor (echoed back as before/before_id to load earlier).
    private var threadNextBefore: String?
    private var threadNextBeforeId: String?

    // navigation
    var containers: [StoredContainer]
    var selectedContainer: StoredContainer?
    var selectedTab: WorkspaceTab = .home
    var themeMode: ThemeMode
    var skinMode: SkinMode
    var notificationsEnabled: Bool = false
    /// Home tab's navigation path — bound so notification taps can push the
    /// exact task/request screen programmatically.
    var homePath: [WorkspaceRoute] = []
    /// "Catch me up": the digest from the human's LAST look + how long ago,
    /// captured once per workspace session when the gap is meaningful. The
    /// Home card narrates the delta against the live snapshot, on-device.
    var catchUp: (previous: String, gapLabel: String)?
    /// Add-flow: the last probe was intercepted by an auth perimeter — the address is
    /// right, but the deployment wants the team access token (or the one given was
    /// rejected). Drives the token prompt instead of the unreachable checklist.
    var connectNeedsToken = false
    /// Add-flow: the raw address/QR payload whose probe needed a token, kept so the
    /// auth-options and manual sheets can retry it without re-scanning.
    var connectDraft: String?
    /// Perimeter-bounce sign-in state — drives AuthOptionsSheet's primary
    /// button and failure banner (the pure machine; see DeviceAuthFlow).
    var deviceAuth = DeviceAuthFlow()

    // workspace data
    var snapshot: ContainerSnapshot?
    /// Collab v1 — the acting GitHub identity for the SELECTED project (`/api/me`),
    /// and whether a trusted proxy identity was present on that request. Drives
    /// honest role/grant gating (`access`) and the acting-identity display.
    var identity: ActingIdentity?
    var identityTrusted = false
    /// The container `identity` belongs to — a stale identity must never gate
    /// another project's affordances.
    private var identityContainerId: String?
    /// Collab v1 — the Settings members roster (view-only on iOS v1).
    var membersState: MembersState = .idle
    /// GitHub hub — the issues / pull-requests list phase state (see `AppModel+GitHubHub`).
    /// The same `.loading / .unavailable / .loaded / .failed` machine `membersState` uses.
    var githubIssuesPhase: GitHubIssuesPhase = .idle
    var githubPullsPhase: GitHubPullsPhase = .idle
    /// The PR list's compact filter row (author / involvement / q / page) — owned
    /// here (not view @State) so a kind switch + back-navigation doesn't lose it,
    /// mirroring where `githubPullsPhase` itself lives.
    var githubPullsFilter = GitHubPullsFilterState()
    /// The most recent PR-list response's `detail` when the identity lacks a mapped
    /// GitHub login (the involvement chips' disabled-footnote copy) — cleared on
    /// every successful fetch that isn't that exact off-state.
    var githubInvolvementUnavailableDetail: String?
    /// GitHub hub — stale-completion guards (PR #223 round 3): a generation per list
    /// surface, bumped at the START of every primary load. A completion (success OR
    /// failure, including the follow-up checks fill) applies only while its captured
    /// generation is still current, so a delayed response from a previous project or
    /// an out-of-order same-project reload can never overwrite a newer list.
    var githubIssuesLoadGeneration = 0
    var githubPullsLoadGeneration = 0
    /// Test seam: the hub's fetch surface, overridable so the delayed-response races
    /// are drivable through the REAL load paths. Nil in production (falls back to `api`).
    var githubFetchOverride: (any GitHubHubFetching)?
    var containerHealth: [String: ContainerHealth] = [:]
    var taskMessages: [TaskMessageDto] = []
    var taskRuns: [RunDto] = []
    var agentRuns: [RunDto] = []
    var agentExtras = AgentExtras()
    /// Issue 3 — the typed, classified run-log feed (web/Android parity). Classified once at
    /// append (not on every render), keeping a 400-row retention cap.
    var runFeed: [RunFeedRow] = []
    /// Issue 3 — a neutral note shown above the feed when the live stream drops mid-run
    /// (reconnecting), never a synthetic feed row. Cleared on the next accepted update.
    var runStreamNote: String?
    var models: [ModelDto] = []
    var conversation: ConversationDto?
    var turns: [TurnDto] = []
    /// Chat send-UX — the composer's optimistic-send machine (pure; see ChatSendFlow).
    var sendFlow = ChatSendFlow()
    /// Chat send-UX — the bounded post-send poll awaiting the echo + the reply.
    private var replyWatchTask: Task<Void, Never>?
    /// The agent whose conversation `conversation`/`turns`/`sendFlow` belong to.
    private var conversationAgentId: String?

    // ui state
    var loading = false
    var connecting = false
    var actionInFlight = false
    var error: String?
    var toast: String?
    var runLogStreaming = false      // Issue 3 — waiting on the live run stream
    var threadHasMore = false        // Issue 4 — an older task-thread page is available
    var threadLoadingEarlier = false
    var showContainerControls = false  // GH #148 — Notifier + Autonomy sheet

    var humanId: String? { selectedContainer?.humanAgentId }

    /// The pure role/grant gate for the selected project. Self-host (trust off)
    /// stays fully permissive — identical to pre-collab behavior.
    var access: Access {
        guard let sel = selectedContainer, identityContainerId == sel.id else { return .selfHost }
        return Access(identity: identity, trusted: identityTrusted)
    }

    // mig 040 — per-user prefs sync (server wins; local-only when prefs are null).
    /// Whether server prefs are ACTIVE for the connected deployment.
    var prefsActive = false
    /// The last-fetched whole bag — PUTs merge over it so keys iOS doesn't manage
    /// (sidebar, default_cid) survive the whole-bag replace.
    private var serverPrefs: [String: Any]?
    private var prefsSyncedBase: String?
    private var prefsPushTask: Task<Void, Never>?

    init() {
        containers = store.load()
        themeMode = store.loadThemeMode()
        skinMode = store.loadSkinMode()
        notificationsEnabled = store.loadNotificationsEnabled()
        // Dev/UI-test seam: `-orchaOpenContainer <id>` opens straight into a paired
        // workspace on launch (also the shape a future deep link would take).
        if let idx = ProcessInfo.processInfo.arguments.firstIndex(of: "-orchaOpenContainer"),
           idx + 1 < ProcessInfo.processInfo.arguments.count {
            let id = ProcessInfo.processInfo.arguments[idx + 1]
            if containers.contains(where: { $0.id == id }) {
                openContainer(id)
            }
        }
        // Dev/UI-test seam: `-orchaScanPayload <json>` runs a scanned QR payload
        // through the real pairing path on launch (what the scanner delegate calls).
        if let idx = ProcessInfo.processInfo.arguments.firstIndex(of: "-orchaScanPayload"),
           idx + 1 < ProcessInfo.processInfo.arguments.count {
            let payload = ProcessInfo.processInfo.arguments[idx + 1]
            Task { await connect(payload) }
        }
    }

    // MARK: theme + store

    func setThemeMode(_ mode: ThemeMode) {
        themeMode = mode
        store.saveThemeMode(mode)
        schedulePrefsPush()
    }

    func setSkinMode(_ skin: SkinMode) {
        skinMode = skin
        store.saveSkinMode(skin)
        schedulePrefsPush()
    }

    // MARK: per-user prefs (mig 040 — follow the GitHub identity across devices)

    /// On connect/open: GET /api/prefs once per base. Non-null → server prefs are
    /// ACTIVE and the SERVER WINS — apply theme/skin (mirroring into the local
    /// store) so the account's look follows onto this phone. Null → self-host /
    /// trust-off: stay pure-local, byte-identical to today. Cosmetic only — a
    /// failed fetch changes nothing.
    func syncPrefs() async {
        guard let base = selectedContainer?.baseUrl, prefsSyncedBase != base else { return }
        prefsSyncedBase = base
        let fetched: [String: Any]?
        do {
            fetched = try await api.getPrefs(base)
        } catch {
            // Unreachable — stay local-only now, retry on the next workspace open.
            prefsActive = false
            serverPrefs = nil
            prefsSyncedBase = nil
            return
        }
        guard let bag = fetched else {
            // The deliberate null: self-host / trust-off / unmapped — pure local.
            prefsActive = false
            serverPrefs = nil
            return
        }
        prefsActive = true
        serverPrefs = bag
        if let theme = PrefsSync.resolveTheme(bag), theme != themeMode {
            themeMode = theme
            store.saveThemeMode(theme)
        }
        if let skin = PrefsSync.resolveSkin(bag), skin != skinMode {
            skinMode = skin
            store.saveSkinMode(skin)
        }
    }

    /// Debounced write-through after a local theme/skin change (web app-prefs.js
    /// parity, 800ms): PUT the merged whole bag. Inactive ⇒ no network, ever.
    private func schedulePrefsPush() {
        guard prefsActive, let base = selectedContainer?.baseUrl else { return }
        prefsPushTask?.cancel()
        prefsPushTask = Task { [themeMode, skinMode] in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            let bag = PrefsSync.mergedBag(serverPrefs, theme: themeMode, skin: skinMode)
            // Cosmetic: a lost mirror self-heals on the next change.
            if (try? await api.putPrefs(base, bag)) != nil {
                serverPrefs = bag
            }
        }
    }

    func setNotificationsEnabled(_ enabled: Bool) {
        notificationsEnabled = enabled
        store.saveNotificationsEnabled(enabled)
        if enabled { NotificationCoordinator.scheduleAppRefresh() }
    }

    /// Notification tap → the exact linked screen: open the right container,
    /// land on Home, and push the task/request detail.
    func openFromNotification(containerId: String, route: WorkspaceRoute) {
        if selectedContainer?.id != containerId {
            guard containers.contains(where: { $0.id == containerId }) else { return }
            openContainer(containerId)
        }
        selectedTab = .home
        homePath = [route]
    }

    func renameContainer(_ id: String, to name: String) {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        containers = store.rename(id, to: name.trimmingCharacters(in: .whitespaces))
        if let sel = selectedContainer, sel.id == id {
            selectedContainer = containers.first { $0.id == id }
        }
    }

    /// Cloud multi-project: one pairing covers the whole deployment, so forgetting a
    /// project forgets its connection — every project sharing the base URL. (Leaving
    /// just one behind would only get re-added by the next discovery pass.)
    func forgetContainer(_ id: String) {
        let base = containers.first { $0.id == id }?.baseUrl
        containers = store.removeConnection(of: id)
        if let sel = selectedContainer, sel.baseUrl == base || sel.id == id {
            selectedContainer = nil
            snapshot = nil
        }
    }

    // MARK: pairing (flow 03, cloud-first)

    /// Probe + pair. `accessToken` is the team credential for deployments behind the
    /// auth perimeter — attached to the probe itself (it isn't persisted yet), then
    /// stored per container so `BearerTokens` serves every later request. One pairing
    /// stores EVERY project `/api/containers` lists on that box; the QR's container
    /// (or the first) opens immediately and the rest land on the containers home.
    func connect(_ raw: String, accessToken: String? = nil) async -> Bool {
        connecting = true
        error = nil
        connectNeedsToken = false
        let trimmed = accessToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = (trimmed?.isEmpty ?? true) ? nil : trimmed
        defer { connecting = false }
        do {
            let payload = try OrchaServerAddress.parse(raw)
            let base = payload.baseUrl
            let probeApi = token == nil ? api : OrchaApiClient(bearerToken: token)
            let listed = try await probeApi.listContainers(base).containers
            guard !listed.isEmpty else {
                error = "No Orcha project was found at this address."
                return false
            }
            let primary = listed.first { $0.id == payload.containerId } ?? listed[0]
            let snap = try await probeApi.snapshot(base, primary.id)
            // Prefer the operator named in the QR (disambiguates multi-human containers);
            // fall back to the sole human in the snapshot for manual entry. Verify the
            // paired id is actually a human on this container before trusting it.
            let humans = snap.agents.filter { $0.kind == "human" }
            let pairedHuman = payload.humanAgentId.flatMap { id in humans.first { $0.id == id } }
            let human = pairedHuman ?? (humans.count == 1 ? humans.first : nil)
            for dto in listed {
                storeProject(
                    dto, base: base, token: token, payload: payload,
                    human: dto.id == primary.id ? human : nil,
                    isPrimary: dto.id == primary.id
                )
            }
            selectedContainer = containers.first { $0.id == primary.id }
            snapshot = snap
            selectedTab = .home
            connectDraft = nil
            resetIdentity()
            Task { await refreshIdentity() }
            Task { await syncPrefs() }
            startPolling()
            return true
        } catch {
            if error is OrchaAuthRequiredError {
                // Item-1 UX: scan/enter → token prompt only when the perimeter asks.
                connectNeedsToken = true
                connectDraft = raw
                self.error = token == nil
                    ? "This Orcha is protected — enter its team access token to connect."
                    : "That access token wasn't accepted. Check it and try again."
            } else {
                self.error = friendly(error)
            }
            return false
        }
    }

    /// Upsert one discovered project, preserving local edits (rename, remote address,
    /// resolved human) when it's already paired. Non-primary projects start without a
    /// human identity — `refresh()` resolves it on first open, by alias when possible.
    private func storeProject(
        _ dto: ContainerDto, base: String, token: String?,
        payload: OrchaServerAddress.Payload, human: AgentDto?, isPrimary: Bool
    ) {
        if var existing = containers.first(where: { $0.id == dto.id }) {
            existing.baseUrl = base
            existing.accessToken = token
            existing.remoteBaseUrl = payload.remoteBaseUrl ?? existing.remoteBaseUrl
            if isPrimary {
                existing.pairingToken = payload.token
                existing.humanAgentId = human?.id ?? payload.humanAgentId ?? existing.humanAgentId
                existing.humanAlias = human?.alias ?? payload.humanAgentAlias ?? existing.humanAlias
                existing.lastOpenedAt = .now
            }
            containers = store.upsert(existing)
        } else {
            containers = store.upsert(StoredContainer(
                id: dto.id,
                displayName: dto.name,
                baseUrl: base,
                humanAgentId: isPrimary ? (human?.id ?? payload.humanAgentId) : nil,
                // The operator's ALIAS carries across projects (same person on the
                // whole box) even where the per-project agent id can't.
                humanAlias: human?.alias ?? payload.humanAgentAlias,
                pairingToken: isPrimary ? payload.token : nil,
                accessToken: token,
                remoteBaseUrl: payload.remoteBaseUrl
            ))
        }
    }

    /// Fresh flow per presentation of the auth-options sheet. Also clears the
    /// bounce message that got the user here — the sheet opens with its own
    /// explainer, so any error that appears afterwards is a fresh one.
    func resetDeviceAuth() {
        deviceAuth = DeviceAuthFlow()
        error = nil
    }

    /// The primary way through the auth perimeter (QR → GitHub OAuth →
    /// device token): run the deployment's oauth2 start page in an
    /// ASWebAuthenticationSession, let the authenticated portal's
    /// `/auth/device` page mint a per-device token and call back
    /// `orcha://auth/callback?host&token`, then retry the captured pairing
    /// draft with it — the existing `connect` path persists the token per
    /// container and rebuilds `BearerTokens`. Returns true when the retry
    /// connected (the sheet should dismiss).
    func signInWithGitHub() async -> Bool {
        // The manual sheet can start a sign-in without the options sheet's
        // onAppear reset — never let a stale terminal phase eat the events.
        if deviceAuth.phase == .connected { deviceAuth = DeviceAuthFlow() }
        deviceAuth.handle(.signInTapped)
        guard let draft = connectDraft,
              let base = try? OrchaServerAddress.parse(draft).baseUrl,
              let startURL = DeviceAuth.startURL(forBase: base) else {
            deviceAuth.handle(.retryFailed("The pairing address went missing — close this and scan the portal's QR again."))
            return false
        }
        let callbackURL: URL
        do {
            callbackURL = try await webAuth.authenticate(startURL: startURL)
        } catch {
            // The user closed the browser sheet — or the server showed its own
            // error page and never redirected, which ends the session the same
            // way. Either way: back to the options, no banner.
            deviceAuth.handle(.cancelled)
            return false
        }
        guard let callback = DeviceAuth.parseCallback(callbackURL),
              DeviceAuth.callback(callback, matchesBase: base) else {
            deviceAuth.handle(.invalidCallback)
            return false
        }
        deviceAuth.handle(.callbackReceived)
        if await connect(draft, accessToken: callback.token) {
            deviceAuth.handle(.retrySucceeded)
            return true
        }
        deviceAuth.handle(.retryFailed(connectNeedsToken
            ? "GitHub signed you in, but the minted device token wasn't accepted. Try again, or paste an access token instead."
            : (error ?? "Signed in, but the connection then failed. Check the deployment and try again.")))
        return false
    }

    /// Settings: set/rotate the team access token for a connection (applies to every
    /// project sharing the address — one box, one token).
    func setAccessToken(_ id: String, to accessToken: String?) {
        containers = store.setAccessToken(id, to: accessToken)
        if let sel = selectedContainer {
            selectedContainer = containers.first { $0.id == sel.id } ?? sel
        }
    }

    func openContainer(_ id: String) {
        guard var stored = containers.first(where: { $0.id == id }) else { return }
        stored.lastOpenedAt = .now
        containers = store.upsert(stored)
        selectedContainer = stored
        selectedTab = .home
        error = nil
        catchUp = nil
        resetIdentity()
        Task { await refresh() }
        Task { await syncPrefs() }
        startPolling()
    }

    /// Clear the per-project identity when the selection changes — a stale
    /// identity must never gate (or label) another project.
    private func resetIdentity() {
        identity = nil
        identityTrusted = false
        identityContainerId = nil
        membersState = .idle
    }

    /// Collab v1 — resolve the acting GitHub identity for the selected project
    /// (`/api/me?cid=`). Best-effort: a failure (older server, transient network)
    /// leaves the permissive self-host default rather than locking the UI.
    private func refreshIdentity() async {
        guard let sel = selectedContainer else { return }
        guard let me = try? await api.me(sel.baseUrl, sel.id) else { return }
        guard selectedContainer?.id == sel.id else { return }   // switched mid-flight
        identity = me.identity
        identityTrusted = me.trusted
        identityContainerId = sel.id
    }

    /// "Catch me up" bookkeeping — GAP-based, not session-based: last-seen
    /// saves continuously while the human is looking, so any refresh that
    /// finds the last save ≥30 minutes old means they were away (backgrounded
    /// counts — iOS keeps the app alive for hours, and returning never re-runs
    /// openContainer). Arms the delta card whenever the state also changed.
    private func noteSeen(_ snap: ContainerSnapshot, container: StoredContainer) {
        let digest = WorkspaceDigest.make(snap)
        if catchUp == nil,
           let seen = store.lastSeen(for: container.id),
           seen.digest != digest,
           Date.now.timeIntervalSince(seen.at) > 30 * 60 {
            catchUp = (seen.digest, Self.gapLabel(since: seen.at))
        }
        store.saveLastSeen(digest, for: container.id)
    }

    private static func gapLabel(since date: Date) -> String {
        let mins = Int(Date.now.timeIntervalSince(date) / 60)
        if mins < 90 { return "\(mins) minutes" }
        let hours = mins / 60
        if hours < 36 { return "\(hours) hours" }
        return "\(hours / 24) days"
    }

    func closeWorkspace() {
        pollTask?.cancel()
        stopReplyWatch()
        sendFlow.reset()
        selectedContainer = nil
        snapshot = nil
        resetIdentity()
        probeContainers()
    }

    /// Flow 04 H1 + cloud multi-project: each paired address is one connection to a
    /// whole box, so first re-list its containers (projects created after pairing
    /// appear here automatically), then probe per-card health, non-blocking per card.
    func probeContainers() {
        discoverProjects()
        for stored in containers {
            probeHealth(stored)
        }
    }

    /// One `GET /api/containers` per distinct base URL; unknown projects are stored
    /// as siblings of the connection (same address + token). Removal stays manual —
    /// an unreachable box must not silently drop pairings.
    private func discoverProjects() {
        for (base, group) in Dictionary(grouping: containers, by: \.baseUrl) {
            Task {
                guard let listed = try? await api.listContainers(base).containers else { return }
                let known = Set(containers.map(\.id))
                let template = group[0]
                for dto in listed where !known.contains(dto.id) {
                    let sibling = StoredContainer(
                        id: dto.id,
                        displayName: dto.name,
                        baseUrl: base,
                        humanAgentId: nil,
                        humanAlias: template.humanAlias,
                        pairingToken: nil,
                        accessToken: template.accessToken,
                        remoteBaseUrl: template.remoteBaseUrl
                    )
                    containers = store.upsert(sibling)
                    probeHealth(sibling)
                }
            }
        }
    }

    private func probeHealth(_ stored: StoredContainer) {
        containerHealth[stored.id, default: ContainerHealth(state: "probing")].state = "probing"
        Task {
            do {
                let snap = try await api.snapshot(stored.baseUrl, stored.id)
                let plans = snap.tasks.filter { $0.status == "in_progress" && $0.planMessage != nil && $0.planDecision == nil }
                let verifs = snap.tasks.filter { $0.status == "needs_verification" }
                let reqs = snap.requests.filter { $0.status == "open" && ($0.targetId == stored.humanAgentId || $0.targetId == nil) }
                containerHealth[stored.id] = ContainerHealth(
                    state: "polling", agents: snap.agents.count, tasks: snap.taskOpenTotal,
                    needsYou: plans.count + verifs.count + reqs.count,
                    githubRepo: snap.container.githubRepo
                )
            } catch {
                containerHealth[stored.id] = ContainerHealth(state: "unreachable")
            }
        }
    }

    // MARK: workspace refresh + 30s polling (SSE is the listed follow-up)

    func refresh() async {
        guard let sel = selectedContainer else { return }
        loading = true
        defer { loading = false }
        do {
            let snap = try await api.snapshot(sel.baseUrl, sel.id)
            snapshot = snap
            // Resolve the human identity lazily for projects paired via discovery:
            // match the connection's operator alias first (the same person across a
            // box's projects), else the sole human — never guess among several.
            if sel.humanAgentId == nil {
                let humans = snap.agents.filter { $0.kind == "human" }
                let match = humans.first { $0.alias == sel.humanAlias } ?? (humans.count == 1 ? humans.first : nil)
                if let human = match {
                    var upgraded = sel
                    upgraded.humanAgentId = human.id
                    upgraded.humanAlias = human.alias
                    containers = store.upsert(upgraded)
                    selectedContainer = upgraded
                }
            }
            error = nil
            // Anything visible in the open app counts as seen — it must never
            // fire later as a background needs-you notification.
            NotificationCoordinator.shared.markSeen(snap, container: selectedContainer ?? sel)
            noteSeen(snap, container: selectedContainer ?? sel)
            WidgetPublisher.publish(snap, container: selectedContainer ?? sel)
            // Collab v1: keep the acting identity fresh on the same cadence the
            // snapshot polls (role/grant changes propagate within a poll).
            await refreshIdentity()
        } catch {
            // Opt-in remote failover (Tailscale): if the active address didn't
            // answer and a second one is configured, try it and swap on success —
            // the working path stays active for every subsequent call. Symmetric,
            // so it also swaps back to LAN when the remote path is the dead one.
            if let remote = sel.remoteBaseUrl, !remote.isEmpty,
               let snap = try? await api.snapshot(remote, sel.id) {
                var swapped = sel
                swapped.baseUrl = remote
                swapped.remoteBaseUrl = sel.baseUrl
                containers = store.upsert(swapped)
                selectedContainer = swapped
                snapshot = snap
                self.error = nil
                toast = "Connected via \(remote)"
                return
            }
            self.error = friendly(error)
        }
    }

    func setRemoteUrl(_ id: String, to url: String?) {
        containers = store.setRemoteUrl(id, to: url)
        if let sel = selectedContainer, sel.id == id {
            selectedContainer = containers.first { $0.id == id }
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { return }
                await refresh()
            }
        }
    }

    // MARK: detail loads

    /// Issue 4: load the NEWEST page of the thread (keyset), not the whole thread. The older
    /// pages are revealed on demand via `loadEarlierThreadMessages`.
    func loadTaskDetail(_ taskId: String) async {
        guard let sel = selectedContainer else { return }
        do {
            let page = try await api.taskMessages(sel.baseUrl, taskId, limit: 20)
            taskMessages = page.messages
            threadHasMore = page.hasMore
            threadNextBefore = page.nextBefore
            threadNextBeforeId = page.nextBeforeId
            taskRuns = try await api.taskRuns(sel.baseUrl, taskId).runs
        } catch {
            self.error = friendly(error)
        }
    }

    /// Issue 4: "Load earlier" — fetch the next older keyset page and PREPEND it (messages come
    /// back ASC; dedup at the seam). Must not disturb the reader's scroll to the bottom.
    func loadEarlierThreadMessages(_ taskId: String) async {
        guard let sel = selectedContainer, threadHasMore, !threadLoadingEarlier,
              let before = threadNextBefore, let beforeId = threadNextBeforeId else { return }
        threadLoadingEarlier = true
        defer { threadLoadingEarlier = false }
        do {
            let page = try await api.taskMessages(sel.baseUrl, taskId, limit: 20, before: before, beforeId: beforeId)
            taskMessages = MobileUx.prependMessages(page.messages, before: taskMessages)
            threadHasMore = page.hasMore
            threadNextBefore = page.nextBefore
            threadNextBeforeId = page.nextBeforeId
        } catch {
            self.error = friendly(error)
        }
    }

    /// Issue 4: after posting, re-fetch only the newest page and merge in the new message(s),
    /// instead of re-fetching the whole thread.
    private func reloadNewestThreadPage(_ taskId: String) async {
        guard let sel = selectedContainer else { return }
        do {
            let page = try await api.taskMessages(sel.baseUrl, taskId, limit: 20)
            let have = Set(taskMessages.compactMap { $0.messageId })
            let fresh = page.messages.filter { m in m.messageId.map { !have.contains($0) } ?? true }
            taskMessages.append(contentsOf: fresh)
        } catch {
            self.error = friendly(error)
        }
    }

    func loadAgentDetail(_ agentId: String) async {
        guard let sel = selectedContainer else { return }
        agentExtras = AgentExtras()
        do {
            let headless = try await api.agentRuns(sel.baseUrl, agentId).runs
            let resident = (try? await api.residentRuns(sel.baseUrl, agentId).runs) ?? []
            var seen = Set<String>()
            agentRuns = (headless + resident)
                .filter { seen.insert($0.runId).inserted }
                .sorted { ($0.startedAt ?? "") > ($1.startedAt ?? "") }
            models = try await api.models(sel.baseUrl).models
        } catch {
            self.error = friendly(error)
        }
        agentExtras.persona = try? await api.persona(sel.baseUrl, agentId)
        agentExtras.digest = (try? await api.digest(sel.baseUrl, agentId))?.digest
        if let inboxRows = try? await api.inbox(sel.baseUrl, agentId).openRequests {
            agentExtras.inboxCount = inboxRows.count
            agentExtras.inboxPreview = inboxRows.first?.payload
        }
        if let outboxRows = try? await api.outbox(sel.baseUrl, agentId).outgoingRequests {
            agentExtras.outboxOpen = outboxRows.filter { $0.status == "open" }.count
            agentExtras.outboxAnswered = outboxRows.filter { $0.status == "answered" }.count
        }
    }

    /// Issue 3: start showing a run's log. A RUNNING run is consumed incrementally over SSE
    /// (never a buffered one-shot that would time out); a finished run keeps the one-shot fetch.
    func startRunLog(_ run: RunDto) {
        stopRunLogStream()
        lastRunSeq = -1
        runFeed = []
        runStreamNote = nil
        error = nil
        if run.status == "running" {
            streamRunLog(run)
        } else {
            Task { await loadRunLog(run) }
        }
    }

    /// Cancel the live collector (leaving RunDetailScreen, or before a one-shot refresh).
    func stopRunLogStream() {
        runStreamTask?.cancel()
        runStreamTask = nil
        runLogStreaming = false
    }

    private func streamRunLog(_ run: RunDto) {
        guard let sel = selectedContainer, let aid = run.agentId else { return }
        runLogStreaming = true
        runStreamTask = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            while !Task.isCancelled {
                do {
                    streaming: for try await event in api.runStream(sel.baseUrl, aid, run.runId) {
                        if Task.isCancelled { return }
                        switch event {
                        case let .line(seq, text):
                            appendRunRows(seq: seq, text: text)
                            attempt = 0
                        case let .done(_, status):
                            if status == "stream_timeout" {
                                break streaming          // server 30-min cap — reopen, run still live
                            }
                            appendFeed([RunFeedRow(type: "done", label: "run-complete", text: status)])
                            runStreamNote = nil
                            runLogStreaming = false
                            await refresh()              // sync the run row elsewhere in the UI
                            return
                        }
                    }
                    attempt = 0                          // clean close / timeout → reopen shortly
                } catch {
                    if Task.isCancelled { return }
                    // A 404 means THIS server has no `/stream` endpoint at all (older self-host,
                    // predates the SSE route) — retrying it is pointless and would otherwise loop
                    // forever showing a stale "reconnecting…" note. Fall back to polling the
                    // one-shot log instead, exactly like a finished run — graceful degradation,
                    // not an error state. Any OTHER failure (network blip, 5xx, auth hiccup) keeps
                    // retrying the stream itself with backoff, since the endpoint is known-good.
                    if let apiError = error as? OrchaApiError, apiError.status == 404 {
                        runStreamNote = nil
                        await pollRunLogFallback(run)
                        return
                    }
                    attempt = min(attempt + 1, 5)
                    runStreamNote = "Log stream interrupted — reconnecting…"
                }
                if Task.isCancelled { return }
                try? await Task.sleep(for: .seconds(attempt == 0 ? 0.3 : Double(attempt)))
            }
        }
    }

    /// Older-server fallback for `streamRunLog`: no `/stream` SSE route, so the log is
    /// polled with a one-shot fetch every 3s (independent of, and much tighter than, the
    /// app-wide 30s `startPolling` refresh loop) until the run itself is no longer
    /// "running" — checked against a direct re-fetch of this run's own row (never the
    /// model's `taskRuns`/`agentRuns`, which only refresh when their OWN detail screen
    /// loads and would otherwise report a stale status here). Runs on the same
    /// cancellable `runStreamTask` the SSE path uses, so leaving RunDetailScreen still
    /// stops it; `refresh()` at the end re-syncs the run row wherever else it's shown,
    /// matching the SSE path's own terminal handling.
    private func pollRunLogFallback(_ run: RunDto) async {
        while !Task.isCancelled {
            await loadRunLog(run)
            guard await isStillRunning(run), !Task.isCancelled else { break }
            try? await Task.sleep(for: .seconds(3))
        }
        runLogStreaming = false
        if !Task.isCancelled { await refresh() }
    }

    /// A fresh look at one run's own status, straight off the list endpoint that owns
    /// it (task-scoped or agent-scoped) — not the cached `taskRuns`/`agentRuns`, which
    /// only update when their own detail screen loads.
    private func isStillRunning(_ run: RunDto) async -> Bool {
        guard let sel = selectedContainer else { return false }
        if let taskId = run.taskId,
           let refreshed = try? await api.taskRuns(sel.baseUrl, taskId).runs.first(where: { $0.runId == run.runId }) {
            return refreshed.status == "running"
        }
        if let aid = run.agentId,
           let refreshed = try? await api.agentRuns(sel.baseUrl, aid).runs.first(where: { $0.runId == run.runId }) {
            return refreshed.status == "running"
        }
        return false
    }

    /// Append a streamed line: web's monotonic-`seq` dedup → classify into typed rows →
    /// skip-empty guard → append + 400-row cap → clear the interruption note (only inside a
    /// non-empty update, matching Android VM:522-526).
    private func appendRunRows(seq: Int, text: String) {
        if seq >= 0 {
            guard seq > lastRunSeq else { return }
            lastRunSeq = seq
        }
        let rows = RunFeed.classifyLine(text)
        guard !rows.isEmpty else { return }
        appendFeed(rows)
        runStreamNote = nil
    }

    /// Append rows with the shared 400-row retention cap (classify happens at append, never render).
    private func appendFeed(_ rows: [RunFeedRow]) {
        runFeed.append(contentsOf: rows)
        if runFeed.count > 400 { runFeed.removeFirst(runFeed.count - 400) }
    }

    /// One-shot read for a FINISHED run (server closes the stream immediately).
    func loadRunLog(_ run: RunDto) async {
        guard let sel = selectedContainer, let aid = run.agentId else { return }
        loading = true
        defer { loading = false }
        do {
            let text = try await api.runStreamText(sel.baseUrl, aid, run.runId)
            runFeed = Self.feedFromStreamText(text)
        } catch {
            self.error = friendly(error)
        }
    }

    /// Issue 4: initial mount pulls the most-recent window (?limit=80); the screen reveals
    /// older turns client-side. Refreshes delta-append via `after_seq` (see below).
    func loadConversation(_ agentId: String) async {
        guard let sel = selectedContainer else { return }
        // Send-UX: the held conversation/turns/send state belong to ONE agent — switching
        // agents must never let a stale `conversation` swallow a send for the wrong peer.
        if conversationAgentId != agentId {
            conversationAgentId = agentId
            stopReplyWatch()
            sendFlow.reset()
            conversation = nil
            turns = []
        }
        do {
            let response = try await api.conversation(sel.baseUrl, agentId, limit: 80)
            conversation = response.conversation
            turns = response.turns
            sendFlow.observe(turns, humanId: humanId)
        } catch {
            self.error = friendly(error)
        }
    }

    /// Issue 4: append only the turns created after the last-held seq, instead of full-replacing
    /// the transcript (web parity, `conversation.js:586`). Falls back to a full load if unmounted.
    /// `quiet` (the reply watch) swallows transient poll errors instead of flashing the banner —
    /// exactly the cold-start window where a slow server drops a poll or two.
    func refreshConversationDelta(_ agentId: String, quiet: Bool = false) async {
        guard let sel = selectedContainer, let conv = conversation else {
            await loadConversation(agentId)
            return
        }
        do {
            let lastSeq = turns.map(\.seq).max() ?? 0
            let delta = try await api.conversationTurns(sel.baseUrl, conv.id, afterSeq: lastSeq, limit: 50).turns
            turns = MobileUx.appendTurns(turns, delta: delta)
            sendFlow.observe(turns, humanId: humanId)
        } catch {
            if !quiet { self.error = friendly(error) }
        }
    }

    // MARK: human actions

    @discardableResult
    private func humanAction(_ success: String, _ block: (String, String) async throws -> Void) async -> Bool {
        guard let sel = selectedContainer else { return false }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Orcha first."
            return false
        }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        do {
            try await block(sel.baseUrl, actor)
            toast = success
            return true
        } catch {
            self.error = friendly(error)
            return false
        }
    }

    func sendTaskMessage(_ taskId: String, body: String) async -> Bool {
        await humanAction("Message sent") { base, actor in
            try await api.postTaskMessage(base, taskId, actor: actor, body: body)
            await reloadNewestThreadPage(taskId)
        }
    }

    func cancelTask(_ taskId: String, reason: String?) async -> Bool {
        await humanAction("Task closed") { base, actor in
            try await api.cancelTask(base, taskId, actor: actor, reason: reason)
            await refresh()
        }
    }

    func verifyTask(_ taskId: String, approve: Bool, feedback: String?) async -> Bool {
        await humanAction(approve ? "Task accepted · completed" : "Task sent back") { base, actor in
            try await api.verifyTask(base, taskId, actor: actor, approve: approve, feedback: feedback)
            await refresh()
        }
    }

    /// Collab v1 — assign (or clear, nil = anyone) the human reviewer on a task.
    /// Server-gated on owner-or-`assign_reviewers`; advisory (verify stays open).
    func setTaskReviewer(_ taskId: String, reviewerAgentId: String?) async -> Bool {
        await humanAction(reviewerAgentId == nil ? "Reviewer cleared — anyone can verify" : "Reviewer assigned") { base, actor in
            try await api.setTaskReviewer(base, taskId, actor: actor, reviewerAgentId: reviewerAgentId)
            await refresh()
        }
    }

    /// Collab v1 — the Settings members roster (read-only). A 403 is the honest
    /// "not a member" state, surfaced in place rather than the app-wide banner.
    func loadMembers() async {
        guard let sel = selectedContainer else { return }
        membersState = .loading
        do {
            let response = try await api.members(sel.baseUrl, sel.id)
            membersState = .loaded(response.members, restricted: response.restricted)
        } catch {
            membersState = .failed(friendly(error))
        }
    }

    func decidePlan(_ task: TaskDto, approve: Bool, reason: String?) async -> Bool {
        await humanAction(approve ? "Plan approved" : "Changes requested") { base, actor in
            try await api.decidePlan(base, task.id, actor: actor, approve: approve, reason: reason, target: task.ownerId ?? task.createdByAgentId)
            await refresh()
        }
    }

    func respondRequest(_ rid: String, response: String) async -> Bool {
        await humanAction("Answer sent") { base, actor in
            try await api.respondRequest(base, rid, actor: actor, response: response)
            await refresh()
        }
    }

    func closeRequest(_ rid: String, reason: String?) async -> Bool {
        await humanAction("Request closed") { base, actor in
            try await api.closeRequest(base, rid, actor: actor, reason: reason)
            await refresh()
        }
    }

    /// GH #148 — the notifier kill-switch. Independent of `setAutonomy`: flipping this never
    /// changes the remembered autonomy level.
    func setWakes(enabled: Bool) async -> Bool {
        guard let cid = selectedContainer?.id else { return false }
        return await humanAction(enabled ? "Notifier resumed" : "Notifier paused") { base, actor in
            try await api.setWakes(base, cid, actor: actor, enabled: enabled)
            await refresh()
        }
    }

    /// GH #148 — the autonomy gearbox. Independent of `setWakes`: the level applies whether or
    /// not the notifier is currently running.
    func setAutonomy(level: String) async -> Bool {
        guard let cid = selectedContainer?.id else { return false }
        return await humanAction("Autonomy set to \(MobileUx.autonomyLabel(level))") { base, actor in
            try await api.setAutonomy(base, cid, actor: actor, level: level)
            await refresh()
        }
    }

    /// GitHub repo-connect (portal `home-github.js` parity): fetch the App
    /// installation's repos and map straight to the sheet's phase. Fetch errors
    /// land in `.failed`, never in the app-wide error banner — the sheet owns them.
    func loadGithubRepos() async -> RepoConnectPhase {
        guard let sel = selectedContainer else {
            return .failed("No workspace is open — close this and try again.")
        }
        do {
            return RepoConnect.phase(from: try await api.githubRepos(sel.baseUrl, cid: sel.id))
        } catch {
            return .failed(friendly(error))
        }
    }

    /// Bind (`repo` = "owner/name") or unbind (nil) the workspace's GitHub repo.
    /// No actor id: the server treats this like the portal's plain PUT. The
    /// refresh pulls the snapshot whose container now carries the new binding.
    func setGithubRepo(_ repo: String?) async -> Bool {
        guard let sel = selectedContainer else { return false }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        do {
            let saved = try await api.setGithubRepo(sel.baseUrl, sel.id, repo: repo).repo
            toast = saved.map { "Repo connected — \($0)" } ?? "Repo unbound"
            await refresh()
            return true
        } catch {
            self.error = friendly(error)
            return false
        }
    }

    /// Flow 07a: the toast is state-aware — a real wake names the woken agent, while the
    /// `{nudged:false}` no-op (a human owns the next action) is informational, not an error.
    func nudgeRequest(_ rid: String, note: String?) async -> Bool {
        guard let sel = selectedContainer else { return false }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Orcha first."
            return false
        }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        do {
            let result = try await api.nudgeRequest(sel.baseUrl, rid, actor: actor, note: note)
            toast = nudgeToast(result)
            await refresh()
            return true
        } catch {
            self.error = friendly(error)
            return false
        }
    }

    private func nudgeToast(_ r: NudgeResult) -> String {
        guard r.nudged else { return "No agent to wake — a human owns the next action." }
        if let alias = MobileUx.aliasFor(r.nudgedAgentId, in: snapshot?.agents ?? []) {
            return "Nudged \(alias)"
        }
        if let role = r.nudgedRole { return "Nudged the \(role)" }
        return "Nudge sent"
    }

    func escalateRequest(_ rid: String, reason: String?) async -> Bool {
        await humanAction("Request escalated") { base, actor in
            try await api.escalateRequest(base, rid, actor: actor, reason: reason)
            await refresh()
        }
    }

    func acceptTaskRequest(_ rid: String, note: String?) async -> Bool {
        await humanAction("Task request accepted") { base, actor in
            try await api.acceptTaskRequest(base, rid, actor: actor, note: note)
            await refresh()
        }
    }

    func rejectTaskRequest(_ rid: String, reason: String) async -> Bool {
        await humanAction("Task request rejected") { base, actor in
            try await api.rejectTaskRequest(base, rid, actor: actor, reason: reason)
            await refresh()
        }
    }

    func convertRequest(_ rid: String, title: String, dod: String, assignee: String?) async -> Bool {
        await humanAction("Request became a task") { base, actor in
            try await api.convertRequest(base, rid, actor: actor, title: title, dod: dod, assignee: assignee)
            await refresh()
        }
    }


    func changeModel(_ agentId: String, model: String) async -> Bool {
        await humanAction("Model changed") { base, _ in
            try await api.updateAgentModel(base, agentId, model: model)
            await refresh()
            await loadAgentDetail(agentId)
        }
    }

    func changeAutoWake(_ agentId: String, intervalSecs: Int?) async -> Bool {
        await humanAction("Auto-wake updated") { base, actor in
            try await api.updateAutoWake(base, agentId, actor: actor, intervalSecs: intervalSecs)
            await refresh()
        }
    }

    func renameAgent(_ agentId: String, alias: String) async -> Bool {
        await humanAction("Agent renamed") { base, actor in
            try await api.renameAgent(base, agentId, actor: actor, alias: alias)
            await refresh()
        }
    }

    func retireAgent(_ agentId: String) async -> Bool {
        await humanAction("Agent retired") { base, actor in
            try await api.retireAgent(base, agentId, actor: actor)
            await refresh()
        }
    }

    /// Chat send-UX: optimistic one-shot send. `sendFlow.begin` guards re-entry (button
    /// mashing) and renders the pending bubble immediately; success hands off to the
    /// bounded reply watch; failure keeps the content in the tap-to-retry bubble. The
    /// POST is NEVER auto-retried — a timed-out POST may still land server-side, and
    /// a blind resend is exactly the duplicate-turn bug this flow exists to prevent.
    @discardableResult
    func sendTurn(_ agentId: String, content: String) async -> Bool {
        guard let sel = selectedContainer else { return false }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Orcha first."
            return false
        }
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard sendFlow.begin(
            content: trimmed,
            baselineSeq: turns.map(\.seq).max() ?? 0,
            isFirstTurn: turns.isEmpty
        ) else { return false }
        error = nil
        do {
            if conversation == nil {
                conversation = try await api.startConversation(sel.baseUrl, agentId, actor: actor).conversation
            }
            guard let conv = conversation else { throw URLError(.badServerResponse) }
            try await api.sendTurn(sel.baseUrl, conv.id, actor: actor, content: trimmed)
            sendFlow.postSucceeded()
            startReplyWatch(agentId)
            return true
        } catch {
            sendFlow.postFailed(friendly(error))
            return false
        }
    }

    /// Tap-to-retry: pull the failed send's text back for the composer (clears the bubble).
    func takeFailedSendContent() -> String? {
        sendFlow.takeFailedContent()
    }

    /// Chat send-UX: after a successful POST, poll the turns delta until the poll echoes
    /// our turn and the agent replies — there is no conversation SSE yet, and the 30s
    /// snapshot poll never touches `turns`. Bounded: 2.5s cadence for 3 minutes (a cold
    /// first wake can take a minute+), then the flow flips to the overdue note. The watch
    /// survives a push to a detail screen (it owns no view state) and a fresh send
    /// replaces it.
    private func startReplyWatch(_ agentId: String) {
        replyWatchTask?.cancel()
        replyWatchTask = Task {
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .seconds(180))
            while !Task.isCancelled {
                await refreshConversationDelta(agentId, quiet: true)
                if Task.isCancelled { return }
                // Resolved (reply observed) or superseded (a new send began) — done.
                if !sendFlow.showsAwaitingReply { return }
                if clock.now > deadline {
                    sendFlow.replyOverdue()
                    return
                }
                try? await Task.sleep(for: .seconds(2.5))
            }
        }
    }

    private func stopReplyWatch() {
        replyWatchTask?.cancel()
        replyWatchTask = nil
    }

    func endConversation(_ agentId: String) async -> Bool {
        guard let conv = conversation else { return false }
        stopReplyWatch()
        sendFlow.reset()
        return await humanAction("Conversation ended") { base, actor in
            try await api.endConversation(base, conv.id, actor: actor)
            await loadConversation(agentId)
        }
    }

    func stopRun(_ run: RunDto) async -> Bool {
        await humanAction("Stop requested") { base, actor in
            try await api.stopRun(base, run.runId, actor: actor)
            stopRunLogStream()               // the run is closing — end the live collector
            await loadRunLog(run)            // one-shot now returns the full final log
        }
    }

    func createTask(
        title: String, description: String?, dod: String,
        assignee: String?, priority: Int, dependsOn: [String], notReady: Bool
    ) async -> String? {
        guard let sel = selectedContainer else { return nil }
        var created: String?
        _ = await humanAction(assignee != nil ? "Task created · assigned to \(assignee!)" : "Task created — parked in the backlog") { base, actor in
            let response = try await api.createTask(
                base, sel.id, actor: actor,
                title: title, description: description, dod: dod,
                assignee: assignee, priority: priority, dependsOn: dependsOn, notReady: notReady
            )
            created = response.taskId
            await refresh()
        }
        return created
    }

    // MARK: helpers

    /// Classify a FINISHED run's buffered SSE text into typed feed rows (Android
    /// `feedFromStreamText`): parse each frame via `OrchaApiClient.parseSseEvent`, drop
    /// reconnect-replay with `seq > maxSeq`, classify each line, and cap at 400 rows.
    static func feedFromStreamText(_ text: String) -> [RunFeedRow] {
        var rows: [RunFeedRow] = []
        var maxSeq = 0
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            switch OrchaApiClient.parseSseEvent(String(raw)) {
            case let .line(seq, line):
                if seq > maxSeq {
                    maxSeq = seq
                    rows.append(contentsOf: RunFeed.classifyLine(line))
                }
            case let .done(_, status):
                rows.append(RunFeedRow(type: "done", label: "run-complete", text: status))
            case .none:
                break
            }
        }
        if rows.count > 400 { rows.removeFirst(rows.count - 400) }
        return rows
    }

    // `internal` (not `private`): the `AppModel+*` extension files map their own load
    // failures through the same error copy.
    func friendly(_ error: Error) -> String {
        if let e = error as? OrchaServerAddress.AddressError {
            return e.localizedDescription
        }
        if let e = error as? OrchaAuthRequiredError {
            return e.localizedDescription
        }
        if let e = error as? OrchaApiError {
            return e.localizedDescription
        }
        return "Could not reach Orcha at this address. Check the address and that your Orcha is up."
    }
}
