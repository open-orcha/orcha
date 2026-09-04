#!/usr/bin/env python3
"""Generate OrchaIcons.kt from Lucide SVGs (stroke-preserving ImageVectors)."""
import re, sys, xml.etree.ElementTree as ET

MAP = {  # Compose property name -> (lucide file, autoMirror)
    "ArrowBack": ("arrow-left", True),
    "ArrowForward": ("arrow-right", True),
    "Send": ("send", True),
    "Add": ("plus", False),
    "Check": ("check", False),
    "Checklist": ("list-checks", False),
    "ChevronRight": ("chevron-right", False),
    "Circle": ("circle", False),
    "Close": ("x", False),
    "DesktopWindows": ("monitor", False),
    "ExpandMore": ("chevron-down", False),
    "Forum": ("messages-square", False),
    "Home": ("house", False),
    "Inbox": ("inbox", False),
    "Key": ("key-round", False),
    "MoreVert": ("ellipsis-vertical", False),
    "NoPhotography": ("camera-off", False),
    "OpenInNew": ("external-link", False),
    "PlayArrow": ("play", False),
    "Public": ("globe", False),
    "QrCodeScanner": ("scan-qr-code", False),
    "Refresh": ("refresh-cw", False),
    "RemoveRedEye": ("eye", False),
    "Schedule": ("clock", False),
    "Search": ("search", False),
    "Settings": ("settings", False),
    "SmartToy": ("bot", False),
    "Terminal": ("terminal", False),
    "Verified": ("badge-check", False),
    "WarningAmber": ("triangle-alert", False),
    "WifiOff": ("wifi-off", False),
    "GitHub": ("github", False),
}

def f(v):
    s = ("%g" % float(v))
    return s

def shape_to_d(el):
    tag = el.tag.split("}")[-1]
    a = el.attrib
    if tag == "path":
        return a["d"]
    if tag == "circle":
        cx, cy, r = float(a["cx"]), float(a["cy"]), float(a["r"])
        return (f"M{f(cx - r)} {f(cy)}"
                f"a{f(r)} {f(r)} 0 1 0 {f(2*r)} 0"
                f"a{f(r)} {f(r)} 0 1 0 {f(-2*r)} 0")
    if tag == "ellipse":
        cx, cy, rx, ry = (float(a["cx"]), float(a["cy"]), float(a["rx"]), float(a["ry"]))
        return (f"M{f(cx - rx)} {f(cy)}"
                f"a{f(rx)} {f(ry)} 0 1 0 {f(2*rx)} 0"
                f"a{f(rx)} {f(ry)} 0 1 0 {f(-2*rx)} 0")
    if tag == "rect":
        x, y, w, h = (float(a.get("x", 0)), float(a.get("y", 0)), float(a["width"]), float(a["height"]))
        rx = float(a.get("rx", 0))
        if rx == 0:
            return f"M{f(x)} {f(y)}h{f(w)}v{f(h)}h{f(-w)}Z"
        return (f"M{f(x+rx)} {f(y)}h{f(w-2*rx)}a{f(rx)} {f(rx)} 0 0 1 {f(rx)} {f(rx)}"
                f"v{f(h-2*rx)}a{f(rx)} {f(rx)} 0 0 1 {f(-rx)} {f(rx)}"
                f"h{f(-(w-2*rx))}a{f(rx)} {f(rx)} 0 0 1 {f(-rx)} {f(-rx)}"
                f"v{f(-(h-2*rx))}a{f(rx)} {f(rx)} 0 0 1 {f(rx)} {f(-rx)}Z")
    if tag == "line":
        return f"M{f(a['x1'])} {f(a['y1'])}L{f(a['x2'])} {f(a['y2'])}"
    if tag in ("polyline", "polygon"):
        pts = re.findall(r"[-0-9.]+", a["points"])
        pairs = list(zip(pts[0::2], pts[1::2]))
        d = f"M{pairs[0][0]} {pairs[0][1]}" + "".join(f"L{x} {y}" for x, y in pairs[1:])
        return d + ("Z" if tag == "polygon" else "")
    raise SystemExit(f"unhandled element <{tag}>")

def svg_paths(path):
    root = ET.parse(path).getroot()
    return [shape_to_d(el) for el in root if el.tag.split("}")[-1] != "title"]

out = []
out.append('''package io.openorcha.mobile.ui.icons

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

object OrchaIcons {''')
for prop, (fname, mirror) in MAP.items():
    ds = svg_paths(f"lucide/{fname}.svg")
    args = ",\n        ".join('"%s"' % d.replace("\\", "\\\\").replace('"', '\\"') for d in ds)
    out.append(f'    val {prop}: ImageVector by lazy {{ lucide(\n        "{fname}", {str(mirror).lower()},\n        {args},\n    ) }}')
out.append("}")
open(sys.argv[1], "w").write("\n".join(out) + "\n")
print(f"wrote {sys.argv[1]} with {len(MAP)} icons")
