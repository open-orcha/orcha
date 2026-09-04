package io.openorcha.mobile.ui.icons

/**
 * Orcha's iconography — Lucide (https://lucide.dev, ISC license, license text at
 * app/src/main/fontLicenses/ISC-lucide.txt), replacing Material Symbols app-wide.
 * Stroke-drawn 24dp glyphs (2dp round caps/joins) to match the portal's visual
 * language; property names keep the old Material names so call sites read the same.
 *
 * GENERATED from lucide-static 0.462.0 SVGs — regenerate with
 * scripts/gen_orcha_icons.py rather than editing path data by hand.
 */

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

private fun lucide(name: String, autoMirror: Boolean, vararg d: String): ImageVector {
    val b = ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
        autoMirror = autoMirror,
    )
    for (p in d) b.addPath(
        pathData = addPathNodes(p),
        stroke = SolidColor(Color.Black),
        strokeLineWidth = 2f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
    )
    return b.build()
}

object OrchaIcons {
    val ArrowBack: ImageVector by lazy { lucide(
        "arrow-left", true,
        "m12 19-7-7 7-7",
        "M19 12H5",
    ) }
    val ArrowForward: ImageVector by lazy { lucide(
        "arrow-right", true,
        "M5 12h14",
        "m12 5 7 7-7 7",
    ) }
    val Send: ImageVector by lazy { lucide(
        "send", true,
        "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
        "m21.854 2.147-10.94 10.939",
    ) }
    val Add: ImageVector by lazy { lucide(
        "plus", false,
        "M5 12h14",
        "M12 5v14",
    ) }
    val Check: ImageVector by lazy { lucide(
        "check", false,
        "M20 6 9 17l-5-5",
    ) }
    val Checklist: ImageVector by lazy { lucide(
        "list-checks", false,
        "m3 17 2 2 4-4",
        "m3 7 2 2 4-4",
        "M13 6h8",
        "M13 12h8",
        "M13 18h8",
    ) }
    val ChevronRight: ImageVector by lazy { lucide(
        "chevron-right", false,
        "m9 18 6-6-6-6",
    ) }
    val Circle: ImageVector by lazy { lucide(
        "circle", false,
        "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
    ) }
    val Close: ImageVector by lazy { lucide(
        "x", false,
        "M18 6 6 18",
        "m6 6 12 12",
    ) }
    val DesktopWindows: ImageVector by lazy { lucide(
        "monitor", false,
        "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2Z",
        "M8 21L16 21",
        "M12 17L12 21",
    ) }
    val ExpandMore: ImageVector by lazy { lucide(
        "chevron-down", false,
        "m6 9 6 6 6-6",
    ) }
    val Forum: ImageVector by lazy { lucide(
        "messages-square", false,
        "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z",
        "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
    ) }
    val Home: ImageVector by lazy { lucide(
        "house", false,
        "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8",
        "M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    ) }
    val Inbox: ImageVector by lazy { lucide(
        "inbox", false,
        "M22 12L16 12L14 15L10 15L8 12L2 12",
        "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
    ) }
    val Key: ImageVector by lazy { lucide(
        "key-round", false,
        "M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z",
        "M16 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
    ) }
    val MoreVert: ImageVector by lazy { lucide(
        "ellipsis-vertical", false,
        "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
        "M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
        "M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    ) }
    val NoPhotography: ImageVector by lazy { lucide(
        "camera-off", false,
        "M2 2L22 22",
        "M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16",
        "M9.5 4h5L17 7h3a2 2 0 0 1 2 2v7.5",
        "M14.121 15.121A3 3 0 1 1 9.88 10.88",
    ) }
    val OpenInNew: ImageVector by lazy { lucide(
        "external-link", false,
        "M15 3h6v6",
        "M10 14 21 3",
        "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
    ) }
    val PlayArrow: ImageVector by lazy { lucide(
        "play", false,
        "M6 3L20 12L6 21L6 3Z",
    ) }
    val Public: ImageVector by lazy { lucide(
        "globe", false,
        "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
        "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
        "M2 12h20",
    ) }
    val QrCodeScanner: ImageVector by lazy { lucide(
        "scan-qr-code", false,
        "M17 12v4a1 1 0 0 1-1 1h-4",
        "M17 3h2a2 2 0 0 1 2 2v2",
        "M17 8V7",
        "M21 17v2a2 2 0 0 1-2 2h-2",
        "M3 7V5a2 2 0 0 1 2-2h2",
        "M7 17h.01",
        "M7 21H5a2 2 0 0 1-2-2v-2",
        "M8 7h3a1 1 0 0 1 1 1v3a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1Z",
    ) }
    val Refresh: ImageVector by lazy { lucide(
        "refresh-cw", false,
        "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
        "M21 3v5h-5",
        "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
        "M8 16H3v5",
    ) }
    val RemoveRedEye: ImageVector by lazy { lucide(
        "eye", false,
        "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
        "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
    ) }
    val Schedule: ImageVector by lazy { lucide(
        "clock", false,
        "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
        "M12 6L12 12L16 14",
    ) }
    val Search: ImageVector by lazy { lucide(
        "search", false,
        "M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0",
        "m21 21-4.3-4.3",
    ) }
    val Settings: ImageVector by lazy { lucide(
        "settings", false,
        "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
        "M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
    ) }
    val SmartToy: ImageVector by lazy { lucide(
        "bot", false,
        "M12 8V4H8",
        "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2Z",
        "M2 14h2",
        "M20 14h2",
        "M15 13v2",
        "M9 13v2",
    ) }
    val Terminal: ImageVector by lazy { lucide(
        "terminal", false,
        "M4 17L10 11L4 5",
        "M12 19L20 19",
    ) }
    val Verified: ImageVector by lazy { lucide(
        "badge-check", false,
        "M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z",
        "m9 12 2 2 4-4",
    ) }
    val WarningAmber: ImageVector by lazy { lucide(
        "triangle-alert", false,
        "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
        "M12 9v4",
        "M12 17h.01",
    ) }
    val WifiOff: ImageVector by lazy { lucide(
        "wifi-off", false,
        "M12 20h.01",
        "M8.5 16.429a5 5 0 0 1 7 0",
        "M5 12.859a10 10 0 0 1 5.17-2.69",
        "M19 12.859a10 10 0 0 0-2.007-1.523",
        "M2 8.82a15 15 0 0 1 4.177-2.643",
        "M22 8.82a15 15 0 0 0-11.288-3.764",
        "m2 2 20 20",
    ) }
    val GitHub: ImageVector by lazy { lucide(
        "github", false,
        "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
        "M9 18c-4.51 2-5-2-7-2",
    ) }
}
