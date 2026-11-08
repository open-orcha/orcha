"""Scenario markdown v3 and the check grammar (`orcha_cli/qa/scenario_format.py`, `checks.py`):
parse, render, round trip through `qa_scenarios` rows, and the style lint."""

from __future__ import annotations

import pytest

from orcha_cli.qa import checks
from orcha_cli.qa import scenario_format as sf

FILE = """# Fleet
Environment: test

## Record a trip on our own truck
Scenario-Id: 7f1c
Category: Income
Persona: Owner
Description: An owner records a hauled trip and sees it counted in the month's income.
Needs: reset, fixture "7 routines, weekly"
Tags: walked, ios
Seed: POST /api/trucks {"plate": "{{plate}}"} as truck
Cleanup: DELETE /api/trucks/{{truck.id}}
Check: screen changed
1. The Income page offers an "Add trip" action
   Check: Button "Add trip"
2. After saving a trip of {{rate}} on truck {{truck.plate}}, a "Trip added" confirmation appears
   Check: text "Trip added" appears within 10s
   Saved: record "Trip" -> rate is "{{rate}}"
3. The month's income goes up by exactly the trip's rate
   Check: api GET /trucks/{{truck.id}} .income increases by {{rate}}

## Examples
| rate | note |
| --- | --- |
| 4321 | a small trip |

## Data
plate = pattern KD[A-Z] [0-9]{3}[A-Z]
month = 2026-10
"""


def test_parse_file_reads_every_part():
    f = sf.parse_file(FILE)
    assert f.title == "Fleet" and f.meta == {"environment": "test"}
    assert f.data == {"plate": "pattern KD[A-Z] [0-9]{3}[A-Z]", "month": "2026-10"}
    [s] = f.scenarios
    assert s.name == "Record a trip on our own truck" and s.scenario_id == "7f1c"
    assert (s.category, s.persona) == ("Income", "Owner")
    assert s.needs == ["reset", 'fixture "7 routines, weekly"']
    assert s.tags == ["walked", "ios"]
    assert len(s.criteria) == 3 and s.criteria[0] == 'The Income page offers an "Add trip" action'
    assert s.checks == {0: ['Button "Add trip"'], 1: ['text "Trip added" appears within 10s'],
                        2: ["api GET /trucks/{{truck.id}} .income increases by {{rate}}"]}
    assert s.saved == {1: ['record "Trip" -> rate is "{{rate}}"']}
    assert s.scenario_checks == ["screen changed"]
    assert s.seeds and s.cleanup
    assert s.examples == {"columns": ["rate", "note"], "rows": [["4321", "a small trip"]]}


def test_render_round_trips():
    [s] = sf.parse_scenarios(FILE)
    again = sf.parse_scenarios(sf.render_scenario(s))
    assert again == [s]
    text = sf.render_file([s], data={"month": "2026-10"}, title="Fleet")
    f = sf.parse_file(text)
    assert f.title == "Fleet" and f.data == {"month": "2026-10"} and f.scenarios == [s]


def test_rows_round_trip_with_saved_lines_among_the_checks():
    [s] = sf.parse_scenarios(FILE)
    row = sf.to_row(s, {"month": "2026-10"})
    assert row["criteria"] == s.criteria and row["data"] == {"month": "2026-10"}
    assert row["checks"][0] == {"criterion_index": None, "line": "screen changed"}
    assert [c["line"] for c in row["checks"] if c["criterion_index"] == 1] == [
        'text "Trip added" appears within 10s', 'saved record "Trip" -> rate is "{{rate}}"']
    back = sf.from_row({**row, "id": "7f1c"})
    assert back.checks == s.checks and back.saved == s.saved and back.scenario_checks == s.scenario_checks
    assert back.needs == s.needs and back.tags == s.tags
    # rows from the portal may carry JSON text
    import json

    text_row = sf.from_row({"name": "x", "criteria": json.dumps(["a", "b"]), "checks": json.dumps({"criteria": {"1": ['text "B"']}})})
    assert text_row.criteria == ["a", "b"] and text_row.checks == {1: ['text "B"']}


def test_description_is_folded_onto_one_line():
    s = sf.Scenario(name="x", criteria=["a b", "c d"], description="Goal.\nSteps:\n1. Tap Save\nCheck: nope")
    out = sf.parse_scenarios(sf.render_scenario(s))[0]
    assert out.criteria == ["a b", "c d"] and out.description == "Goal. Steps: 1. Tap Save Check: nope"


def test_legacy_expect_and_context_sections():
    text = "## Old\n- Tap Save\nExpect: the order is placed\n\n## Memory\n- not a scenario\n"
    [s] = sf.parse_scenarios(text)
    assert s.criteria == ["Tap Save"] and s.expect == "the order is placed"
    [only] = sf.parse_scenarios("## Only expect\nExpect: it works\n")
    assert only.criteria == ["it works"]


# ---------- checks ----------


@pytest.mark.parametrize("line, rendered", [
    ('text "Order placed"', 'text "Order placed"'),
    ('Check: Button "Pay" disabled within 10s [warning]', 'Button "Pay" disabled within 10s [warning]'),
    ('text ~"placed"', 'text ~"placed"'),
    ("text /Order #\\d+/i", "text /Order #\\d+/i"),
    ("id=save_button absent", "id=save_button absent"),
    ('count Cell >= 3', "count Cell >= 3"),
    ('TextField "Email" value "a@b.co"', 'TextField "Email" value "a@b.co"'),
    ("screen changed", "screen changed"),
    ('text "say \\"hi\\""', 'text "say \\"hi\\""'),
])
def test_check_grammar_renders_canonically(line, rendered):
    c = checks.parse_check(line)
    assert not c.problems, c.problems
    assert c.render() == rendered


@pytest.mark.parametrize("line, problem", [
    ('Buton "Pay"', "unknown subject"),
    ("text Pay", "text needs a quoted string"),
    ('count Button "x"', "count needs"),
    ('Button "Pay" glowing', "unknown matcher"),
    ('text "x" within soon', "within needs"),
    ("screen", "screen needs"),
])
def test_check_grammar_problems(line, problem):
    c = checks.parse_check(line)
    assert any(problem in p for p in c.problems), c.problems


def test_checks_pass_through_deltas_and_readbacks():
    assert checks.parse_check("query select count(*) from trips increases by 1").subject == "delta"
    c = checks.parse_check('Saved: record "Trip" -> rate is "1"')
    assert c.subject == "saved" and c.render() == 'saved record "Trip" -> rate is "1"'


def test_transient_and_contradictions_and_helpers():
    assert checks.transient_check('Button "Signing in…"')
    assert checks.transient_check('text "Saved"', "a toast confirms the save")
    assert not checks.transient_check('text "Saved" appears', "a toast confirms the save")
    assert checks.contradictions(['text "Empty"', 'text "Empty" absent']) == [('text "Empty"', 'text "Empty" absent')]
    assert checks.text_check("Save", "Button") == 'Button "Save"'
    assert checks.text_check("Bottle feed", "StaticText") == 'text "Bottle feed"'
    assert checks.rewrite_check('text "Saved"', matcher="appears") == 'text "Saved" appears'
    assert checks.resolve_placeholders('text "{{name}}"', {"name": "Amani"}) == 'text "Amani"'


# ---------- lint ----------


def _rules(s, data=None):
    return {(f.rule, f.criterion) for f in sf.lint_scenario(s, data)}


def test_lint_clean_scenario_scores_100():
    s = sf.Scenario(name="Log a feed", description="A parent logs a bottle feed.",
                    criteria=['The "New feed" form opens', 'Today lists the "Bottle feed"'],
                    checks={0: ['Heading "New feed"'], 1: ['text "Bottle feed"']})
    findings = sf.lint_scenario(s)
    assert findings == [] and sf.score(findings) == 100 and sf.lint_text(findings) == "lint: clean (100)"


def test_lint_catches_the_style_rules():
    s = sf.Scenario(
        name="Add truck test", description="",
        criteria=["Tap \"Add truck\"", "Type KBX into #plate-input", "Wait 2 seconds", "Tap \"Add truck\"",
                  'The picker shows "Left", "Right", "Both" and "Bottle"', "A toast says saved", "x", "y", "z"],
        checks={5: ['text "Saved"'], 6: ["Buton \"x\""], 7: ['text "A"', 'text "A" absent']},
    )
    rules = _rules(s, {"name": "test123", "plate": "pattern KD[A-Z"})
    expected = {("criteria-count", None), ("no-description", None), ("click-script", 0), ("selector", 1), ("sleep", 2),
                ("duplicate-criterion", 3), ("quoted-text-unchecked", 0), ("inventory", 4), ("transient-check", 5),
                ("bad-check", 6), ("contradictory-checks", 7), ("placeholder-value", None), ("bad-generator", None)}
    assert expected <= rules, expected - rules


def test_lint_counts_and_placeholders():
    one = sf.Scenario(name="x", description="d", criteria=["only one"])
    assert ("criteria-count", None) in _rules(one)
    six = sf.Scenario(name="x", description="d", criteria=[f"outcome {i}" for i in range(6)])
    assert ("too-many-steps", None) in _rules(six)
    s = sf.Scenario(name="x", description="d", criteria=["Shows {{plate}} for {{truck.id}}", "Owner {{qa.email}} and {{ghost}}"],
                    seeds=['POST /api/trucks {} as truck'])
    rules = _rules(s, {"plate": "KDA 391C"})
    assert ("unresolved-placeholder", 1) in rules
    assert sum(1 for r in rules if r[0] == "unresolved-placeholder") == 1
    tagged = sf.Scenario(name="x", description="d", criteria=["Shows QA-{{tag4}} Floss", "b c"])
    assert ("run-tag-shown", 0) in _rules(tagged)


def test_from_row_reads_the_older_dict_checks_and_strings():
    s = sf.from_row({"name": "x", "criteria": ["a", "b"],
                     "checks": {"scenario": ["screen changed"], "criteria": {"1": ['text "B"', 'saved GET /x -> a is "1"']}}})
    assert s.scenario_checks == ["screen changed"] and s.checks == {1: ['text "B"']} and s.saved == {1: ['GET /x -> a is "1"']}
    assert sf.from_row({"name": "x", "criteria": ["a", "b"], "checks": ["url contains \"/x\""]}).scenario_checks == ['url contains "/x"']
    assert sf.checks_by_index({1: ['text "B"']}) == [{"criterion_index": 1, "line": 'text "B"'}]
