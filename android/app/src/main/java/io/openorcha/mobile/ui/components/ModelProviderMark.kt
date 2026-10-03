package io.openorcha.mobile.ui.components

/* The provider's mark (Claude / OpenAI) shown next to a model id or runtime, like the desktop
   app's launcher marks. Claude keeps its brand colour; OpenAI's monochrome mark takes the
   palette text colour so it reads in light and dark. Nothing renders for unknown models. */

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.R
import io.openorcha.mobile.domain.ModelProvider
import io.openorcha.mobile.domain.providerFor
import io.openorcha.mobile.ui.theme.Orcha

@Composable
fun ModelProviderMark(modelOrRuntime: String?, size: Dp = 14.dp, modifier: Modifier = Modifier, decorative: Boolean = false) {
    val provider = providerFor(modelOrRuntime) ?: return
    ProviderMark(provider, size, modifier, decorative)
}

/** [decorative] drops the label when adjacent text already names the provider. */
@Composable
fun ProviderMark(provider: ModelProvider, size: Dp = 14.dp, modifier: Modifier = Modifier, decorative: Boolean = false) {
    val label = if (decorative) null else provider.label
    when (provider) {
        ModelProvider.Claude -> Icon(
            painterResource(R.drawable.ic_brand_claude), contentDescription = label,
            tint = Color.Unspecified, modifier = modifier.size(size),
        )
        ModelProvider.OpenAI -> Icon(
            painterResource(R.drawable.ic_brand_openai), contentDescription = label,
            tint = Orcha.palette.text, modifier = modifier.size(size),
        )
    }
}

/** A model tag led by its provider mark (`[✳] claude-opus-4`); just the tag when unknown. */
@Composable
fun ModelTag(model: String?, modifier: Modifier = Modifier, fallback: String = "default") {
    androidx.compose.foundation.layout.Row(
        modifier,
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(5.dp),
    ) {
        ModelProviderMark(model)
        LTag(model ?: fallback)
    }
}
