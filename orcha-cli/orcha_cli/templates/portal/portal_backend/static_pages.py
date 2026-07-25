"""Load portal HTML and return an actionable response when assets are missing."""

import pathlib

from fastapi.responses import HTMLResponse

STATIC_DIR = pathlib.Path(__file__).parent.parent / "static"
_HTML_CACHE: dict[str, str] = {}


def serve_page(name: str) -> HTMLResponse:
    if name not in _HTML_CACHE:
        path = STATIC_DIR / name
        if not path.is_file():
            cause = (
                "the portal/static/ directory is missing entirely"
                if not STATIC_DIR.is_dir()
                else f"portal/static/{name} is missing"
            )
            return HTMLResponse(missing_static_page(name, cause), status_code=503)
        _HTML_CACHE[name] = path.read_text(encoding="utf-8")
    return HTMLResponse(_HTML_CACHE[name])


def missing_static_page(name: str, cause: str) -> str:
    return f"""<!doctype html>
<html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>Orcha · portal not provisioned</title>
<style>
  body{{margin:0;min-height:100vh;display:grid;place-items:center;
    background:#0b0e14;color:#e6ebf5;
    font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial}}
  .card{{max-width:640px;margin:24px;padding:28px 30px;background:#141925;
    border:1px solid #263149;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.35)}}
  h1{{margin:0 0 6px;font-size:20px}}
  .sub{{color:#fbbf24;font-weight:600;margin-bottom:18px}}
  p{{color:#8a97b1;margin:10px 0}}
  code,pre{{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}}
  pre{{background:#0b0e14;border:1px solid #263149;border-radius:10px;
    padding:12px 14px;overflow-x:auto;color:#e6ebf5}}
  .muted{{color:#5b6680;font-size:13px;margin-top:18px}}
</style></head><body>
<div class=card>
  <h1>Portal not fully provisioned</h1>
  <div class=sub>Static page <code>{name}</code> couldn&#39;t be served</div>
  <p>The API is running, but {cause}. This <code>.orcha/</code> stack most
     likely predates PR&nbsp;#10, when the dashboard HTML moved out of
     <code>main.py</code> into <code>portal/static/</code>.</p>
  <p>Fix it from this project root:</p>
  <pre>uv tool install --reinstall --from &lt;repo&gt;/orcha-cli orcha-cli
orcha down -v &amp;&amp; orcha init</pre>
  <p class=muted>After re-init, reload this page (a hard refresh clears any
     cached old bundle). — Orcha #13</p>
</div></body></html>"""
