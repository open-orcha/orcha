package io.openorcha.mobile.data

/** Owns tolerant serializers for API fields whose server representation varies. */

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * tasks.result is a JSONB column: /done writes `{"result": <text>, "by_agent_id": ...}`,
 * legacy rows may hold a bare string, and unset is null. The portal shipped the same
 * wrong assumption once (rendered "[object Object]") — this serializer accepts all
 * three shapes and yields the human-readable text.
 */
object FlexibleResultSerializer : KSerializer<String?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("FlexibleTaskResult", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): String? {
        val input = decoder as? JsonDecoder ?: return decoder.decodeString()
        return when (val el = input.decodeJsonElement()) {
            is JsonNull -> null
            is JsonPrimitive -> el.contentOrNull
            is JsonObject -> (el["result"] as? JsonPrimitive)?.contentOrNull ?: el.toString()
            else -> el.toString()
        }
    }

    override fun serialize(encoder: Encoder, value: String?) {
        if (value == null) encoder.encodeNull() else encoder.encodeString(value)
    }
}

/**
 * A task's plan decision arrives as an object — `{"decision": "approve"|"reject",
 * "reason": ..., "actor": ..., "at": ...}` — once a plan has been approved or rejected;
 * it's null before then. Older/edge rows may hold a bare string. Mirror
 * [FlexibleResultSerializer]: accept all three shapes and yield the verdict string, which
 * is all the UI's "has a decision been made?" checks need. Modelling this as a bare String
 * (the app's first cut) made snapshot parsing throw the instant any task had a decision,
 * which surfaced as a bogus "can't reach your laptop" connection error.
 */
object FlexiblePlanDecisionSerializer : KSerializer<String?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("FlexiblePlanDecision", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): String? {
        val input = decoder as? JsonDecoder ?: return decoder.decodeString()
        return when (val el = input.decodeJsonElement()) {
            is JsonNull -> null
            is JsonPrimitive -> el.contentOrNull
            is JsonObject -> (el["decision"] as? JsonPrimitive)?.contentOrNull ?: el.toString()
            else -> el.toString()
        }
    }

    override fun serialize(encoder: Encoder, value: String?) {
        if (value == null) encoder.encodeNull() else encoder.encodeString(value)
    }
}
