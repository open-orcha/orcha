package io.openorcha.mobile.ui.screens

/** Owns the shared one-field sheet used by request text actions. */

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.RequestDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.RequestsView
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.DangerTonalButton
import io.openorcha.mobile.ui.components.LinkifiedText
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.OrchaField
import io.openorcha.mobile.ui.components.PrimaryButton
import io.openorcha.mobile.ui.components.RequestStatusPill
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.TonalButton
import io.openorcha.mobile.ui.theme.MonoSmStyle
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 07 — Request detail: flow header, chain context, payload, response quote,
   timeline, and the state×role action matrix. Actions run through bottom sheets.
   ============================================================================= */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TextSheet(
    kicker: String,
    title: String,
    label: String,
    required: Boolean,
    confirm: String,
    busy: Boolean,
    destructive: Boolean = false,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    val p = Orcha.palette
    var text by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = p.raised) {
        // A1: a multi-thousand-char payload must never push the field/buttons out of
        // reach — cap the title (full body stays on the detail screen behind the sheet),
        // make the sheet scrollable, and keep it above the keyboard.
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = 30.dp)
                .imePadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(kicker, style = MaterialTheme.typography.labelMedium, color = if (destructive) p.danger else p.accent)
            Text(title, style = MaterialTheme.typography.titleSmall, color = p.text2, maxLines = 4, overflow = TextOverflow.Ellipsis)
            OrchaField(text, { text = it }, label = label, minLines = 3)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (destructive) {
                    DangerTonalButton(confirm, { onConfirm(text.trim()) }, Modifier.weight(1f), enabled = (!required || text.isNotBlank()) && !busy)
                } else {
                    PrimaryButton(confirm, { onConfirm(text.trim()) }, Modifier.weight(1f), enabled = (!required || text.isNotBlank()) && !busy)
                }
                NeutralButton("Cancel", onDismiss, enabled = !busy)
            }
        }
    }
}

/** Convert-to-task sheet: Title + DoD + assignee, same validation as Create task. */
