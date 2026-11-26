"""VD-12: an unknown page URL opened in a browser never shows raw JSON — it gets the SPA
shell (status 404) whose router renders the app's own fallback. API / asset / docs 404s
and non-HTML clients keep the JSON 404."""
from portal_backend import static_pages

HTML = {"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}


def _seed_shell(monkeypatch, tmp_path):
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "index.html").write_text("<!doctype html><div id=root></div>", encoding="utf-8")
    monkeypatch.setattr(static_pages, "STATIC_DIR", tmp_path)
    monkeypatch.setattr(static_pages, "_HTML_CACHE", {})


async def test_unknown_page_serves_spa_shell(client, monkeypatch, tmp_path):
    _seed_shell(monkeypatch, tmp_path)
    for path in ("/does-not-exist", "/tasks/abc"):
        r = await client.get(path, headers=HTML)
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("text/html")
        assert "<div id=root>" in r.text


async def test_api_and_non_html_404_stay_json(client, monkeypatch, tmp_path):
    _seed_shell(monkeypatch, tmp_path)
    for path, headers in (("/api/nope", HTML), ("/assets/nope.css", HTML), ("/does-not-exist", {})):
        r = await client.get(path, headers=headers)
        assert r.status_code == 404
        assert r.json() == {"detail": "Not Found"}, path
    # a real route's own HTTPException keeps its JSON detail
    r = await client.get("/api/containers/not-a-uuid/budgets", headers=HTML)
    assert r.status_code == 400 and "detail" in r.json()
