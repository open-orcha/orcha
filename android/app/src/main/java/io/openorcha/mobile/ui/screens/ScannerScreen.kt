package io.openorcha.mobile.ui.screens

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.components.StateLayout
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* =============================================================================
   Flow 03 — the QR scanner (frame A1) + camera-permission-denied state (A2).
   A successful scan hands the raw payload to the same parser the manual path
   uses (`orcha-pair` JSON → baseUrl → probe). Torch + manual-entry fallback.
   ============================================================================= */

@androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
@Composable
fun ScannerScreen(
    onBack: () -> Unit,
    onPayload: (String) -> Unit,
    onManualEntry: () -> Unit,
) {
    val p = Orcha.palette
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var denied by remember { mutableStateOf(false) }
    var scanned by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        denied = !ok
    }
    DisposableEffect(Unit) {
        if (!granted) launcher.launch(Manifest.permission.CAMERA)
        onDispose { }
    }

    Box(Modifier.fillMaxSize().background(if (granted) Color.Black else p.bg)) {
        when {
            granted -> {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        val previewView = PreviewView(ctx)
                        val providerFuture = ProcessCameraProvider.getInstance(ctx)
                        providerFuture.addListener({
                            val provider = providerFuture.get()
                            val preview = Preview.Builder().build().also {
                                it.surfaceProvider = previewView.surfaceProvider
                            }
                            val scanner = BarcodeScanning.getClient(
                                BarcodeScannerOptions.Builder()
                                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                                    .build(),
                            )
                            val analysis = ImageAnalysis.Builder()
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()
                            analysis.setAnalyzer(ContextCompat.getMainExecutor(ctx)) { proxy ->
                                val media = proxy.image
                                if (media == null || scanned) {
                                    proxy.close()
                                    return@setAnalyzer
                                }
                                val image = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
                                scanner.process(image)
                                    .addOnSuccessListener { codes ->
                                        val value = codes.firstOrNull()?.rawValue
                                        if (!scanned && !value.isNullOrBlank()) {
                                            scanned = true
                                            onPayload(value)
                                        }
                                    }
                                    .addOnCompleteListener { proxy.close() }
                            }
                            runCatching {
                                provider.unbindAll()
                                provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                            }
                        }, ContextCompat.getMainExecutor(ctx))
                        previewView
                    },
                )
                ScannerFrameOverlay(scanned = scanned, onManualEntry = onManualEntry)
            }
            denied -> StateLayout(
                title = "Camera access needed",
                sub = "Embodent uses the camera only to read the pairing QR from your portal. Grant access in Settings, or type the address instead.",
                danger = true,
                glyph = { Icon(OrchaIcons.NoPhotography, null, tint = p.danger, modifier = Modifier.size(34.dp)) },
            ) {
                LButton("Open Settings", {
                    context.startActivity(
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
                    )
                }, icon = OrchaIcons.Settings, kind = LButtonKind.Primary)
                LButton("Enter the address instead", onManualEntry, kind = LButtonKind.Ghost)
            }
            else -> StateLayout(title = "Requesting camera…", sub = null)
        }
        IconButton(
            onClick = onBack,
            modifier = Modifier.align(Alignment.TopStart).statusBarsPadding().padding(8.dp),
        ) { Icon(OrchaIcons.Close, "Close", tint = if (granted) Color.White else p.text2) }
    }
}


/** Linear QR frame over the live camera: dimmed surround, rounded corner brackets
 *  (green once scanned), a caption chip and the manual-entry escape hatch. */
@Composable
private fun ScannerFrameOverlay(scanned: Boolean, onManualEntry: () -> Unit) {
    val p = Orcha.palette
    val pulse = rememberInfiniteTransition(label = "pulse").animateFloat(
        initialValue = 1f, targetValue = 1.02f,
        animationSpec = infiniteRepeatable(tween(1600), RepeatMode.Reverse), label = "scale",
    )
    val bracket = if (scanned) p.ok else Color.White
    Box(Modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize().graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)) {
            val side = minOf(size.width * 0.68f, 280.dp.toPx()) * pulse.value
            val topLeft = Offset((size.width - side) / 2f, (size.height - side) / 2f - 40.dp.toPx())
            val r = 22.dp.toPx()
            drawRect(Color.Black.copy(alpha = 0.45f))
            drawRoundRect(Color.Transparent, topLeft, Size(side, side), CornerRadius(r), blendMode = BlendMode.Clear)
            val len = side * 0.16f
            val cr = 18.dp.toPx()
            val l = topLeft.x; val t = topLeft.y; val rt = l + side; val b = t + side
            val path = Path().apply {
                moveTo(l, t + len); lineTo(l, t + cr); quadraticTo(l, t, l + cr, t); lineTo(l + len, t)
                moveTo(rt - len, t); lineTo(rt - cr, t); quadraticTo(rt, t, rt, t + cr); lineTo(rt, t + len)
                moveTo(rt, b - len); lineTo(rt, b - cr); quadraticTo(rt, b, rt - cr, b); lineTo(rt - len, b)
                moveTo(l + len, b); lineTo(l + cr, b); quadraticTo(l, b, l, b - cr); lineTo(l, b - len)
            }
            drawPath(path, bracket, style = Stroke(width = 3.dp.toPx(), cap = StrokeCap.Round))
        }
        Column(
            Modifier.align(Alignment.BottomCenter).padding(bottom = 40.dp, start = LSpace.l, end = LSpace.l),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(LSpace.m),
        ) {
            Column(
                Modifier
                    .background(Color(0xCC141516), RoundedCornerShape(12.dp))
                    .padding(horizontal = LSpace.l, vertical = LSpace.m),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    if (scanned) "Pairing…" else "Scan the pairing QR",
                    style = ltype(LType.Headline), color = Color.White,
                    modifier = Modifier.semantics { heading() },
                )
                Text("Portal → Settings → Devices and pairing", style = ltype(LType.Meta), color = Color.White.copy(alpha = 0.75f))
            }
            TextButton(onClick = onManualEntry, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Can't scan? Enter the address", style = ltype(LType.BodyEmph), color = Color.White)
            }
        }
    }
}
