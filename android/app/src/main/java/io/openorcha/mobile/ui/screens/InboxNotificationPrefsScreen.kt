package io.openorcha.mobile.ui.screens

/* Settings › Notifications (web pages/settings/notifications/NotificationsSection.tsx):
   pause/snooze, mute this project, edit "This project" or "All projects", presets, the
   category × channel matrix (critical lock shown locked), quiet hours, and the link out to
   the phone's own notification settings. Every change saves at once; a failed save is
   undone and explained in plain words. */

import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import io.ktor.client.plugins.ResponseException
import io.openorcha.mobile.data.InboxApi
import io.openorcha.mobile.data.NotifPrefsPayload
import io.openorcha.mobile.data.NotifRule
import io.openorcha.mobile.data.StoredContainer
import io.openorcha.mobile.domain.NotifEditScope
import io.openorcha.mobile.domain.NotifPrefsLogic
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LRow
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.components.lPrimaryFill
import io.openorcha.mobile.ui.components.lPrimaryText
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import java.time.ZoneId

private val prefsJson = Json { encodeDefaults = true }

private fun rulesJson(rules: Map<String, NotifRule>) = prefsJson.encodeToJsonElement(rules)

internal fun prefsFailureText(err: Throwable): String =
    NotifPrefsLogic.errorText((err as? ResponseException)?.response?.status?.value)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun InboxNotificationPrefsScreen(container: StoredContainer, onBack: () -> Unit) {
    val p = Orcha.palette
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val base = container.baseUrl
    val cid = container.id
    val actor = container.humanAgentId
    var payload by remember { mutableStateOf<NotifPrefsPayload?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var editScope by remember { mutableStateOf(NotifEditScope.Project) }
    var reloadKey by remember { mutableStateOf(0) }
    BackHandler(onBack = onBack)

    LaunchedEffect(cid, reloadKey) {
        loadError = null
        runCatching { InboxApi.notificationPrefs(base, cid, actor) }
            .onSuccess { payload = it }
            .onFailure { loadError = prefsFailureText(it) }
    }

    /** Optimistic save: show [optimistic] now, replace with the server's answer, or undo. */
    fun save(optimistic: NotifPrefsPayload?, call: suspend () -> NotifPrefsPayload) {
        val before = payload
        if (optimistic != null) payload = optimistic
        saveError = null
        busy = true
        scope.launch {
            runCatching { call() }
                .onSuccess { payload = it }
                .onFailure {
                    payload = before
                    saveError = "Couldn't save — ${prefsFailureText(it)}. Your change was undone."
                }
            busy = false
        }
    }

    fun setRule(current: NotifPrefsPayload, category: String, rule: NotifRule) {
        if (editScope == NotifEditScope.AllProjects) {
            val rules = NotifPrefsLogic.defaultsWith(current, category, rule)
            save(current.copy(defaults = current.defaults.copy(rules = rules))) {
                InboxApi.putDefaultPrefs(base, cid, actor, buildJsonObject { put("rules", rulesJson(rules)) })
            }
        } else {
            val rules = NotifPrefsLogic.projectOverrideWith(current, category, rule)
            save(null) {
                InboxApi.putProjectPrefs(base, cid, actor, buildJsonObject { put("rules", rulesJson(rules)) })
            }
        }
    }

    Scaffold(
        containerColor = p.bg,
        topBar = {
            Column {
                CenterAlignedTopAppBar(
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = p.bg, titleContentColor = p.text),
                    title = { Text("Notifications", style = ltype(LType.Headline)) },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(OrchaIcons.ArrowBack, "Back", tint = p.text2) } },
                )
                LDivider()
            }
        },
    ) { padding ->
        val current = payload
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(horizontal = LSpace.l, vertical = LSpace.l),
            verticalArrangement = Arrangement.spacedBy(LSpace.xl),
        ) {
            when {
                current == null && loadError != null -> item {
                    LEmptyState(
                        icon = OrchaIcons.WarningAmber,
                        title = "Couldn't load notification settings",
                        message = loadError!!.replaceFirstChar { it.uppercase() } + ".",
                        actionTitle = "Try again",
                        onAction = { reloadKey++ },
                    )
                }
                current == null -> item {
                    Text("Loading notification settings…", style = ltype(LType.Meta), color = p.muted)
                }
                !current.editable -> item {
                    LEmptyState(
                        icon = OrchaIcons.Inbox,
                        title = "Notification settings belong to members of this project.",
                        message = "Ask an owner to add you as a member.",
                    )
                }
                else -> {
                    saveError?.let { item(key = "err") { Banner(BannerKind.Danger, it) } }
                    item(key = "pause") { PauseSection(current, busy, onPause = { until ->
                        save(current.copy(defaults = current.defaults.copy(pause = io.openorcha.mobile.data.NotifPause(until?.toDouble())))) {
                            InboxApi.putDefaultPrefs(base, cid, actor, buildJsonObject {
                                put("pause", buildJsonObject { if (until == null) put("until", JsonNull) else put("until", until) })
                            })
                        }
                    }, onResume = {
                        save(current.copy(defaults = current.defaults.copy(pause = null))) {
                            InboxApi.putDefaultPrefs(base, cid, actor, buildJsonObject { put("pause", JsonNull) })
                        }
                    }, onMute = { muted ->
                        save(current.copy(project = current.project.copy(muted = muted))) {
                            InboxApi.putProjectPrefs(base, cid, actor, buildJsonObject { put("muted", muted) })
                        }
                    }) }
                    item(key = "scope") {
                        LSection("Rules") {
                            LSegmented(
                                listOf(NotifEditScope.Project to "This project", NotifEditScope.AllProjects to "All projects"),
                                editScope,
                                { editScope = it },
                            )
                            Text(
                                if (editScope == NotifEditScope.Project) {
                                    "Changes here apply to this project only; everything else follows your defaults."
                                } else {
                                    "Your defaults — every project without its own setting follows these."
                                },
                                style = ltype(LType.Meta), color = p.muted, modifier = Modifier.padding(horizontal = 4.dp),
                            )
                            val rules = NotifPrefsLogic.rulesFor(current, editScope)
                            val active = NotifPrefsLogic.matchingPreset(current, rules)
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(LSpace.s), verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                                current.catalog.presets.forEach { preset ->
                                    LChip(preset.label, selected = active == preset.key, onClick = {
                                        if (busy) return@LChip
                                        if (editScope == NotifEditScope.AllProjects) {
                                            save(current.copy(defaults = current.defaults.copy(rules = preset.rules))) {
                                                InboxApi.putDefaultPrefs(base, cid, actor, buildJsonObject { put("rules", rulesJson(preset.rules)) })
                                            }
                                        } else {
                                            save(null) {
                                                InboxApi.putProjectPrefs(base, cid, actor, buildJsonObject { put("rules", rulesJson(preset.rules)) })
                                            }
                                        }
                                    })
                                }
                            }
                            if (editScope == NotifEditScope.Project && current.project.rules.isNotEmpty()) {
                                LButton("Use defaults", {
                                    save(null) { InboxApi.resetProjectPrefs(base, cid, actor) }
                                }, kind = LButtonKind.Ghost, size = LSize.Small, enabled = !busy)
                            }
                        }
                    }
                    val rules = NotifPrefsLogic.rulesFor(current, editScope)
                    val channels = current.catalog.channels.filter { current.channels[it.key]?.available != false }
                    items(current.catalog.categories, key = { "cat-${it.key}" }) { cat ->
                        val rule = rules[cat.key] ?: return@items
                        CategoryCard(
                            label = cat.label,
                            description = cat.description,
                            rule = rule,
                            scopes = current.catalog.scopes.map { it.key to it.label },
                            channels = channels.map { it.key to it.label },
                            lockReason = { ch -> NotifPrefsLogic.lockReason(current, cat.key, ch) },
                            overridden = editScope == NotifEditScope.Project && NotifPrefsLogic.isOverridden(current, cat.key),
                            busy = busy,
                            onRule = { setRule(current, cat.key, it) },
                            onUseDefault = {
                                val left = NotifPrefsLogic.projectOverrideWithout(current, cat.key)
                                save(null) {
                                    InboxApi.putProjectPrefs(base, cid, actor, buildJsonObject { put("rules", rulesJson(left)) })
                                }
                            },
                        )
                    }
                    NotifPrefsLogic.hiddenChannelsNote(current)?.let { note ->
                        item(key = "hidden") { Text(note, style = ltype(LType.Micro), color = p.muted, modifier = Modifier.padding(horizontal = 4.dp)) }
                    }
                    item(key = "quiet") {
                        QuietHoursSection(current, busy) { quiet ->
                            save(current.copy(defaults = current.defaults.copy(quietHours = quiet))) {
                                InboxApi.putDefaultPrefs(base, cid, actor, buildJsonObject {
                                    if (quiet == null) put("quiet_hours", JsonNull) else put("quiet_hours", buildJsonObject {
                                        put("start", quiet.start); put("end", quiet.end); put("tz", quiet.tz)
                                    })
                                })
                            }
                        }
                    }
                }
            }
            item(key = "system") {
                LSection("This phone") {
                    LCard(padding = 0.dp) {
                        LRow(
                            title = "System notification settings",
                            subtitle = "Sounds, banners and lock-screen alerts for Embodent on this phone",
                            onClick = {
                                runCatching {
                                    context.startActivity(
                                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                    )
                                }
                            },
                            trailing = { Icon(OrchaIcons.OpenInNew, null, tint = p.faint, modifier = Modifier.size(16.dp)) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PauseSection(
    current: NotifPrefsPayload,
    busy: Boolean,
    onPause: (Long?) -> Unit,
    onResume: () -> Unit,
    onMute: (Boolean) -> Unit,
) {
    val p = Orcha.palette
    var menu by remember { mutableStateOf(false) }
    val pausedText = NotifPrefsLogic.pauseText(current.defaults.pause)
    LSection("Pause") {
        LCard {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                Text(
                    pausedText ?: "Everything is on.",
                    style = ltype(LType.BodyEmph), color = if (pausedText != null) p.warn else p.text,
                    modifier = Modifier.weight(1f),
                )
                if (pausedText != null) {
                    LButton("Resume notifications", onResume, kind = LButtonKind.Secondary, size = LSize.Small, enabled = !busy)
                } else {
                    Column {
                        LButton("Pause notifications…", { menu = true }, kind = LButtonKind.Secondary, size = LSize.Small, enabled = !busy)
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            NotifPrefsLogic.PauseChoice.entries.forEach { choice ->
                                DropdownMenuItem(text = { Text(choice.label) }, onClick = {
                                    menu = false
                                    onPause(NotifPrefsLogic.pauseUntil(choice))
                                })
                            }
                        }
                    }
                }
            }
            Text(
                "Pausing silences alerts in every project. Budget hard stops still show in the app.",
                style = ltype(LType.Meta), color = p.muted, modifier = Modifier.padding(top = LSpace.s),
            )
            LDivider(Modifier.padding(vertical = LSpace.m))
            SwitchRow(
                title = "Mute this project",
                subtitle = "Stops alerts from this project only — the in-app list keeps everything.",
                checked = current.project.muted,
                enabled = !busy,
                onChange = onMute,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CategoryCard(
    label: String,
    description: String?,
    rule: NotifRule,
    scopes: List<Pair<String, String>>,
    channels: List<Pair<String, String>>,
    lockReason: (String) -> String?,
    overridden: Boolean,
    busy: Boolean,
    onRule: (NotifRule) -> Unit,
    onUseDefault: () -> Unit,
) {
    val p = Orcha.palette
    LCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
            Text(label, style = ltype(LType.BodyEmph), color = p.text, modifier = Modifier.weight(1f))
            if (overridden) LTag("This project", tint = p.accent)
        }
        description?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
        Text("Notify me about", style = ltype(LType.Micro), color = p.faint, modifier = Modifier.padding(top = LSpace.s))
        LSegmented(scopes, rule.scope, { if (!busy) onRule(rule.copy(scope = it)) })
        if (rule.scope != "off") {
            channels.forEach { (key, chLabel) ->
                val lock = lockReason(key)
                if (lock != null) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "$label — $chLabel, always on. $lock" },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(chLabel, style = ltype(LType.Body), color = p.text2, modifier = Modifier.weight(1f))
                        LTag("Always on")
                    }
                    Text(lock, style = ltype(LType.Micro), color = p.muted)
                } else {
                    SwitchRow(
                        title = chLabel,
                        checked = rule.channels[key] == true,
                        enabled = !busy,
                        a11yLabel = "$label — $chLabel",
                        onChange = { onRule(NotifPrefsLogic.withChannel(rule, key, it)) },
                    )
                }
            }
        }
        if (overridden) {
            LButton("Use your default", onUseDefault, kind = LButtonKind.Ghost, size = LSize.Small, enabled = !busy)
        }
    }
}

@Composable
private fun QuietHoursSection(
    current: NotifPrefsPayload,
    busy: Boolean,
    onSave: (io.openorcha.mobile.data.NotifQuietHours?) -> Unit,
) {
    val p = Orcha.palette
    val quiet = current.defaults.quietHours
    var start by remember(quiet) { mutableStateOf(quiet?.start ?: "22:00") }
    var end by remember(quiet) { mutableStateOf(quiet?.end ?: "07:00") }
    var tz by remember(quiet) { mutableStateOf(quiet?.tz ?: ZoneId.systemDefault().id) }
    val valid = NotifPrefsLogic.HHMM.matches(start) && NotifPrefsLogic.HHMM.matches(end) && start != end && tz.isNotBlank()
    LSection("Quiet hours") {
        LCard {
            SwitchRow(
                title = "Quiet hours",
                subtitle = "Hold alerts overnight; they wait in the app.",
                checked = quiet != null,
                enabled = !busy,
                onChange = { on ->
                    onSave(if (on) io.openorcha.mobile.data.NotifQuietHours("22:00", "07:00", ZoneId.systemDefault().id) else null)
                },
            )
            if (quiet != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s), modifier = Modifier.padding(top = LSpace.s)) {
                    OrchaField(start, { start = it }, label = "Quiet hours start", placeholder = "22:00", modifier = Modifier.weight(1f))
                    OrchaField(end, { end = it }, label = "Quiet hours end", placeholder = "07:00", modifier = Modifier.weight(1f))
                }
                OrchaField(tz, { tz = it }, label = "Time zone", placeholder = "Europe/London")
                if (!valid) Text("Use 24-hour times like 22:00, with a different start and end.", style = ltype(LType.Meta), color = p.danger)
                Spacer(Modifier.size(LSpace.s))
                LButton(
                    "Save quiet hours",
                    { onSave(io.openorcha.mobile.data.NotifQuietHours(start, end, tz.trim())) },
                    kind = LButtonKind.Secondary, size = LSize.Small,
                    enabled = !busy && valid && (start != quiet.start || end != quiet.end || tz.trim() != quiet.tz),
                )
            }
        }
    }
}

@Composable
internal fun SwitchRow(
    title: String,
    checked: Boolean,
    enabled: Boolean,
    onChange: (Boolean) -> Unit,
    subtitle: String? = null,
    a11yLabel: String? = null,
) {
    val p = Orcha.palette
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.m),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = ltype(if (subtitle != null) LType.BodyEmph else LType.Body), color = p.text)
            subtitle?.let { Text(it, style = ltype(LType.Meta), color = p.muted) }
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            enabled = enabled,
            modifier = Modifier.semantics {
                contentDescription = a11yLabel ?: title
                stateDescription = if (checked) "On" else "Off"
            },
            colors = SwitchDefaults.colors(
                checkedTrackColor = p.lPrimaryFill, checkedThumbColor = p.lPrimaryText,
                uncheckedTrackColor = p.surface2, uncheckedBorderColor = p.border2, uncheckedThumbColor = p.faint,
            ),
        )
    }
}
