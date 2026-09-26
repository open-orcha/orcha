package io.openorcha.mobile.ui.screens

import androidx.compose.runtime.Composable
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.PriorityBand
import io.openorcha.mobile.ui.components.SectionH
import io.openorcha.mobile.ui.components.SegControl

/** Owns the create-task priority label and three-band selector. */
@Composable
internal fun CreateTaskPrioritySelector(
    band: PriorityBand,
    onChange: (PriorityBand) -> Unit,
) {
    SectionH("Priority", "P${MobileUx.priorityFor(band)}")
    SegControl(
        options = listOf("Low", "Normal", "High"),
        selected = when (band) {
            PriorityBand.Low -> 0
            PriorityBand.High -> 2
            else -> 1
        },
        onSelect = {
            onChange(
                when (it) {
                    0 -> PriorityBand.Low
                    2 -> PriorityBand.High
                    else -> PriorityBand.Normal
                },
            )
        },
    )
}
