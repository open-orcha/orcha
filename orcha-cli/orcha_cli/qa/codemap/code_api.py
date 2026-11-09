"""Endpoints from code (adapted from `app_map/code_api.py`): the backend calls an app makes
and the routes a JS server in the repo answers, keyed `METHOD pattern` like live traffic, so a
client call, a server route and a live request meet on one endpoint.

Client calls (`side: client`):
- JS/TS (web, React Native, Expo): `fetch`, `$fetch`/`ofetch`/`useFetch`/`useSWR`, `ky`, axios and
  any configured client (`api.get("/x")`, a client made with `axios.create`, or one named
  `*Api` / `*Client`), with template strings and `+` joins as `*` and a leading base URL dropped;
- Swift: `URL(string:)` and `baseURL.appendingPathComponent("x")` in networking code, Alamofire
  `AF.request`, typed endpoints (`Endpoint(path: "x", method: .post)`) and switch routers
  (`var path: String { switch self { case .listings: return "/listings" } }`);
- Kotlin/Java: Retrofit `@GET("x")`, Ktor `client.get("x")`, OkHttp `Request.Builder().url(...)`;
- Supabase: `.from("table").select()` as `GET /rest/v1/table` (plus the table as an entity and
  the read or write), `.rpc("fn")` and `functions.invoke("fn")`.

Server routes (`side: server`): Next route handlers (`app/**/route.ts` exports), `pages/api/**`,
Express / Fastify / Hono / Koa routes (with the prefix a router is mounted at) and NestJS
controllers. A server route whose handler calls `prisma.<model>.<operation>` reads or writes
that model's entity: the calls inside the handler, in the helpers the file declares outside any
handler, and in the functions it calls from files it imports (one hop). the original Spring and Ktor
server readers are not ported.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass

from orcha_cli.qa.codemap import features as fm
from orcha_cli.qa.codemap.surface import is_noise
from orcha_cli.qa.codemap.code import (
    JS_EXT,
    CodeAccess,
    CodeEndpoint,
    CodeEntity,
    Repo,
    close_of,
    collapse_route,
    endpoint_key,
    entity_key,
    line_at,
    split_args,
    string_arg,
)
from orcha_cli.qa.codemap.code_nav import constants

METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")


def _path(raw: str | None, relative_ok: bool) -> str | None:
    """A URL or path as the endpoint's path, or None when it is not one: a page or asset URL,
    another scheme (`mailto:`), a bare host, or (unless `relative_ok`) a relative name."""
    if not raw:
        return None
    raw = raw.strip()
    if re.match(r"^[a-z][a-z0-9+.-]*:", raw, re.IGNORECASE) and not raw.lower().startswith(("http:", "https:")):
        return None
    if raw.lower().startswith(("http:", "https:")):
        if is_noise(raw.replace("\x00", "x")):
            return None
        rest = raw.split("://", 1)[1]
        raw = rest[rest.find("/"):] if "/" in rest else ""
    elif not raw.startswith("/"):
        if not relative_ok or not re.match(r"^[\w\-.{}:\x00]+(?:/[\w\-.{}:\x00]*)*(?:\?.*)?$", raw):
            return None
        raw = "/" + raw
    pattern = collapse_route(raw)
    if pattern in ("/", "/*") or is_noise(pattern):
        return None
    return pattern


def _call_args(text: str, open_at: int) -> str:
    """The text between the parenthesis at `open_at` and the one that closes it."""
    return text[open_at + 1: close_of(text, open_at)]


# ---------- JS / TS clients ----------

_JS_FETCH = re.compile(r"(?<![\w.$])(fetch|\$fetch|ofetch|useFetch|useSWR|useSWRImmutable|useSWRInfinite|ky)\s*(?:<[^()]*?>)?\s*\(\s*")
_JS_CLIENT_CALL = re.compile(r"(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|head|request)\s*(?:<[^()]*?>)?\s*\(\s*")
_JS_CLIENT_MADE = re.compile(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:axios|ky|wretch|ofetch|got)\s*\.\s*(?:create|extend)\s*\(")
_CLIENT_NAME = re.compile(r"^(?:axios|ky|got|api|http|client|request|instance|backend|\$api|\$http|\w*(?:Api|API|Client|Http|Instance|Service))$")
#: Receivers whose `.get(...)` reads a store or a collection, never the network.
_NOT_CLIENT = re.compile(r"(?i)^(?:redis|cache|storage|store|kv|map|params|searchparams|headers|cookie|session|query|router|form|local|url)")
_JS_METHOD = re.compile(r"\bmethod\s*:\s*[\"'`](\w+)[\"'`]")
_JS_ROUTER_MADE = re.compile(r"\b([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+Hono|express\.Router|express|Router|Fastify|fastify|new\s+Koa|new\s+Router|new\s+OpenAPIHono)\s*(?:<[^()]*>)?\(")
_SERVER_HINT = re.compile(r"""(?:from\s+|require\(\s*)["'](?:express|fastify|hono|koa|@koa/router|koa-router|@hono/[\w-]+|restify|@nestjs/common)["']|express\.Router\(|new\s+Hono\b|\bFastify\(""")


def _js_clients(repo: Repo) -> set[str]:
    made = set()
    for _, text in repo.sources("js"):
        if "create(" in text or "extend(" in text:
            made.update(m.group(1) for m in _JS_CLIENT_MADE.finditer(text))
    return made


def _js_client_calls(repo: Repo, rel: str, text: str, clients: set[str], server_file: bool) -> list[CodeEndpoint]:
    out: list[CodeEndpoint] = []
    consts = constants(repo, "js")

    def add(at: int, method: str, raw: str | None, relative_ok: bool) -> None:
        pattern = _path(raw, relative_ok)
        if pattern:
            out.append(CodeEndpoint(method, pattern, "client", rel, line_at(text, at), None))

    routers = set(_JS_ROUTER_MADE.findall(text)) if server_file else set()
    for m in _JS_FETCH.finditer(text):
        args = _call_args(text, text.rfind("(", 0, m.end()))
        method = _JS_METHOD.search(args)
        verb = "GET" if m.group(1).startswith("useSWR") else (method.group(1).upper() if method else "GET")
        add(m.start(), verb, string_arg(text, m.end(), "js", consts), m.group(1) == "ky")
    for m in _JS_CLIENT_CALL.finditer(text):
        name = m.group(1)
        if (name not in clients and not _CLIENT_NAME.match(name)) or _NOT_CLIENT.search(name) or name in routers:
            continue
        open_at = text.rfind("(", 0, m.end())
        if m.group(2) == "request":
            args = _call_args(text, open_at)
            url = re.search(r"\burl\s*:\s*", args)
            method = _JS_METHOD.search(args)
            if url:
                add(m.start(), method.group(1).upper() if method else "*", string_arg(args, url.end(), "js", consts), True)
            continue
        add(m.start(), m.group(2).upper(), string_arg(text, m.end(), "js", consts), True)
    return out


# ---------- Supabase ----------

_SUPA_FROM = re.compile(r"\.from\s*\(\s*[\"'`]([A-Za-z_]\w*)[\"'`]\s*\)")
_SUPA_OP = re.compile(r"\.(select|insert|upsert|update|delete)\s*\(")
_SUPA_RPC = re.compile(r"\.rpc\s*\(\s*[\"'`]([\w-]+)[\"'`]")
_SUPA_FN = re.compile(r"\bfunctions\s*\.\s*invoke\s*\(\s*[\"'`]([\w-]+)[\"'`]")
_SUPA_METHOD = {"select": "GET", "insert": "POST", "upsert": "POST", "update": "PATCH", "delete": "DELETE"}


def _supabase(rel: str, text: str) -> tuple[list[CodeEndpoint], list[CodeEntity], list[CodeAccess]]:
    endpoints, entities, access = [], [], []
    for m in _SUPA_FROM.finditer(text):
        if text[max(0, m.start() - 40): m.start()].rstrip().endswith(("storage", "Array", "Buffer")):
            continue  # a storage bucket or `Array.from("abc")`, not a table
        window = text[m.end(): m.end() + 300]
        stop = re.search(r";|\.from\s*\(", window)
        op = _SUPA_OP.search(window[: stop.start()] if stop else window)
        verb = op.group(1) if op else "select"
        method, pattern, line = _SUPA_METHOD[verb], f"/rest/v1/{m.group(1)}", line_at(text, m.start())
        endpoints.append(CodeEndpoint(method, pattern, "client", rel, line, None))
        key = entity_key(m.group(1))
        entities.append(CodeEntity(key, m.group(1), "api", (), rel, line))
        access.append(CodeAccess(endpoint_key(method, pattern), key, "reads" if verb == "select" else "writes", rel, line))
    for regex, prefix in ((_SUPA_RPC, "/rest/v1/rpc/"), (_SUPA_FN, "/functions/v1/")):
        for m in regex.finditer(text):
            endpoints.append(CodeEndpoint("POST", prefix + m.group(1), "client", rel, line_at(text, m.start()), None))
    return endpoints, entities, access


# ---------- Swift clients ----------

_SWIFT_NET = re.compile(r"\bURLSession\b|\bURLRequest\b|\bAF\.|\bAlamofire\b|\bhttpMethod\b")
_SWIFT_URL = re.compile(r"\bURL\s*\(\s*string\s*:\s*")
_SWIFT_APPEND = re.compile(r"([\w.]+)\s*\.\s*(?:appendingPathComponent|appending)\s*\(\s*(?:path\s*:\s*|component\s*:\s*)?(?=\")")
_SWIFT_AF = re.compile(r"\b(?:AF|Alamofire|session)\s*\.\s*(?:request|upload|download)\s*\(\s*")
_SWIFT_TYPED = re.compile(r"\b((?:[A-Z]\w*)?(?:Endpoint|Request|Route|API|Api|Resource|Target|Call))\s*\(\s*path\s*:\s*(?=\")")
_SWIFT_METHOD_ARG = re.compile(r"\bmethod\s*:\s*(?:[\w.]*\.)?(\w+)")
_SWIFT_HTTP_METHOD = re.compile(r"\bhttpMethod\s*=\s*\"?(?:[\w.]*\.)?(\w+)\"?")
_SWIFT_INIT_DEFAULT = re.compile(r"\bmethod\s*:\s*[\w.]+\s*=\s*\.(\w+)")
_SWIFT_PATH_VAR = re.compile(r"\bvar\s+path\s*:\s*String\s*\{")
_SWIFT_METHOD_VAR = re.compile(r"\bvar\s+(?:method|httpMethod)\s*:\s*[\w.]+\s*\{")
_SWIFT_CASE_RETURN = re.compile(r"\b(case\s+[^:\n]+|default)\s*:\s*(?:return\s+)?(\"(?:[^\"\\\n]|\\.)*\"|\.?\w+)")
#: `let baseURL = URL(string: "https://api.example.com/v1")!` declares the base, not an endpoint.
_BASE_URL_DECL = re.compile(r"(?i)\b\w*(?:base|root|host|server)\w*\s*(?::\s*URL\??\s*)?=\s*$")
_NOT_API_CONTEXT = re.compile(r"Link\s*\(|openURL|\.open\s*\(|SFSafariViewController|ShareLink|WebView|AsyncImage|Image\s*\(")


def _verb(word: str | None) -> str:
    w = (word or "").upper()
    return w if w in METHODS else "*"


def _swift_case_names(case: str) -> list[str]:
    return re.findall(r"\.(\w+)", case)


def _swift_clients(repo: Repo, rel: str, text: str, typed_defaults: dict[str, str]) -> list[CodeEndpoint]:
    out: list[CodeEndpoint] = []

    def add(at: int, method: str, raw: str | None, relative_ok: bool) -> None:
        pattern = _path(raw, relative_ok)
        if pattern:
            out.append(CodeEndpoint(method, pattern, "client", rel, line_at(text, at), None))

    def method_near(at: int) -> str:
        # The request's method, when the function that builds the URL sets one.
        window = text[at: at + 800]
        nxt = re.search(r"\bfunc\s", window[1:])
        m = _SWIFT_HTTP_METHOD.search(window[: nxt.start() + 1] if nxt else window)
        if m and _verb(m.group(1)) != "*":
            return _verb(m.group(1))
        return "*" if m else "GET"

    networking = bool(_SWIFT_NET.search(text))
    if networking:
        for m in _SWIFT_URL.finditer(text):
            before = text[max(0, m.start() - 120): m.start()]
            if _NOT_API_CONTEXT.search(before) or _BASE_URL_DECL.search(before):
                continue
            raw = string_arg(text, m.end(), "swift")
            if raw and raw.lower().startswith(("http", "/")):
                add(m.start(), method_near(m.start()), raw, False)
        for m in _SWIFT_APPEND.finditer(text):
            receiver = m.group(1).lower()
            if not re.search(r"base|api|server|endpoint|host", receiver) or re.search(r"file|dir|folder|doc|cache|temp|path", receiver):
                continue
            raw = string_arg(text, m.end(), "swift")
            if raw and " " not in raw and not re.search(r"\.\w{2,5}$", raw):
                add(m.start(), method_near(m.start()), raw, True)
    if "path" not in text and "AF." not in text and "request(" not in text:
        return out
    for m in _SWIFT_AF.finditer(text):
        open_at = text.rfind("(", 0, m.end())
        verb = _SWIFT_METHOD_ARG.search(_call_args(text, open_at))
        add(m.start(), _verb(verb.group(1)) if verb else "GET", string_arg(text, m.end(), "swift"), False)
    for m in _SWIFT_TYPED.finditer(text):
        open_at = text.rfind("(", 0, m.end())
        verb = _SWIFT_METHOD_ARG.search(_call_args(text, open_at))
        add(m.start(), _verb(verb.group(1)) if verb else typed_defaults.get(m.group(1), "*"), string_arg(text, m.end(), "swift"), True)
    path_var = _SWIFT_PATH_VAR.search(text)
    if path_var:
        # A switch router: each case's path, with the method its `var method` gives that case.
        brace = text.rfind("{", 0, path_var.end())
        body = text[brace: close_of(text, brace)]
        methods: dict[str, str] = {}
        method_var = _SWIFT_METHOD_VAR.search(text)
        if method_var:
            mbrace = text.rfind("{", 0, method_var.end())
            for c in _SWIFT_CASE_RETURN.finditer(text[mbrace: close_of(text, mbrace)]):
                names = ["default"] if c.group(1) == "default" else _swift_case_names(c.group(1))
                for name in names:
                    methods[name] = _verb(c.group(2).strip("\".").rsplit(".", 1)[-1])
        for c in _SWIFT_CASE_RETURN.finditer(body):
            if not c.group(2).startswith('"'):
                continue
            raw = string_arg(c.group(2), 0, "swift")
            names = _swift_case_names(c.group(1)) or ["default"]
            for name in names:
                add(brace + c.start(), methods.get(name, methods.get("default", "*")), raw, True)
    return out


def _swift_typed_defaults(repo: Repo) -> dict[str, str]:
    """{endpoint type: the method a call gets when it passes none}, from the `method: HTTPMethod
    = .get` default of the init in the file that declares the type."""
    out: dict[str, str] = {}
    for _, text in repo.sources("swift"):
        if "path:" in text and "method:" in text:
            found = {_verb(m.group(1)) for m in _SWIFT_INIT_DEFAULT.finditer(text)}
            if len(found) == 1:
                method = found.pop()
                for name in re.findall(r"\b(?:struct|class)\s+(\w+)", text):
                    out.setdefault(name, method)
    return out


# ---------- Kotlin / Java clients ----------

_RETROFIT = re.compile(r"@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*(?:value\s*=\s*)?\"([^\"]*)\"\s*\)\s*(?:@\w+(?:\([^()]*\))?\s*)*(?:suspend\s+)?(?:fun\s+(\w+)|[\w<>?,\s]+?\s(\w+)\s*\()")
_RETROFIT_HTTP = re.compile(r"@HTTP\s*\(\s*method\s*=\s*\"(\w+)\"\s*,\s*path\s*=\s*\"([^\"]*)\"")
_KTOR_CLIENT = re.compile(r"\b(\w*[cC]lient|http\w*)\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*(?:urlString\s*=\s*)?(?=\")")
_OKHTTP = re.compile(r"\bRequest\s*\.\s*Builder\s*\(\s*\)[\s\S]{0,120}?\.url\s*\(\s*")


def _kotlin_clients(repo: Repo, rel: str, text: str) -> list[CodeEndpoint]:
    out: list[CodeEndpoint] = []
    consts = constants(repo, "kotlin")

    def add(at: int, method: str, raw: str | None, handler: str | None = None) -> None:
        pattern = _path(raw, True)
        if pattern:
            out.append(CodeEndpoint(method, pattern, "client", rel, line_at(text, at), handler))

    for m in _RETROFIT.finditer(text):
        add(m.start(), m.group(1), m.group(2), m.group(3) or m.group(4))
    for m in _RETROFIT_HTTP.finditer(text):
        add(m.start(), _verb(m.group(1)), m.group(2))
    for m in _KTOR_CLIENT.finditer(text):
        add(m.start(), m.group(2).upper(), string_arg(text, m.end(), "kotlin", consts))
    for m in _OKHTTP.finditer(text):
        chain = text[m.end(): m.end() + 300]
        verb = re.search(r"\.(post|put|patch|delete)\s*\(", chain.split("build()")[0])
        raw = string_arg(text, m.end(), "kotlin", consts)
        if raw and raw.startswith(("http", "/")):
            add(m.start(), verb.group(1).upper() if verb else "GET", raw)
    return out


# ---------- server routes ----------


@dataclass
class _Route:
    """A server route and where its handler's code is in its file."""

    endpoint: CodeEndpoint
    start: int
    end: int


_NEXT_EXPORT = re.compile(r"\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|\bexport\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b")
_NEXT_EXPORT_LIST = re.compile(r"\bexport\s*\{([^}]*)\}")
_PAGES_METHOD = re.compile(r"\bmethod\s*(?:===?|!==?)\s*[\"'](\w+)[\"']|\bcase\s+[\"'](GET|POST|PUT|PATCH|DELETE)[\"']")
_ROUTE_FILE = re.compile(r"^route\.(?:ts|js|tsx|jsx|mjs)$")


def _next_routes(rel: str, text: str) -> list[_Route]:
    """Next.js route handlers (`app/**/route.ts`) and API routes (`pages/api/**`)."""
    parts = rel.split("/")
    out: list[_Route] = []
    app = fm._route_root(parts, "app")
    if app is not None and _ROUTE_FILE.match(parts[-1]):
        pattern = collapse_route("/" + "/".join(parts[app + 1: -1]))
        exports = [(m.start(), m.group(1) or m.group(2)) for m in _NEXT_EXPORT.finditer(text)]
        for m in _NEXT_EXPORT_LIST.finditer(text):
            for name in re.findall(r"\bas\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b", m.group(1)):
                exports.append((m.start(), name))
        exports.sort()
        for i, (at, method) in enumerate(exports):
            end = exports[i + 1][0] if i + 1 < len(exports) else len(text)
            out.append(_Route(CodeEndpoint(method, pattern, "server", rel, line_at(text, at), method), at, end))
        return out
    pages = fm._route_root(parts, "pages")
    if pages is not None and len(parts) > pages + 2 and parts[pages + 1] == "api" and parts[-1].endswith(JS_EXT):
        stem = parts[-1].rsplit(".", 1)[0]
        segs = parts[pages + 1: -1] + ([] if stem == "index" else [stem])
        pattern = collapse_route("/" + "/".join(segs))
        methods = sorted({(m.group(1) or m.group(2)).upper() for m in _PAGES_METHOD.finditer(text)} & set(METHODS)) or ["*"]
        default = re.search(r"\bexport\s+default\b", text)
        line = line_at(text, default.start()) if default else 1
        for method in methods:
            out.append(_Route(CodeEndpoint(method, pattern, "server", rel, line, "default"), 0, len(text)))
    return out


_JS_ROUTE = re.compile(r"(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*(?=[\"'`])")
_JS_ROUTE_CHAIN = re.compile(r"\.route\s*\(\s*[\"'`](/[^\"'`]*)[\"'`]\s*\)")
_JS_CHAINED = re.compile(r"\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(")
_FASTIFY_ROUTE = re.compile(r"\.route\s*\(\s*\{")
_JS_MOUNT = re.compile(r"\.(?:use|route)\s*\(\s*[\"'`](/[^\"'`]*)[\"'`]\s*,\s*(?:[\w.]+\s*,\s*)*([A-Za-z_$][\w$]*)\s*(?:\(\s*\))?\s*\)")
_FASTIFY_MOUNT = re.compile(r"\.register\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{[^}]*?\bprefix\s*:\s*[\"'`]([^\"'`]+)[\"'`]")
_JS_IMPORT = re.compile(r"""\bimport\s+([\w*\s{},$]+?)\s+from\s*["']([^"']+)["']|\b(?:const|let|var)\s+(\w+|\{[^}]*\})\s*=\s*require\(\s*["']([^"']+)["']\s*\)""")
_NOT_ROUTER = frozenset({"axios", "ky", "api", "client", "http", "request", "fetch", "map", "cache", "headers", "params", "req", "res", "searchParams", "query", "redis", "store", "storage"})


def _imports(rel: str, text: str, files: set[str]) -> dict[str, str]:
    """{imported name: repo file} for the relative and `@/` / `~/` imports of a JS/TS file."""
    out: dict[str, str] = {}
    for m in _JS_IMPORT.finditer(text):
        names, spec = (m.group(1), m.group(2)) if m.group(2) else (m.group(3), m.group(4))
        target = resolve_import(rel, spec, files)
        if target:
            for name in re.findall(r"[A-Za-z_$][\w$]*", names or ""):
                if name not in ("as", "from", "type"):
                    out[name] = target
    return out


def resolve_import(rel: str, spec: str, files: set[str]) -> str | None:
    """The repo file a JS/TS module specifier names, or None (a package)."""
    if spec.startswith("."):
        bases = [posixpath.normpath(posixpath.join(posixpath.dirname(rel), spec))]
    elif spec.startswith(("@/", "~/")):
        rest = spec[2:]
        parts = rel.split("/")[:-1]
        roots = ["/".join(parts[:i]) for i in range(len(parts), -1, -1) if "/".join(parts[:i] + ["package.json"]).lstrip("/") in files]
        root = roots[0] + "/" if roots and roots[0] else ""
        bases = [root + "src/" + rest, root + rest]
    else:
        return None
    for base in bases:
        for cand in (base, *(base + e for e in JS_EXT), *(base + "/index" + e for e in JS_EXT)):
            if cand in files:
                return cand
    return None


def _js_server_routes(repo: Repo, server_files: dict[str, str]) -> list[_Route]:
    files = set(repo.files)
    mounts: dict[str, list[tuple[str, str]]] = {}
    imports = {rel: _imports(rel, text, files) for rel, text in server_files.items()}
    for rel, text in server_files.items():
        for m in _JS_MOUNT.finditer(text):
            target = imports[rel].get(m.group(2))
            if target:
                mounts.setdefault(target, []).append((rel, m.group(1)))
        for m in _FASTIFY_MOUNT.finditer(text):
            target = imports[rel].get(m.group(1))
            if target:
                mounts.setdefault(target, []).append((rel, m.group(2)))

    def prefixes(rel: str, depth: int = 0) -> list[str]:
        if depth > 3 or rel not in mounts:
            return [""]
        return [outer + p.rstrip("/") for parent, p in mounts[rel] for outer in prefixes(parent, depth + 1)]

    out: list[_Route] = []
    for rel, text in server_files.items():
        found: list[tuple[int, int, int, str, str, str | None]] = []  # at, handler start, end, method, path, handler
        for m in _JS_ROUTE.finditer(text):
            if m.group(1) in _NOT_ROUTER:
                continue
            path = string_arg(text, m.end(), "js")
            if not path or not path.startswith(("/", "*")):
                continue
            open_at = text.rfind("(", 0, m.end())
            close = close_of(text, open_at)
            args = split_args(text[open_at + 1: close])
            handler = args[-1] if len(args) > 1 and re.fullmatch(r"[A-Za-z_$][\w$.]*", args[-1]) else None
            found.append((m.start(), m.start(), close + 1, m.group(2), path, handler))
        for m in _JS_ROUTE_CHAIN.finditer(text):
            i = m.end()
            while True:
                c = _JS_CHAINED.match(text, i)
                if not c:
                    break
                close = close_of(text, c.end() - 1)
                args = text[c.end(): close].strip()
                handler = args if re.fullmatch(r"[A-Za-z_$][\w$.]*", args) else None
                found.append((m.start(), c.start(), close + 1, c.group(1), m.group(1), handler))
                i = close + 1
        for m in _FASTIFY_ROUTE.finditer(text):
            obj = text[m.end() - 1: close_of(text, m.end() - 1)]
            method = re.search(r"\bmethod\s*:\s*[\"'`](\w+)", obj)
            url = re.search(r"\b(?:url|path)\s*:\s*[\"'`](/[^\"'`]*)", obj)
            if method and url:
                found.append((m.start(), m.start(), m.end() + len(obj) + 1, method.group(1), url.group(1), None))
        for at, start, end, method, path, handler in found:
            verb = "*" if method.lower() == "all" else method.upper()
            for prefix in prefixes(rel):
                pattern = collapse_route(prefix + "/" + path.lstrip("/"))
                out.append(_Route(CodeEndpoint(verb, pattern, "server", rel, line_at(text, at), handler), start, end))
    return out


_NEST_CONTROLLER = re.compile(r"@Controller\s*\(\s*(?:[\"'`]([^\"'`]*)[\"'`]|\{[^}]*?\bpath\s*:\s*[\"'`]([^\"'`]*)[\"'`][^}]*\})?\s*\)")
_NEST_ROUTE = re.compile(r"@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:[\"'`]([^\"'`]*)[\"'`])?\s*\)\s*(?:@\w+\s*(?:\([^()]*\))?\s*)*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(")
_NEST_PREFIX = re.compile(r"\bsetGlobalPrefix\s*\(\s*[\"'`]([^\"'`]+)")
def _decorated_routes(rel: str, text: str, global_prefix: str) -> list[_Route]:
    """NestJS controllers (the original Spring reader is not ported)."""
    out: list[_Route] = []
    if rel.endswith(JS_EXT) and "@Controller" in text:
        controllers = [(m.start(), m.group(1) or m.group(2) or "") for m in _NEST_CONTROLLER.finditer(text)]
        routes = list(_NEST_ROUTE.finditer(text))
        for i, m in enumerate(routes):
            prefix = next((p for at, p in reversed(controllers) if at < m.start()), "")
            pattern = collapse_route("/".join(p.strip("/") for p in (global_prefix, prefix, m.group(2) or "") if p.strip("/")))
            end = routes[i + 1].start() if i + 1 < len(routes) else len(text)
            out.append(_Route(CodeEndpoint(_verb(m.group(1)), pattern, "server", rel, line_at(text, m.start()), m.group(3)), m.start(), end))
    return out


def _server_routes(repo: Repo) -> list[_Route]:
    out: list[_Route] = []
    server_files: dict[str, str] = {}
    global_prefix = ""
    for _, text in repo.sources("js"):
        if "setGlobalPrefix" in text:
            m = _NEST_PREFIX.search(text)
            global_prefix = m.group(1) if m else global_prefix
    for rel, text in repo.sources():
        if rel.endswith(JS_EXT):
            out += _next_routes(rel, text)
            out += _decorated_routes(rel, text, global_prefix)
            if _SERVER_HINT.search(text):
                server_files[rel] = text
    # A router file without its own `express` import is still a server file when one mounts it.
    files = set(repo.files)
    for rel, text in list(server_files.items()):
        for name, target in _imports(rel, text, files).items():
            if target not in server_files and re.search(r"\.(?:use|route|register)\s*\([^)]*\b" + re.escape(name) + r"\b", text):
                target_text = repo.text(target)
                if target_text:
                    server_files[target] = target_text
    out += _js_server_routes(repo, server_files)
    return out


# ---------- Prisma reads and writes behind server routes ----------

_PRISMA_OP = re.compile(
    r"\b(?:prisma|db|tx|this\.prisma|ctx\.prisma|ctx\.db)\s*\.\s*([a-z]\w*)\s*\.\s*"
    r"(findMany|findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|count|aggregate|groupBy|"
    r"create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\("
)
_READ_OPS = frozenset({"findMany", "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy"})
_JS_FUNC = re.compile(
    r"^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)"
    r"|^[ \t]*(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::[^=\n]+)?=>"
    r"|^[ \t]+(?:(?:public|private|protected|static|async)\s+)*(\w+)\s*\([^)\n]*\)\s*(?::[^{\n]+)?\{",
    re.MULTILINE,
)


#: A call in a handler (`list(`, `service.list(`) and a handler passed by name (`router.get("/", list)`).
_CALLED = re.compile(r"\b([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(")
_PASSED = re.compile(r"[(,]\s*([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*[,)]")


class _Ops:
    """The Prisma calls of each file, by the function they sit in."""

    def __init__(self, repo: Repo, models: set[str]):
        self.repo = repo
        self.models = models
        self.files = set(repo.files)
        self._cache: dict[str, tuple[list[tuple[int, str, str, int]], dict[str, tuple[int, int]], dict[str, str]]] = {}

    def of(self, rel: str) -> tuple[list[tuple[int, str, str, int]], dict[str, tuple[int, int]], dict[str, str]]:
        """(ops as (offset, entity key, mode, line), {function: (start, end)}, imports)."""
        if rel not in self._cache:
            text = self.repo.text(rel) or ""
            ops = []
            if "prisma" in text or "db." in text or "tx." in text:
                for m in _PRISMA_OP.finditer(text):
                    if self.models and m.group(1) not in self.models:
                        continue
                    mode = "reads" if m.group(2) in _READ_OPS else "writes"
                    ops.append((m.start(), entity_key(m.group(1)), mode, line_at(text, m.start())))
            starts = [(m.start(), m.group(1) or m.group(2) or m.group(3)) for m in _JS_FUNC.finditer(text)]
            funcs = {}
            for i, (at, name) in enumerate(starts):
                if name not in ("if", "for", "while", "switch", "catch", "return"):
                    funcs.setdefault(name, (at, starts[i + 1][0] if i + 1 < len(starts) else len(text)))
            self._cache[rel] = (ops, funcs, _imports(rel, text, self.files) if ops or funcs else {})
        return self._cache[rel]

    def in_span(self, rel: str, start: int, end: int, depth: int = 0, seen: set | None = None) -> list[tuple[str, str, str, int]]:
        """(entity, mode, file, line) of the Prisma calls between `start` and `end` of `rel`, and
        of the functions called there (declared in `rel` or imported into it)."""
        seen = seen if seen is not None else set()
        if (rel, start) in seen:
            return []
        seen.add((rel, start))
        ops, funcs, imports = self.of(rel)
        out = [(e, mode, rel, line) for at, e, mode, line in ops if start <= at < end]
        if depth >= 2:
            return out
        span = (self.repo.text(rel) or "")[start:end]
        calls = {(m.group(1), m.group(2)) for m in _CALLED.finditer(span)}
        calls |= {(m.group(1), m.group(2)) for m in _PASSED.finditer(span)}
        for head, member in calls:
            if member is None and head in funcs and not funcs[head][0] <= start < funcs[head][1]:
                out += self.in_span(rel, *funcs[head], depth + 1, seen)  # a helper in this file
            elif head in imports:
                target = imports[head]
                _, tfuncs, _ = self.of(target)
                name = member or head  # `list(...)`, or `listingService.list(...)`
                if name in tfuncs:
                    out += self.in_span(target, *tfuncs[name], depth + 1, seen)
        return out


def _prisma_access(repo: Repo, routes: list[_Route]) -> list[CodeAccess]:
    from orcha_cli.qa.codemap.code_models import prisma_models

    models = {name[:1].lower() + name[1:] for name in prisma_models(repo)}
    ops = _Ops(repo, models)
    out: list[CodeAccess] = []
    by_file: dict[str, list[_Route]] = {}
    for r in routes:
        if r.endpoint.path.endswith(JS_EXT):
            by_file.setdefault(r.endpoint.path, []).append(r)
    for rel, file_routes in by_file.items():
        file_ops, funcs, _ = ops.of(rel)
        # Calls at the top level of the file, in no handler and no function, serve all its routes.
        loose = [
            (e, mode, rel, line) for at, e, mode, line in file_ops
            if not any(r.start <= at < r.end for r in file_routes) and not any(s <= at < e2 for s, e2 in funcs.values())
        ]
        for r in file_routes:
            key = endpoint_key(r.endpoint.method, r.endpoint.pattern)
            for entity, mode, path, line in ops.in_span(rel, r.start, r.end) + loose:
                out.append(CodeAccess(key, entity, mode, path, line))
    return out


# ---------- the reader ----------


def read(repo: Repo) -> tuple[list[CodeEndpoint], list[CodeEntity], list[CodeAccess]]:
    """(the endpoints the app calls and the JS servers in the repo answer, the entities Supabase
    calls name, the reads and writes behind those endpoints)."""
    endpoints: list[CodeEndpoint] = []
    entities: list[CodeEntity] = []
    access: list[CodeAccess] = []
    clients = _js_clients(repo)
    typed_defaults = _swift_typed_defaults(repo)
    for rel, text in repo.sources():
        if rel.endswith(JS_EXT):
            endpoints += _js_client_calls(repo, rel, text, clients, bool(_SERVER_HINT.search(text)))
        elif rel.endswith(".swift"):
            endpoints += _swift_clients(repo, rel, text, typed_defaults)
        elif rel.endswith((".kt", ".java")):
            endpoints += _kotlin_clients(repo, rel, text)
        if "supabase" in text.lower():
            eps, ents, acc = _supabase(rel, text)
            endpoints += eps
            entities += ents
            access += acc
    routes = _server_routes(repo)
    endpoints += [r.endpoint for r in routes]
    access += _prisma_access(repo, routes)
    return endpoints, entities, access
