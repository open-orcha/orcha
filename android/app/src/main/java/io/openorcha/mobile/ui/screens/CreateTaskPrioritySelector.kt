package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.PriorityBand
import io.openorcha.mobile.ui.components.LChip
import io.openorcha.mobile.ui.components.LPriorityGlyph
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.priorityLabel

/** Owns the create-task priority label and three-band selector (Linear chips with bars). */
@Composable
internal fun CreateTaskPrioritySelector(
    band: PriorityBand,
    onChange: (PriorityBand) -> Unit,
) {
    val value = MobileUx.priorityFor(band)
    LSection("Priority", trailing = {
        androidx.compose.material3.Text(
            "${priorityLabel(value)} · P$value",
            style = io.openorcha.mobile.ui.components.ltype(io.openorcha.mobile.ui.components.LType.Meta),
            color = io.openorcha.mobile.ui.theme.Orcha.palette.faint,
        )
    }) {
        Row(horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
            listOf(PriorityBand.Low to "Low", PriorityBand.Normal to "Normal", PriorityBand.High to "High").forEach { (b, label) ->
                val selected = when (band) {
                    PriorityBand.Low -> b == PriorityBand.Low
                    PriorityBand.High -> b == PriorityBand.High
                    else -> b == PriorityBand.Normal
                }
                LChip(label, selected = selected, onClick = { onChange(b) })
            }
        }
    }
}
