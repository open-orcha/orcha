"""Resolve encrypted provider credentials and per-use-case provider choices."""

from typing import Optional

try:
    import secret_box
except ImportError:
    from orcha_cli import secret_box


def provider_stored_row(cur, container_id: str, provider: str):
    cur.execute(
        "SELECT key_enc, key_hint, set_at FROM container_provider_keys "
        "WHERE container_id=%s AND provider=%s",
        (container_id, provider),
    )
    return cur.fetchone()


def provider_api_key(cur, container_id: str, provider: str) -> Optional[str]:
    try:
        row = provider_stored_row(cur, container_id, provider)
        return secret_box.resolve_llm_key(row["key_enc"] if row else None)
    except Exception:
        return None


def container_llm_key(cur, container_id: str) -> Optional[str]:
    return provider_api_key(cur, container_id, "anthropic")


def provider_key_enc(cur, container_id: str, provider: str) -> Optional[str]:
    try:
        row = provider_stored_row(cur, container_id, provider)
        return row["key_enc"] if row else None
    except Exception:
        return None


def effective_use_case_provider(
    model_override: Optional[dict],
    use_case_key: str,
) -> str:
    if isinstance(model_override, dict) and model_override.get("provider"):
        return model_override["provider"]
    try:
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    return llm_util.resolve_spec(use_case_key).provider
