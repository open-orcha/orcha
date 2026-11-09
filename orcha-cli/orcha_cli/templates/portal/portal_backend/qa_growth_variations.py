"""More data for the tests a team already has (#413, "Suggest data variations").

For a scenario with an Examples table or Data values (an existing, migrated or Orcha one),
Orcha proposes rows by test-design technique, one for each partition the table does not try
yet (`depth.TECHNIQUES`):

- `empty`    the first input column left blank;
- `invalid`  a value the app should refuse: an email without an @, words in an amount, a date
             that does not exist, digits too few for a phone;
- `boundary` the smallest and largest number a numeric column takes, or the longest text;
- `locale`   a value from the project's place (`qa_test_data_rules.infer_locale`): a name
             with its accents, a phone in its format, its currency, its city;

each with an expectation for an `expect` column when the table has one, so the row says what
should happen. Values start from the table's own first row, so the rest of the row stays
realistic, and are realistic for the place (names, phones and money from the locale). A secret
column is never touched (its sealed reference is kept as it is).

A suggestion is a row of `qa_data_variations` (`suggested`). Nothing reaches the scenario until a
person approves it: `plan_apply` returns the table with the rows added, the site saves it through
the scenario PATCH route (`patchScenario`, versioned like any edit) and only then are the rows
`applied`. An agent can write its own realistic rows (`rows`), stored as suggestions the same way.
No model is called here.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from typing import Any

from portal_backend import qa_examples as examples_mod
from portal_backend import qa_scenarios, qa_store as qs
from portal_backend import qa_test_data_rules as TD
from portal_backend import qa_growth_depth as depth_mod

TABLE = "qa_data_variations"
#: Most suggestions kept per scenario.
MAX_SUGGESTIONS = 8
#: Scenarios listed as worth more data.
MAX_CANDIDATES = 12
LABEL_MAX = 120
EXPECT_COLUMN = re.compile(r"^(expect(ed)?|result|outcome|then|should)$", re.I)
EXPECTS = {
    "empty": "Says the field is required and keeps what was typed",
    "invalid": "Explains what is wrong and saves nothing",
    "boundary": "Accepts it, or names the limit plainly",
    "locale": "Saves it and shows it exactly as typed",
    "partition": "Saves it",
}
#: A real name per place, with its accents where the language has them.
NAMES = {
    "PT": "João Gonçalves", "BR": "Conceição Araújo", "DE": "Jürgen Müller", "FR": "Hélène Dubois", "ES": "Begoña Núñez",
    "IT": "Niccolò Lucà", "NL": "Daniëlle de Vries", "KE": "Wanjirũ Kamau", "TZ": "Neema Mwakyusa", "UG": "Nakato Ssekandi",
    "RW": "Uwase Mukamana", "ET": "Selam Tesfaye", "NG": "Chiamaka Okonkwo", "ZA": "Thandiwe Nkosi", "EG": "Nour El-Sayed",
    "AE": "Mariam Al Hashimi", "GB": "Siobhán O'Connor", "US": "José Ramírez", "IN": "Aarav Sharma",
}
#: Money as it is written there (the comma decimal where the place uses one).
MONEY = {"PT": "1.250,50 €", "DE": "1.250,50 €", "FR": "1 250,50 €", "ES": "1.250,50 €", "IT": "1.250,50 €", "NL": "€ 1.250,50",
         "BR": "R$ 1.250,50", "KE": "KSh 12,500", "TZ": "TSh 25,000", "UG": "USh 45,000", "NG": "₦ 15,000", "GB": "£1,250.50",
         "IN": "₹1,250.50", "ZA": "R 1 250,50", "EG": "E£ 1,250", "AE": "AED 1,250", "RW": "RWF 12,000", "ET": "Br 1,250"}
LONG_NAME = "Maria da Conceição Albuquerque de Vasconcelos Figueiredo Sant'Anna Bettencourt Gouveia e Castro Lencastre"

_NAME_COL = re.compile(r"(name|title|label|customer|owner|driver|city|street|address|notes?|comment|description|message)", re.I)


class VariationError(ValueError):
    """A suggestion that cannot be made or applied; str(e) says why, in the person's words."""


def _loads(value: Any, default: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return default
    return default if value is None else value


def _human(col: str) -> str:
    return re.sub(r"[_\-.]+", " ", col).strip().capitalize() or col


def base_table(scenario: dict[str, Any]) -> dict[str, Any] | None:
    """The scenario's Examples table, or one made from its plain Data values (each a column,
    their values the first row: a row value wins over the Data key of the same name). None when
    it has neither: there is no input to vary."""
    table = _loads(scenario.get("examples"), None)
    if isinstance(table, dict) and table.get("columns") and table.get("rows"):
        return {"columns": [str(c) for c in table["columns"]], "rows": [list(r) for r in table["rows"]],
                **({"secret": list(table["secret"])} if table.get("secret") else {})}
    data = _loads(scenario.get("data"), {})
    if isinstance(data, dict):
        cols = [k for k, v in data.items() if isinstance(v, (str, int, float)) and examples_mod.COLUMN_RE.match(str(k))
                and k not in examples_mod.RESERVED and not examples_mod.is_secret_column(str(k))][:examples_mod.MAX_COLUMNS]
        if cols:
            return {"columns": cols, "rows": [[str(data[c]) for c in cols]]}
    return None


def _inputs(table: dict[str, Any]) -> list[str]:
    secret = {c.lower() for c in examples_mod.secret_columns(table)}
    return [c for c in table["columns"] if not EXPECT_COLUMN.match(c) and c.lower() not in secret and not examples_mod.is_secret_column(c)]


def _first(cols: list[str], rx: re.Pattern[str]) -> str | None:
    return next((c for c in cols if rx.search(c)), None)


def _row(table: dict[str, Any], change: dict[str, str], technique: str) -> dict[str, str]:
    first = table["rows"][0]
    values = {c: str(first[i]) if i < len(first) else "" for i, c in enumerate(table["columns"])}
    values.update(change)
    for c in table["columns"]:
        if EXPECT_COLUMN.match(c):
            values[c] = EXPECTS[technique]
    return values


def suggest_rows(scenario: dict[str, Any], locale: Any = None) -> list[dict[str, Any]]:
    """`[{technique, label, values}]`: one row (two for a numeric boundary) per partition the
    table does not try yet. Pure."""
    table = base_table(scenario)
    if table is None:
        return []
    cols = _inputs(table)
    if not cols:
        return []
    have = set(depth_mod.depth({"examples": table})["kinds"])
    num = _first(cols, depth_mod._NUMERIC_COL)
    email = _first(cols, depth_mod._EMAIL_COL)
    date = _first(cols, depth_mod._DATE_COL)
    phone = _first(cols, depth_mod._PHONE_COL)
    name = _first(cols, _NAME_COL) or next((c for c in cols if c not in (num, email, date, phone)), None)
    code = getattr(locale, "code", None) or "US"
    out: list[dict[str, Any]] = []

    def add(technique: str, label: str, change: dict[str, str]) -> None:
        values = _row(table, change, technique)
        if depth_mod.row_technique({k: v for k, v in values.items() if not EXPECT_COLUMN.match(k)}) == technique:
            out.append({"technique": technique, "label": label[:LABEL_MAX], "values": values})

    if "empty" not in have:
        col = name or cols[0]
        add("empty", f"{_human(col)} left empty", {col: ""})
    if "invalid" not in have:
        if email:
            first = str(_row(table, {}, "invalid").get(email) or "amina.wanjiru@gmail.com")
            add("invalid", f"{_human(email)} without an @", {email: first.replace("@", ".", 1) if "@" in first else first + ".gmail.com"})
        elif num:
            add("invalid", f"Words where {_human(num).lower()} goes", {num: "twelve"})
        elif date:
            add("invalid", f"{_human(date)} that does not exist", {date: "2026-02-30"})
        elif phone:
            add("invalid", f"{_human(phone)} too short", {phone: "12"})
        elif name:
            # Around a value a person types: a generator base (`one of Zawadi | Amani`) gives one
            # of its values, never its syntax inside the markup (#478).
            base = str(_row(table, {}, "invalid").get(name) or "")
            if draws(base):
                base = generate_value(name, base, "markup")
            add("invalid", f"Markup typed into {_human(name).lower()}", {name: "<b>" + (base or "Amina") + "</b>"})
    if "boundary" not in have:
        if num:
            add("boundary", f"Smallest {_human(num).lower()}", {num: "0" if not re.search(r"guests|people|seats|qty|quantity", num, re.I) else "1"})
            add("boundary", f"Largest {_human(num).lower()}", {num: "1000000"})
        elif name:
            add("boundary", f"Longest {_human(name).lower()} a person might type", {name: LONG_NAME})
    if "locale" not in have:
        if phone and getattr(locale, "phone_example", None) and code != "US":
            add("locale", f"{_human(phone)} in the {getattr(locale, 'country', code)} format", {phone: locale.phone_example})
        elif num and re.search(r"amount|price|total|cost|fee|rent", num, re.I):
            if code in MONEY and code != "US":
                add("locale", f"{_human(num)} written the way {getattr(locale, 'country', code)} writes money", {num: MONEY[code]})
            else:
                add("locale", f"{_human(num)} written the European way", {num: "1.250,50 €"})
        elif name:
            local = NAMES.get(code, "")
            add("locale", f"{_human(name)} with accents", {name: local if any(ord(c) > 127 for c in local) else NAMES["US"]})
    return out[:MAX_SUGGESTIONS]


# ---------- the database ----------


_ONE_OF = re.compile(r"^\s*one\s+of\s+(.+)$", re.I)
_PATTERN_GEN = re.compile(r"^\s*pattern\s+(.+)$", re.I)


def draws(value: str) -> bool:
    """Whether `value` is, as a whole, a generator with something to draw: `one of` with two or
    more options, or a `pattern` with a `[...]` class, `\\d` or a `{n,m}` range in it."""
    v = str(value or "")
    if m := _ONE_OF.match(v):
        return len([x for x in m.group(1).split("|") if x.strip()]) >= 2
    if m := _PATTERN_GEN.match(v):
        return bool(re.search(r"\[[^\]]+\]|\\d|\{\d+(,\d+)?\}", m.group(1)))
    return False


def generate_value(key: str, value: str, tag: str) -> str:
    """One value of a Data generator (`one of ...`, `pattern ...`); anything else comes back."""
    v = str(value or "")
    if m := _ONE_OF.match(v):
        return random.choice([x.strip() for x in m.group(1).split("|") if x.strip()])
    if m := _PATTERN_GEN.match(v):
        def cls(c: re.Match) -> str:
            body = re.sub(r"(.)-(.)", lambda r: "".join(chr(x) for x in range(ord(r[1]), ord(r[2]) + 1)), c.group(1))
            return random.choice(body)
        out = re.sub(r"\[([^\]]+)\]\{(\d+)\}", lambda c: "".join(cls(c) for _ in range(int(c.group(2)))), m.group(1))
        out = re.sub(r"\[([^\]]+)\]", cls, out)
        return re.sub(r"\\d", lambda _: random.choice("0123456789"), out)
    return v


# ---------------------------------------------------------------- stored rows


def _scenario(cur: Any, cid: str, ref: str) -> dict[str, Any]:
    qs.require_uuid(ref, "scenario")
    r = qs.load_scenario(cur, ref)
    if str(r["container_id"]) != cid:
        raise VariationError("That scenario belongs to another project.")
    return dict(r)


def project_locale(cur: Any, cid: str) -> Any:
    """The place the project's data is for, from its scenarios' own words."""
    cur.execute("SELECT description, criteria, examples FROM qa_scenarios WHERE container_id=%s LIMIT 200", (cid,))
    return TD.infer_locale([" ".join(str(r.get(k) or "") for k in ("description", "criteria", "examples")) for r in cur.fetchall()])[0]


def _json(row: dict[str, Any]) -> dict[str, Any]:
    pub = qs.public(row)
    return {"id": pub["id"], "scenario_id": pub["scenario_id"], "technique": pub["technique"], "label": pub["label"],
            "values": pub.get("row_values") or {}, "status": pub["status"], "created_at": pub.get("created_at"),
            "decided_at": pub.get("decided_at")}


def _clean_given(rows: Any, table: dict[str, Any]) -> list[dict[str, Any]]:
    """Rows an agent wrote: a technique, a label and values for the table's columns; never a secret."""
    if not isinstance(rows, list) or not rows:
        raise VariationError("rows: a list of {technique, label, values}.")
    out = []
    for r in rows[:MAX_SUGGESTIONS]:
        if not isinstance(r, dict) or r.get("technique") not in depth_mod.TECHNIQUES or not isinstance(r.get("values"), dict):
            raise VariationError(f"each row needs a technique ({', '.join(depth_mod.TECHNIQUES)}), a label and values.")
        unknown = [k for k in r["values"] if k not in table["columns"]]
        if unknown:
            raise VariationError(f"{', '.join(map(str, unknown))}: not a column of this table ({', '.join(table['columns'])}).")
        if any(examples_mod.is_secret_column(str(k)) or examples_mod.looks_secret(v) for k, v in r["values"].items() if str(v)):
            raise VariationError("a suggestion never carries a password, key or token: leave secret columns out.")
        values = _row(table, {str(k): str(v) for k, v in r["values"].items()}, r["technique"])
        out.append({"technique": r["technique"], "label": str(r.get("label") or depth_mod.TECHNIQUE_LABEL[r["technique"]])[:LABEL_MAX], "values": values})
    return out


def _key(values: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(values, sort_keys=True, default=str).encode()).hexdigest()[:32]


def suggest(cur: Any, cid: str, scenario_ref: str, rows: Any = None) -> dict[str, Any]:
    """Store suggestions for one scenario (replacing the ones still waiting), from the techniques
    (`suggest_rows`) or rows an agent wrote. Returns `{scenario, suggestions}`."""
    s = _scenario(cur, cid, scenario_ref)
    if qa_scenarios.effective(s) == "retired":
        raise VariationError(f"‘{s['name']}’ is retired: it never runs, so more data would not count.")
    table = base_table(s)
    if table is None:
        raise VariationError(f"‘{s['name']}’ has no Examples table or Data values to vary yet. Add one row first, then Orcha suggests the rest.")
    made = _clean_given(rows, table) if rows is not None else suggest_rows(s, project_locale(cur, cid))
    if not made:
        raise VariationError(f"‘{s['name']}’ already tries every partition Orcha knows (empty, invalid, boundary, locale).")
    sid = str(s["id"])
    cur.execute(f"DELETE FROM {TABLE} WHERE scenario_id=%s AND status='suggested'", (sid,))
    for r in made:
        cur.execute(f"SELECT 1 AS one FROM {TABLE} WHERE scenario_id=%s AND row_key=%s", (sid, _key(r["values"])))
        if cur.fetchone():
            continue
        cur.execute(f"""INSERT INTO {TABLE} (id, container_id, scenario_id, technique, label, row_values, row_key, status, created_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,'suggested',%s)""",
                    (qs.new_id(), cid, sid, r["technique"], r["label"], json.dumps(r["values"]), _key(r["values"]), qs.now()))
    return {"scenario": {"id": sid, "name": s["name"]}, "suggestions": pending(cur, cid, sid)}


def pending(cur: Any, cid: str, scenario_id: str | None = None) -> list[dict[str, Any]]:
    q, args = f"SELECT * FROM {TABLE} WHERE container_id=%s AND status='suggested'", [cid]
    if scenario_id:
        q += " AND scenario_id=%s"
        args.append(scenario_id)
    cur.execute(q + " ORDER BY created_at", tuple(args))
    return [_json(r) for r in cur.fetchall()]


def _picked(cur: Any, cid: str, ids: list[str]) -> list[dict[str, Any]]:
    """The waiting rows named by `ids`: one scenario's, all still suggestions."""
    rows = [r for r in pending(cur, cid) if r["id"] in set(ids)]
    if not rows or len(rows) != len(set(ids)):
        raise VariationError("Those rows are no longer waiting: read the page again.")
    if len({r["scenario_id"] for r in rows}) != 1:
        raise VariationError("Approve one scenario's rows at a time.")
    return rows


def plan_apply(cur: Any, cid: str, ids: list[str]) -> dict[str, Any]:
    """The scenario's table with the approved rows added, and the ids to mark applied once it is
    saved. Nothing is written here."""
    rows = _picked(cur, cid, ids)
    s = _scenario(cur, cid, rows[0]["scenario_id"])
    table = base_table(s)
    if table is None:
        raise VariationError(f"‘{s['name']}’ no longer has data to vary.")
    cols = list(table["columns"])
    new_rows = [list(r) + [""] * (len(cols) - len(r)) for r in table["rows"]]
    for r in rows:
        new_rows.append([str(r["values"].get(c, "")) for c in cols])
    if len(new_rows) > examples_mod.MAX_ROWS:
        raise VariationError(f"The table would have more than {examples_mod.MAX_ROWS} rows.")
    out = {"columns": cols, "rows": new_rows, **({"secret": table["secret"]} if table.get("secret") else {})}
    try:
        examples_mod.validate(out)
    except examples_mod.ExamplesError as e:
        raise VariationError(str(e)) from e
    return {"scenario_id": str(s["id"]), "scenario_name": s["name"], "examples": out, "ids": [r["id"] for r in rows], "added": len(rows)}


def decide(cur: Any, cid: str, ids: list[str], status: str) -> int:
    """Mark suggested rows `applied` (after the scenario was saved) or `dismissed`."""
    if status not in ("applied", "dismissed"):
        raise VariationError(f"unknown status {status!r}")
    rows = _picked(cur, cid, ids)
    for r in rows:
        cur.execute(f"UPDATE {TABLE} SET status=%s, decided_at=%s WHERE id=%s", (status, qs.now(), r["id"]))
    return len(rows)


def applied(cur: Any, cid: str) -> dict[str, list[dict[str, Any]]]:
    """The rows people approved, per scenario."""
    cur.execute(f"SELECT * FROM {TABLE} WHERE container_id=%s AND status='applied'", (cid,))
    out: dict[str, list[dict[str, Any]]] = {}
    for r in cur.fetchall():
        row = _json(r)
        out.setdefault(row["scenario_id"], []).append(row["values"])
    return out


def candidates(cur: Any, cid: str) -> list[dict[str, Any]]:
    """Scenarios that count and have data to vary, thinnest first: where more data pays most."""
    cur.execute("SELECT * FROM qa_scenarios WHERE container_id=%s", (cid,))
    rows = [dict(r) for r in cur.fetchall()]
    waiting = {r["scenario_id"] for r in pending(cur, cid)}
    locale: Any = None
    out = []
    for r in rows:
        if not qa_scenarios.counts_for_coverage(r) or base_table(r) is None:
            continue
        d = depth_mod.depth(r)
        if locale is None:
            locale = project_locale(cur, cid)
        # Only what Orcha can write for this table: a "Suggest rows" that finds nothing is noise.
        possible = {x["technique"] for x in suggest_rows(r, locale)}
        missing = [t for t in ("empty", "invalid", "boundary", "locale") if t not in d["kinds"] and t in possible]
        if not missing:
            continue
        out.append({"scenario_id": str(r["id"]), "name": r["name"], "origin": "yours" if r.get("source") == "authored" else "orcha",
                    "partitions": d["partitions"], "kinds": d["kinds"], "missing": missing, "waiting": str(r["id"]) in waiting})
    out.sort(key=lambda c: (c["partitions"], -len(c["missing"]), c["name"].lower()))
    return out[:MAX_CANDIDATES]


def summary(cur: Any, cid: str) -> dict[str, Any]:
    waiting = pending(cur, cid)
    cur.execute(f"SELECT COUNT(*) AS n FROM {TABLE} WHERE container_id=%s AND status='applied'", (cid,))
    done = int(cur.fetchone()["n"])
    cands = candidates(cur, cid)
    names = {c["scenario_id"]: c["name"] for c in cands}
    groups: dict[str, dict[str, Any]] = {}
    for w in waiting:
        g = groups.setdefault(w["scenario_id"], {"scenario_id": w["scenario_id"], "name": names.get(w["scenario_id"]), "rows": []})
        g["rows"].append(w)
    for sid, g in groups.items():
        if not g["name"]:
            g["name"] = qs.load_scenario(cur, sid)["name"]
    return {"pending": list(groups.values()), "applied": done, "candidates": cands}
