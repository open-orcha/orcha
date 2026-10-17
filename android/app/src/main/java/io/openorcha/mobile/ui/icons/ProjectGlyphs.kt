package io.openorcha.mobile.ui.icons

/* D14 project-icon glyphs — Lucide (https://lucide.dev, ISC licence, text at
   app/src/main/fontLicenses/ISC-lucide.txt), the same 24×24 path data as the portal's
   frontend/src/components/primitives/ProjectIcon.tsx GLYPH_PATHS and the desktop host.
   <circle>/<rect>/<ellipse> elements are converted to equivalent arcs/lines.
   GENERATED — keep in lockstep with GLYPH_PATHS (names = backend PROJECT_ICON_GLYPHS). */

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

object ProjectGlyphs {
    /** Lucide path data per glyph name, in the portal's order. */
    val PATHS: Map<String, List<String>> = linkedMapOf(
        "box" to listOf(
            "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
            "m3.3 7 8.7 5 8.7-5",
            "M12 22V12",
        ),
        "folder" to listOf(
            "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
        ),
        "code" to listOf(
            "m16 18 6-6-6-6",
            "m8 6-6 6 6 6",
        ),
        "terminal" to listOf(
            "m4 17 6-6-6-6",
            "M12 19h8",
        ),
        "rocket" to listOf(
            "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z",
            "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z",
            "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0",
            "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5",
        ),
        "globe" to listOf(
            "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0",
            "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
            "M2 12h20",
        ),
        "smartphone" to listOf(
            "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-16a2 2 0 0 1 2 -2z",
            "M12 18h.01",
        ),
        "server" to listOf(
            "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2z",
            "M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2z",
            "M6 6h.01",
            "M6 18h.01",
        ),
        "database" to listOf(
            "M3 5a9 3 0 1 0 18 0a9 3 0 1 0 -18 0",
            "M3 5V19A9 3 0 0 0 21 19V5",
            "M3 12A9 3 0 0 0 21 12",
        ),
        "cloud" to listOf(
            "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z",
        ),
        "cpu" to listOf(
            "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z",
            "M10 9h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1z",
            "M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2",
        ),
        "bot" to listOf(
            "M12 8V4H8",
            "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2z",
            "M2 14h2M20 14h2M15 13v2M9 13v2",
        ),
        "zap" to listOf(
            "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
        ),
        "flask" to listOf(
            "M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2",
            "M8.5 2h7",
            "M7 16h10",
        ),
        "shield" to listOf(
            "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
        ),
        "book" to listOf(
            "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z",
            "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z",
        ),
        "briefcase" to listOf(
            "M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16",
            "M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z",
        ),
        "cart" to listOf(
            "M7 21a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
            "M18 21a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
            "M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12",
        ),
        "gamepad" to listOf(
            "M6 11h4M8 9v4M15 12h.01M18 10h.01",
            "M17.32 5H6.68a4 4 0 0 0-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.55-.6-6.58-.69-7.26A4 4 0 0 0 17.32 5z",
        ),
        "music" to listOf(
            "M9 18V5l12-2v13",
            "M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
            "M15 16a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
        ),
        "camera" to listOf(
            "M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z",
            "M9 13a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
        ),
        "palette" to listOf(
            "M13 6.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
            "M17 10.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
            "M8 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
            "M6 12.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
            "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z",
        ),
        "heart" to listOf(
            "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
        ),
        "star" to listOf(
            "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z",
        ),
        "leaf" to listOf(
            "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z",
            "M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12",
        ),
        "wrench" to listOf(
            "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
        ),
        "chart" to listOf(
            "M3 3v16a2 2 0 0 0 2 2h16",
            "M18 17V9",
            "M13 17V5",
            "M8 17v-3",
        ),
        "mail" to listOf(
            "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z",
            "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",
        ),
    )

    /** Extra search words per glyph (the name itself always matches) — portal GLYPH_WORDS. */
    val WORDS: Map<String, String> = mapOf(
        "box" to "cube package default",
        "code" to "dev brackets",
        "terminal" to "cli shell",
        "globe" to "web world site",
        "smartphone" to "mobile phone app ios android",
        "server" to "backend api",
        "database" to "db data sql",
        "cpu" to "chip hardware",
        "bot" to "ai robot agent",
        "zap" to "fast lightning",
        "flask" to "lab science experiment",
        "shield" to "security",
        "book" to "docs documentation",
        "briefcase" to "work business",
        "cart" to "shop store commerce",
        "gamepad" to "game",
        "chart" to "analytics metrics",
        "mail" to "email",
    )

    val NAMES: List<String> get() = PATHS.keys.toList()

    private val cache = HashMap<String, ImageVector>()

    /** The glyph as a stroked ImageVector (tint at the use site); null for an unknown name. */
    fun vector(name: String): ImageVector? {
        val paths = PATHS[name] ?: return null
        return cache.getOrPut(name) {
            val b = ImageVector.Builder(
                name = "project-$name", defaultWidth = 24.dp, defaultHeight = 24.dp,
                viewportWidth = 24f, viewportHeight = 24f,
            )
            for (p in paths) b.addPath(
                pathData = addPathNodes(p),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 1.9f, // the portal's GlyphSvg stroke
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
            b.build()
        }
    }
}
