package io.openorcha.mobile.ui.components

/** Image preview from raw bytes fetched through the authenticated client (no Coil here). */

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.ui.theme.Orcha
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Longest decoded edge — keeps a huge screenshot from blowing the heap. */
private const val MAX_EDGE_PX = 2048

private sealed interface PreviewState {
    data object Loading : PreviewState
    data class Ready(val bitmap: Bitmap) : PreviewState
    data class Failed(val message: String) : PreviewState
}

/**
 * Fetches [load] once per [key], decodes it off the main thread with down-sampling and
 * shows it fitted to the width. [description] is the image's accessibility label.
 */
@Composable
fun RawImagePreview(
    key: Any,
    description: String,
    modifier: Modifier = Modifier,
    load: suspend () -> ByteArray,
) {
    val p = Orcha.palette
    var state by remember(key) { mutableStateOf<PreviewState>(PreviewState.Loading) }
    LaunchedEffect(key) {
        state = runCatching { load() }.fold(
            onSuccess = { bytes ->
                withContext(Dispatchers.Default) { decodeSampled(bytes) }
                    ?.let { PreviewState.Ready(it) }
                    ?: PreviewState.Failed("This image can't be previewed on the phone.")
            },
            onFailure = { PreviewState.Failed("Couldn't load this version of the image.") },
        )
    }
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = 80.dp)
            .clip(shape)
            .background(p.surface2, shape),
        contentAlignment = Alignment.Center,
    ) {
        when (val s = state) {
            PreviewState.Loading -> Text("Loading preview…", style = ltype(LType.Meta), color = p.faint, modifier = Modifier.padding(16.dp))
            is PreviewState.Failed -> Text(s.message, style = ltype(LType.Meta), color = p.faint, modifier = Modifier.padding(16.dp))
            is PreviewState.Ready -> Image(
                bitmap = s.bitmap.asImageBitmap(),
                contentDescription = description,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp).padding(8.dp),
            )
        }
    }
}

internal fun decodeSampled(bytes: ByteArray): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_EDGE_PX) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}
