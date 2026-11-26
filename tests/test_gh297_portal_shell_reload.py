"""GH #297: the portal must serve the CURRENT start page after it is rebuilt on disk.

The page names a hashed script (index-<hash>.js). A rebuild deletes the old script, so a
server that keeps serving its first-read copy sends fresh browsers to a 404 and a blank
page until it is restarted. serve_page re-reads the file when its mtime/size changes."""
import os

from portal_backend import static_pages

PAGE = "dist/index.html"


def _setup(monkeypatch, tmp_path):
    (tmp_path / "dist").mkdir()
    monkeypatch.setattr(static_pages, "STATIC_DIR", tmp_path)
    monkeypatch.setattr(static_pages, "_HTML_CACHE", {})
    return tmp_path / PAGE


def _write(path, script, mtime_ns):
    path.write_text(f'<!doctype html><script src="/assets/dist/assets/{script}"></script>', encoding="utf-8")
    os.utime(path, ns=(mtime_ns, mtime_ns))


def test_rebuilt_page_is_served_without_restart(monkeypatch, tmp_path):
    page = _setup(monkeypatch, tmp_path)
    _write(page, "index-BmQ1RS7B.js", 1_000_000_000_000_000_000)
    first = static_pages.serve_page(PAGE)
    assert first.status_code == 200 and b"index-BmQ1RS7B.js" in first.body

    # Same length name, so only the mtime tells the rebuild apart.
    _write(page, "index-BqgeZroa.js", 1_000_000_000_000_000_001)
    second = static_pages.serve_page(PAGE)
    assert second.status_code == 200
    assert b"index-BqgeZroa.js" in second.body
    assert b"index-BmQ1RS7B.js" not in second.body


def test_size_change_alone_triggers_reread(monkeypatch, tmp_path):
    page = _setup(monkeypatch, tmp_path)
    _write(page, "index-a.js", 1_000_000_000_000_000_000)
    static_pages.serve_page(PAGE)
    _write(page, "index-longer-name.js", 1_000_000_000_000_000_000)
    assert b"index-longer-name.js" in static_pages.serve_page(PAGE).body


def test_unchanged_page_is_read_once(monkeypatch, tmp_path):
    page = _setup(monkeypatch, tmp_path)
    _write(page, "index-BqgeZroa.js", 1_000_000_000_000_000_000)
    reads = []
    real_read_text = type(page).read_text

    def counting_read_text(self, *args, **kwargs):
        reads.append(self)
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(type(page), "read_text", counting_read_text)
    for _ in range(3):
        assert static_pages.serve_page(PAGE).status_code == 200
    assert len(reads) == 1


def test_removed_page_returns_503_not_stale_copy(monkeypatch, tmp_path):
    page = _setup(monkeypatch, tmp_path)
    _write(page, "index-BqgeZroa.js", 1_000_000_000_000_000_000)
    assert static_pages.serve_page(PAGE).status_code == 200
    page.unlink()
    gone = static_pages.serve_page(PAGE)
    assert gone.status_code == 503
    assert b"index-BqgeZroa.js" not in gone.body
    assert PAGE not in static_pages._HTML_CACHE
