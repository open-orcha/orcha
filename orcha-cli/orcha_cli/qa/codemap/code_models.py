"""Data models from code (adapted from `app_map/code_models.py`, native stores), and the
reads and writes screens make on an on-device store:

- SwiftData `@Model class X { var a: T }` (stored properties, not computed ones);
- Core Data `*.xcdatamodeld/*.xcdatamodel/contents` (`<entity>` attributes and relationships);
- Room `@Entity data class X(val a: T)` (and a Java entity's fields), keyed by `tableName`;
- Prisma `model X { ... }` (scalar and enum fields; relations are not fields);
- Firestore collections (`collection(db, "x")`, `db.collection("x")`) as `api` entities, and the
  columns SQL migrations give a Supabase table.

Access, with a screen key as the source (`Repo.screens_of`, so a view model or repository the
screen uses counts as its code): SwiftData `@Query var x: [T]` and `FetchDescriptor<T>`, Core
Data fetch requests, `modelContext.insert(T(...))` / `.delete(x)` and `T(context:)`; Room DAO
methods called from the screen's code (`@Query` SELECT reads, `@Insert` / `@Update` / `@Delete`
/ `@Upsert` and modifying queries write); Firestore reads and writes. Server-side reads and writes
(Prisma) are in `code_api`, keyed by endpoint.
"""

from __future__ import annotations

import dataclasses
import re

from orcha_cli.qa.codemap.code import MAX_SHARED_DATA, CodeAccess, CodeEntity, Repo, close_of, entity_key, line_at, split_args

# ---------- Prisma ----------

_PRISMA_BLOCK = re.compile(r"^[ \t]*(model|enum|type|view)\s+(\w+)\s*\{", re.MULTILINE)
_PRISMA_FIELD = re.compile(r"^\s*(\w+)\s+(\w+)(\[\])?\??", re.MULTILINE)
PRISMA_SCALARS = frozenset({"String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes", "Unsupported"})


def prisma_models(repo: Repo) -> dict[str, CodeEntity]:
    """{model name: entity} for every `model` in the repo's `.prisma` files."""
    if "prisma" in repo.cache:
        return repo.cache["prisma"]
    blocks = []
    enums: set[str] = set()
    for rel, text in repo.sources():
        if not rel.endswith(".prisma"):
            continue
        for m in _PRISMA_BLOCK.finditer(text):
            brace = m.end() - 1
            blocks.append((rel, text, m, text[brace + 1: close_of(text, brace)]))
            if m.group(1) in ("enum", "type"):
                enums.add(m.group(2))
    out: dict[str, CodeEntity] = {}
    for rel, text, m, body in blocks:
        if m.group(1) not in ("model", "view"):
            continue
        fields = []
        for f in _PRISMA_FIELD.finditer(body):
            if f.group(1).startswith("@@") or f.group(2) not in PRISMA_SCALARS and f.group(2) not in enums:
                continue
            fields.append(f.group(1))
        out[m.group(2)] = CodeEntity(entity_key(m.group(2)), m.group(2), "prisma", tuple(fields), rel, line_at(text, m.start()))
    repo.cache["prisma"] = out
    return out


# ---------- SwiftData and Core Data ----------

_SWIFTDATA = re.compile(r"@Model\s+(?:(?:public|final|open|internal)\s+)*class\s+(\w+)")
_SWIFT_STORED = re.compile(r"^\s*(?:@\w+(?:\([^()]*\))?\s*)*(?:(?:public|private|internal|fileprivate|open|private\(set\)|public\(set\))\s+)*(?:var|let)\s+(\w+)\s*(:[^={\n]*)?(=|\{)?")
_COREDATA_ENTITY = re.compile(r"<entity\b[^>]*?\bname=\"(\w+)\"[^>]*>(.*?)</entity>", re.DOTALL)
_COREDATA_FIELD = re.compile(r"<(?:attribute|relationship)\b[^>]*?\bname=\"(\w+)\"")


def _swiftdata(rel: str, text: str) -> list[CodeEntity]:
    out = []
    for m in _SWIFTDATA.finditer(text):
        brace = text.find("{", m.end())
        if brace < 0:
            continue
        body = text[brace + 1: close_of(text, brace)]
        fields, depth = [], 0
        for line in body.split("\n"):
            if depth == 0 and "static " not in line:
                f = _SWIFT_STORED.match(line)
                if f and f.group(3) != "{":  # `var total: Int { ... }` is computed
                    fields.append(f.group(1))
            depth += line.count("{") - line.count("}")
        out.append(CodeEntity(entity_key(m.group(1)), m.group(1), "swiftdata", tuple(fields), rel, line_at(text, m.start())))
    return out


def _coredata(rel: str, text: str) -> list[CodeEntity]:
    return [
        CodeEntity(entity_key(m.group(1)), m.group(1), "coredata", tuple(_COREDATA_FIELD.findall(m.group(2))), rel, line_at(text, m.start()))
        for m in _COREDATA_ENTITY.finditer(text)
    ]


_SD_QUERY = re.compile(r"@Query\b(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*(?:(?:private|fileprivate|public|internal)\s+)?var\s+\w+\s*:\s*\[(\w+)\]")
_SWIFT_FETCH = re.compile(r"\bFetchDescriptor\s*<\s*(\w+)\s*>|\bFetchedResults\s*<\s*(\w+)\s*>|\bNSFetchRequest\s*<\s*(\w+)\s*>|@FetchRequest\s*\([^)]*?entity\s*:\s*(\w+)\.entity\(\)")
_SWIFT_CHANGE = re.compile(r"\b\w*[cC]ontext\s*\.\s*(insert|delete)\s*\(")
_COREDATA_NEW = re.compile(r"\b([A-Z]\w*)\s*\(\s*context\s*:")


def _swift_access(repo: Repo, rel: str, text: str, models: dict[str, str]) -> list[CodeAccess]:
    if not any(k in text for k in ("@Query", "Fetch", "ontext")):  # `context`, `modelContext`
        return []
    screens = repo.screens_of(rel, limit=MAX_SHARED_DATA)
    if not screens:
        return []
    found: list[tuple[str, str, int]] = []  # (model, mode, offset)
    for m in _SD_QUERY.finditer(text):
        found.append((m.group(1), "reads", m.start()))
    for m in _SWIFT_FETCH.finditer(text):
        found.append((next(g for g in m.groups() if g), "reads", m.start()))
    for m in _COREDATA_NEW.finditer(text):
        found.append((m.group(1), "writes", m.start()))
    used = {name for name, _, _ in found if name in models}
    for m in _SWIFT_CHANGE.finditer(text):
        open_at = m.end() - 1
        args = text[open_at + 1: close_of(text, open_at)]
        model = next((c for c in re.findall(r"\b([A-Z]\w*)\s*\(", args) if c in models), None)
        if model is None:
            # `modelContext.delete(listing)`: the model the variable is named after, else the
            # one model the file already uses.
            words = args.lower()
            model = next((n for n in sorted(models, key=len, reverse=True) if n.lower() in words), None)
            if model is None and len(used) == 1:
                model = next(iter(used))
        if model:
            found.append((model, "writes", m.start()))
    out = []
    for name, mode, at in found:
        if name in models:
            for screen in screens:
                out.append(CodeAccess(screen, models[name], mode, rel, line_at(text, at)))
    return out


# ---------- Room ----------

_ROOM_ENTITY = re.compile(r"@Entity\b")
_ROOM_CLASS = re.compile(r"\s*(?:@\w+(?:\([^()]*\))?\s*)*(?:(?:public|internal|data|open|final|abstract)\s+)*class\s+(\w+)\s*(?:<[^>]*>)?\s*([({])")
_KOTLIN_PARAM = re.compile(r"\b(?:val|var)\s+(\w+)\s*:")
_JAVA_FIELD = re.compile(r"^\s*(?:@\w+(?:\([^()]*\))?\s*)*(?:public|private|protected)\s+(?:final\s+)?[\w<>\[\],. ]+?\s+(\w+)\s*[;=]", re.MULTILINE)
_DAO = re.compile(r"@Dao\b\s*(?:(?:public|abstract|internal)\s+)*(?:interface|abstract\s+class|class)\s+(\w+)")
_DAO_ANNOTATION = re.compile(r"@(Query|Insert|Update|Delete|Upsert)\b")
_DAO_FUN = re.compile(r"\s*(?:@\w+(?:\([^()]*\))?\s*)*(?:(?:suspend|abstract|public|open)\s+)*(?:fun\s+(\w+)|[\w<>?\[\],. ]+?\s(\w+))\s*\(")
_SQL_TABLE = re.compile(r"(?i)\b(?:from|into|update|join)\s+[`\"\[]?(\w+)")
_PARAM_TYPE = re.compile(r":\s*(?:List|Array|Collection|Set|MutableList)?<?\s*(\w+)|(?:List|Collection|Set)?<?(\w+)>?\s+\w+\s*(?:,|$)")


def _room(rel: str, text: str) -> tuple[list[CodeEntity], dict[str, str]]:
    """Room entities, and {class name or table name: entity key}."""
    out, names = [], {}
    for m in _ROOM_ENTITY.finditer(text):
        i = m.end()
        args = ""
        if text[i:].lstrip().startswith("("):
            open_at = text.index("(", i)
            close = close_of(text, open_at)
            args, i = text[open_at + 1: close], close + 1
        c = _ROOM_CLASS.match(text, i)
        if not c:
            continue
        table = re.search(r"\btableName\s*=\s*\"(\w+)\"", args)
        key = entity_key(table.group(1) if table else c.group(1))
        bracket = c.end() - 1
        body = text[bracket + 1: close_of(text, bracket)]
        fields = _KOTLIN_PARAM.findall(body) if c.group(2) == "(" else _JAVA_FIELD.findall(body)
        out.append(CodeEntity(key, c.group(1), "room", tuple(fields), rel, line_at(text, m.start())))
        names[c.group(1)] = key
        if table:
            names[table.group(1)] = key
    return out, names


def _daos(rel: str, text: str, names: dict[str, str]) -> list[tuple[str, dict[str, tuple[str, str]]]]:
    """[(DAO name, {method: (entity key, mode)})]."""
    out = []
    for d in _DAO.finditer(text):
        brace = text.find("{", d.end())
        if brace < 0:
            continue
        end = close_of(text, brace)
        methods: dict[str, tuple[str, str]] = {}
        for a in _DAO_ANNOTATION.finditer(text, brace, end):
            i, args = a.end(), ""
            if text.startswith("(", i):
                close = close_of(text, i)
                args, i = text[i + 1: close], close + 1
            f = _DAO_FUN.match(text, i)
            if not f:
                continue
            name = f.group(1) or f.group(2)
            if a.group(1) == "Query":
                sql = " ".join(re.findall(r"\"((?:[^\"\\]|\\.)*)\"", args))
                table = _SQL_TABLE.search(sql)
                if not table:
                    continue
                mode = "reads" if re.match(r"(?i)\s*(?:select|with)\b", sql) else "writes"
                methods[name] = (names.get(table.group(1), entity_key(table.group(1))), mode)
            else:
                params = text[f.end(): close_of(text, f.end() - 1)]
                t = _PARAM_TYPE.search(params)
                cls = (t.group(1) or t.group(2)) if t else None
                if cls:
                    methods[name] = (names.get(cls, entity_key(cls)), "writes")
        out.append((d.group(1), methods))
    return out


def _room_access(repo: Repo, rel: str, text: str, daos: list[tuple[str, dict[str, tuple[str, str]]]]) -> list[CodeAccess]:
    screens = repo.screens_of(rel, limit=MAX_SHARED_DATA)
    if not screens:
        return []
    out = []
    for dao, methods in daos:
        if dao not in text and (dao[:1].lower() + dao[1:]) not in text:
            continue
        for method, (entity, mode) in methods.items():
            call = re.search(r"\.\s*" + re.escape(method) + r"\s*\(", text)
            if call:
                for screen in screens:
                    out.append(CodeAccess(screen, entity, mode, rel, line_at(text, call.start())))
    return out


# ---------- Firestore ----------

_FIRESTORE = re.compile(r"\bcollection\s*\(\s*\w+\s*,\s*[\"'`](\w+)[\"'`]|\.collection\s*\(\s*[\"'`](\w+)[\"'`]\s*\)")
_FIRESTORE_WRITE = re.compile(r"\b(?:addDoc|setDoc|updateDoc|deleteDoc|setData|addDocument|updateData)\b|\.(?:add|set|update|delete)\s*\(")


def _firestore(repo: Repo, rel: str, text: str) -> tuple[list[CodeEntity], list[CodeAccess]]:
    entities, access = [], []
    screens = repo.screens_of(rel, limit=MAX_SHARED_DATA)
    for m in _FIRESTORE.finditer(text):
        name = m.group(1) or m.group(2)
        key, line = entity_key(name), line_at(text, m.start())
        entities.append(CodeEntity(key, name, "api", (), rel, line))
        # The function the reference is passed to (`addDoc(collection(db, "x"), ...)`), else
        # the call chained on it (`db.collection("x").add(...)`).
        wrapper = re.search(r"\b(\w+)\s*\(\s*$", text[max(0, m.start() - 40): m.start()])
        chain = re.split(r"[;\n]", text[m.end(): m.end() + 200], maxsplit=1)[0]
        mode = "writes" if _FIRESTORE_WRITE.search(wrapper.group(1) + "(" if wrapper else chain) else "reads"
        for screen in screens:
            access.append(CodeAccess(screen, key, mode, rel, line))
    return entities, access


# ---------- SQL migrations (the columns of a Supabase table) ----------

_SQL_CREATE = re.compile(r"(?i)\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:\"?\w+\"?\.)?\"?(\w+)\"?\s*\(")
_SQL_ADD_COLUMN = re.compile(r"(?i)\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:\"?\w+\"?\.)?\"?(\w+)\"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?\"?(\w+)")
_SQL_NOT_COLUMN = frozenset({"constraint", "primary", "unique", "foreign", "check", "exclude", "like"})


def sql_tables(repo: Repo) -> dict[str, list[str]]:
    """{entity key: columns} from the `create table` / `add column` statements of the repo's SQL
    migrations, oldest first."""
    out: dict[str, list[str]] = {}
    for rel in sorted(r for r in repo.files if r.endswith(".sql") and "migrations/" in r):
        text = re.sub(r"--[^\n]*", "", repo.text(rel) or "")
        for m in _SQL_CREATE.finditer(text):
            paren = m.end() - 1
            columns = []
            for part in split_args(text[paren + 1: close_of(text, paren)]):
                word = re.match(r"\"?(\w+)", part)
                if word and word.group(1).lower() not in _SQL_NOT_COLUMN:
                    columns.append(word.group(1))
            out[entity_key(m.group(1))] = columns
        for m in _SQL_ADD_COLUMN.finditer(text):
            cols = out.setdefault(entity_key(m.group(1)), [])
            if m.group(2) not in cols:
                cols.append(m.group(2))
    return out


def with_table_columns(repo: Repo, entities: list[CodeEntity]) -> list[CodeEntity]:
    """`api` entities (a Supabase table) with the columns their migrations declare."""
    if not any(e.store == "api" and not e.fields for e in entities):
        return entities
    tables = sql_tables(repo)
    return [dataclasses.replace(e, fields=tuple(tables[e.key])) if e.store == "api" and not e.fields and tables.get(e.key) else e for e in entities]


# ---------- the reader ----------


def read(repo: Repo) -> tuple[list[CodeEntity], list[CodeAccess]]:
    """(the entities the repo declares, the reads and writes its screens make on-device)."""
    entities: list[CodeEntity] = list(prisma_models(repo).values())
    room_names: dict[str, str] = {}
    room_texts: list[tuple[str, str]] = []
    swift_texts: list[tuple[str, str]] = []
    access: list[CodeAccess] = []
    for rel, text in repo.sources():
        if rel.endswith("/contents"):
            entities += _coredata(rel, text)
        elif rel.endswith(".swift"):
            if "@Model" in text:
                entities += _swiftdata(rel, text)
            swift_texts.append((rel, text))
        elif rel.endswith((".kt", ".java")):
            if "@Entity" in text:
                found, names = _room(rel, text)
                entities += found
                room_names.update(names)
            room_texts.append((rel, text))
        low = text.lower()
        if "collection" in text and ("firestore" in low or "firebase" in low):
            found, acc = _firestore(repo, rel, text)
            entities += found
            access += acc
    models = {e.name: e.key for e in entities if e.store in ("swiftdata", "coredata")}
    if models:
        for rel, text in swift_texts:
            access += _swift_access(repo, rel, text, models)
    daos = [d for rel, text in room_texts if "@Dao" in text for d in _daos(rel, text, room_names)]
    if daos:
        for rel, text in room_texts:
            access += _room_access(repo, rel, text, daos)
    return entities, access
