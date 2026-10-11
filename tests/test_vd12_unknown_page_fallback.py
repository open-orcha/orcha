"""VD-12: an unknown page URL opened in a browser never shows raw JSON — it gets the SPA
shell (status 404) whose router renders the app's own fallback. API / asset / docs 404s
and non-HTML clients keep the JSON 404."""
from portal_backend import static_pages

HTML = {"Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}


def _shell(tmp_path, monkeypatch):
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "index.html").write_text("<!doctype html><div id=root></div>")
    monkeypatch.setattr(static_pages, "STATIC_DIR", tmp_path)
    monkeypatch.setattr(static_pages, "_HTML_CACHE", {})


async def test_unknown_page_serves_spa_shell(client, monkeypatch, tmp_path):
    _shell(tmp_path, monkeypatch)
    for path in ("/does-not-exist", "/tasks/abc"):
        r = await client.get(path, headers=HTML)
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("text/html")
        assert "<div id=root>" in r.text


async def test_api_and_non_html_404_stay_json(client, monkeypatch, tmp_path):
    _shell(tmp_path, monkeypatch)
    for path, headers in (("/api/nope", HTML), ("/assets/nope.css", HTML), ("/does-not-exist", {})):
        r = await client.get(path, headers=headers)
        assert r.status_code == 404
        assert r.json() == {"detail": "Not Found"}, path
    # a real route's own HTTPException keeps its JSON detail
    r = await client.get("/api/containers/not-a-uuid/budgets", headers=HTML)
    assert r.status_code == 400 and "detail" in r.json()


async def test_a_rebuilt_index_html_is_served_without_a_restart(client, monkeypatch, tmp_path):
    """#297: a CLI update rewrites dist/index.html under a running portal; the next page
    load must reference the new bundle, not the deleted one from a process-life cache."""
    import os

    _shell(tmp_path, monkeypatch)
    page = tmp_path / "dist" / "index.html"
    page.write_text('<script src="/assets/dist/assets/index-OLD.js"></script>')
    assert "index-OLD.js" in (await client.get("/tasks", headers=HTML)).text
    page.write_text('<script src="/assets/dist/assets/index-NEW.js"></script>')
    st = page.stat()
    os.utime(page, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))  # a distinct mtime on coarse clocks
    r = await client.get("/tasks", headers=HTML)
    assert "index-NEW.js" in r.text and "index-OLD.js" not in r.text
