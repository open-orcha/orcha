"""#287 — INTEGRATION teeth for the two digest-curation seams.

The pure-module behaviour lives in `test_iss287_digest_curate.py`. Those tests prove the
curator functions are correct; they do NOT prove the two CALL SITES actually invoke them.
These two teeth bite the wiring — each fails if the curation call is deleted from its seam:

  * WRITE seam — `post_digest` (portal/main.py) must run `dedup_digest` BEFORE storing, so the
    persisted row is Tier-0 compacted. Exercised end-to-end through the real route + test DB.
  * BOOT seam — `notifier._build_persona` must run `curate_injected_digest` on the boot copy, so
    the injected digest is deduped/trimmed. Exercised against a monkeypatched `_get_json`.
"""
import pytest

from orcha_cli import notifier


# --------------------------------------------------------------- WRITE seam (route + DB)

async def test_post_digest_dedups_before_storing(client, make_agent):
    """POST /digest with exact-duplicate + empty entries → the STORED row is compacted.

    Mutation tooth: delete the `dedup_digest` block in `post_digest` and the stored row keeps
    both duplicates + the empty entry, failing the asserts below.
    """
    a = await make_agent("Vault", "persistence")
    aid = a["agent_id"]

    body = {
        "current_focus": "wiring the seam",
        "decisions": [{"text": "keep me"}, {"text": "keep me"}],          # exact dup → collapse to 1
        "learnings": [{"text": "real learning"}, {"text": ""}],            # empty entry → dropped
        "open_threads": [{"text": "thread A"}],
    }
    r = await client.post(f"/api/agents/{aid}/digest", json=body)
    assert r.status_code == 201, r.text

    d = (await client.get(f"/api/agents/{aid}/digest")).json()["digest"]
    # current_focus is never touched by Tier-0 compaction
    assert d["current_focus"] == "wiring the seam"
    # exact duplicate collapsed to a single entry
    assert d["decisions"] == [{"text": "keep me"}]
    # empty entry dropped, real one kept (and never emptied to nothing)
    assert d["learnings"] == [{"text": "real learning"}]
    assert d["open_threads"] == [{"text": "thread A"}]


# --------------------------------------------------------------- BOOT seam (_build_persona)

def test_build_persona_curates_injected_digest(monkeypatch):
    """`_build_persona` must curate the boot copy → an exact-duplicate decision renders ONCE.

    Mutation tooth: delete the `curate_injected_digest` call in `_build_persona` and the raw
    digest is formatted verbatim, so the marker appears TWICE and the count assert fails.
    """
    marker = "UNIQ_SEAM_MARKER_ZZZ"

    def _get(url, **k):
        if "/persona" in url:
            return {"system_prompt": "You are Vault."}
        if "/digest" in url:
            return {"digest": {"current_focus": "f",
                               "decisions": [{"text": marker}, {"text": marker}]}}
        if "/protocol" in url:
            return {"protocol": None}
        return None

    monkeypatch.setattr(notifier, "_get_json", _get)

    out = notifier._build_persona("http://test", "A1")
    assert out is not None
    # raw (un-curated) would render the duplicate twice; curation collapses it to one
    assert out.count(marker) == 1
