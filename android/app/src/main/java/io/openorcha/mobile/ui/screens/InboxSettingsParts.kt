package io.openorcha.mobile.ui.screens

/* Settings parity with iOS: the Members roster from GET /api/containers/{cid}/members
   (role tags, pending invites, restricted rosters) and synced theme/skin prefs
   (GET/PUT /api/prefs, iOS AppModel.syncPrefs + PrefsSync). */

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.InboxApi
import io.openorcha.mobile.data.InboxMembersResponse
import io.openorcha.mobile.domain.PrefsSyncLogic
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LRow
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.theme.Orcha
import io.openorcha.mobile.ui.theme.SkinMode
import io.openorcha.mobile.ui.theme.ThemeMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** The member role as a word people use ("owner", "member", …), never a raw enum. */
internal fun memberRoleLabel(role: String): String = role.replace('_', ' ').lowercase().ifBlank { "member" }

@Composable
internal fun InboxMembersSection(roster: InboxMembersResponse, youId: String?) {
    val p = Orcha.palette
    LSection("Members", count = if (roster.restricted) null else roster.members.size) {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
            LCard(padding = 0.dp) {
                roster.members.forEachIndexed { i, m ->
                    if (i > 0) LDivider()
                    val you = m.agentId == youId
                    LRow(
                        title = m.githubLogin?.let { "@$it" } ?: m.alias,
                        subtitle = if (m.githubLogin != null && m.githubLogin != m.alias) m.alias else null,
                        leading = { LAvatar(m.githubLogin ?: m.alias, size = 28.dp) },
                        trailing = {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (you) LTag("you", tint = p.violet, dot = true)
                                if (m.pending) LTag("pending", tint = p.warn)
                                LTag(memberRoleLabel(m.memberRole), tint = if (m.memberRole == "owner") p.violet else null)
                            }
                        },
                    )
                }
            }
            Text(
                if (roster.restricted) {
                    "The roster is private on this project — you can see your own membership; owners see everyone."
                } else {
                    "Invites and role changes are managed from the portal."
                },
                style = ltype(LType.Micro), color = p.muted, modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
    }
}

/**
 * Synced cosmetic prefs. Pull once per server: a non-null bag means the server keeps
 * prefs and the SERVER WINS (theme/skin applied locally); null = self-host / trust-off,
 * stay local. Local changes push the merged whole bag after an 800ms debounce.
 */
object InboxPrefsSync {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var syncedBase: String? = null
    private var serverBag: JsonObject? = null
    private var active = false
    private var pushJob: Job? = null

    suspend fun pull(
        baseUrl: String,
        theme: ThemeMode,
        skin: SkinMode,
        onTheme: (ThemeMode) -> Unit,
        onSkin: (SkinMode) -> Unit,
    ) {
        if (syncedBase == baseUrl) return
        syncedBase = baseUrl
        val bag = runCatching { InboxApi.getPrefs(baseUrl) }.getOrElse {
            active = false; serverBag = null; syncedBase = null
            return
        }
        if (bag == null) {
            active = false; serverBag = null
            return
        }
        active = true
        serverBag = bag
        PrefsSyncLogic.resolveTheme(bag)?.let { v -> ThemeMode.entries.firstOrNull { it.name.lowercase() == v } }
            ?.takeIf { it != theme }?.let(onTheme)
        PrefsSyncLogic.resolveSkin(bag)?.let { v -> SkinMode.entries.firstOrNull { it.storageValue == v } }
            ?.takeIf { it != skin }?.let(onSkin)
    }

    fun push(baseUrl: String?, theme: ThemeMode, skin: SkinMode) {
        if (!active || baseUrl == null || baseUrl != syncedBase) return
        pushJob?.cancel()
        pushJob = scope.launch {
            delay(800)
            val bag = PrefsSyncLogic.mergedBag(serverBag, theme.name.lowercase(), skin.storageValue)
            // Cosmetic: a lost mirror self-heals on the next change.
            runCatching { InboxApi.putPrefs(baseUrl, bag) }.onSuccess { serverBag = bag }
        }
    }
}
