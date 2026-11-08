"""A passed walk becomes a draft scenario (`orcha_cli/qa/walk_to_scenario.py`): one criterion per
reported step, checks on labels its end screen really showed, frame evidence, the real steps in
the description, folding and refusals."""

from __future__ import annotations

from orcha_cli.qa import scenario_format as sf
from orcha_cli.qa import walk_to_scenario as w2s


def screen(seq, title, texts, anchors=(), frame=None, roles=None):
    return {"seq": seq, "kind": "screen", "frame_id": frame or f"f{seq}",
            "args": {"title": title, "texts": list(texts), "anchors": list(anchors), "roles": roles or {}}}


def act(seq, kind, **args):
    return {"seq": seq, "kind": kind, "args": args, "result": "ok"}


TRACE = [
    act(1, "launch", app="com.example.snug"),
    screen(2, "Today", ["No feeds yet", "Today 09:41"], ["Feed", "Today"], roles={"Today": "Heading", "Feed": "Button"}),
    act(3, "tap", target={"spec": "e2", "label": "Feed", "role": "Button"}),
    screen(4, "New feed", ["New feed"], ["Bottle", "Amount (ml)", "Save feed", "Today"], roles={"New feed": "Heading"}),
    act(5, "type", target={"spec": "e3", "label": "Amount (ml)"}, text="120"),
    screen(6, "New feed", ["New feed", "120"], ["Bottle", "Save feed", "Today"]),
    act(7, "tap", target={"spec": "Save feed", "label": "Save feed"}),
    screen(8, "Today", ["Bottle feed", "120 ml", "3 min ago"], ["Feed", "Today"], roles={"Bottle feed": "StaticText"}),
]
FLOW = {"name": "Log a bottle feed", "persona": "a new parent", "data": {"amount": "120 ml", "pin": "1234"},
        "steps": [{"text": "Open New feed"}, {"text": "Enter 120"}, {"text": "Save"}], "feature": "feeding"}


def walk(steps):
    return {"id": "w1", "start_seq": 1, "end_seq": 8, "steps": steps}


def test_passed_walk_gives_a_draft_with_checks_and_evidence():
    steps = [
        {"index": 1, "reached": True, "result": "Tapped Feed", "checked": ["New feed"], "seq": 4},
        {"index": 2, "reached": True, "result": "typed 120", "expected": 'The amount field holds "120"', "seq": 6},
        {"index": 3, "reached": True, "result": "Back on Today", "checked": ["Bottle feed"], "expected": "Today lists the bottle feed", "seq": 8},
    ]
    d = w2s.from_walk(walk(steps), FLOW, TRACE, "ios")
    assert d.problem is None
    assert d.name == "Log a bottle feed" and d.persona == "a new parent" and d.category == "Feeding"
    assert d.tags == ["walked", "ios"] and d.data == {"amount": "120 ml"}
    assert d.criteria[0] == 'The screen shows "New feed"'  # the result was a log of a tap, so the checked label speaks
    assert d.criteria[1] == 'The amount field holds "120"'
    assert d.criteria[2] == 'Today lists the "bottle feed"'
    # a bare number is never checked (it changes per run); the step is then unconfirmed by checks
    assert d.checks == [{"criterion_index": 0, "line": 'Heading "New feed"'}, {"criterion_index": 2, "line": 'text "Bottle feed"'}]
    assert [e["frame_id"] for e in d.evidence] == ["f4", "f6", "f8"]
    assert [e["status"] for e in d.evidence] == ["verified", "unconfirmed", "verified"]
    assert d.description.startswith("As a new parent, log a bottle feed. Steps: 1. Launch the app. 2. Tap \"Feed\". "
                                     "3. Type \"120\" into \"Amount (ml)\". 4. Tap \"Save feed\".")
    assert d.description.endswith("Replays as walked.")
    body = d.body()
    assert set(body) == {"name", "category", "persona", "description", "criteria", "checks", "data", "tags"}
    # the draft passes the lint's error rules and quotes every checked label
    s = sf.from_row(body)
    assert not [f for f in sf.lint_scenario(s, d.data) if f.severity == "error"]


def test_volatile_and_chrome_texts_are_never_checked():
    steps = [{"index": 1, "reached": True, "result": "the list opened", "seq": 4},
             {"index": 2, "reached": True, "result": "it shows 3 min ago and Today 09:41", "seq": 8}]
    d = w2s.from_walk(walk(steps), FLOW, TRACE, "android")
    lines = [c["line"] for c in d.checks]
    assert not any("09:41" in x or "min ago" in x for x in lines)
    assert not any(x == 'text "Today"' for x in lines)  # on every screen: chrome
    assert d.tags == ["walked", "android"]


def test_unreached_steps_and_too_few_criteria_give_no_draft():
    d = w2s.from_walk(walk([{"index": 1, "reached": False, "result": "x"}]), FLOW, TRACE, "ios")
    assert d.problem == "not every step of the walk was reached"
    d = w2s.from_walk(walk([{"index": 1, "reached": True, "result": "Bottle feed listed", "checked": ["Bottle feed"], "seq": 8}]), FLOW, TRACE, "ios")
    assert d.problem.startswith("the walk gives 1 criterion")
    assert w2s.from_walk(walk([]), FLOW, TRACE, "ios").problem == "the walk reported no steps"


def test_a_step_that_names_nothing_folds_into_the_next():
    steps = [
        {"index": 1, "reached": True, "result": "tapped around", "seq": 2},  # before any action: nothing new named
        {"index": 2, "reached": True, "result": "opened", "checked": ["New feed"], "seq": 4},
        {"index": 3, "reached": True, "result": "typed", "seq": 6},
        {"index": 4, "reached": True, "result": "saved", "checked": ["Bottle feed"], "seq": 8},
    ]
    d = w2s.from_walk(walk(steps), FLOW, TRACE, "ios")
    assert d.problem is None
    assert 2 <= len(d.criteria) <= 3


def test_at_most_five_criteria():
    trace = [act(1, "launch")]
    steps = []
    for i in range(8):
        trace += [act(2 + 2 * i, "tap", target={"label": f"Next {i}"}), screen(3 + 2 * i, f"Page {i}", [f"Page {i}"], roles={f"Page {i}": "Heading"})]
        steps.append({"index": i + 1, "reached": True, "result": f"Page {i} opened", "checked": [f"Page {i}"], "seq": 3 + 2 * i})
    d = w2s.from_walk({"id": "w", "start_seq": 1, "end_seq": 17, "steps": steps}, {"name": "Long"}, trace, "ios")
    assert len(d.criteria) == w2s.MAX_CRITERIA
    assert len(d.evidence) == w2s.MAX_CRITERIA


def test_coordinate_taps_are_called_out_and_described():
    trace = [act(1, "tap", target={"spec": "120,340"}), screen(2, "A", ["Alpha"]),
             act(3, "tap", target={"spec": "e4", "label": "Go"}, long_press_ms=900), screen(4, "B", ["Beta"]),
             act(5, "swipe", direction="up"), act(6, "type", target={"spec": "e1"}, clear=True), screen(7, "B", ["Beta"])]
    steps = [{"index": 1, "reached": True, "result": "Alpha shows", "checked": ["Alpha"], "seq": 2},
             {"index": 2, "reached": True, "result": "Beta shows", "checked": ["Beta"], "seq": 7}]
    d = w2s.from_walk({"id": "w", "start_seq": 1, "end_seq": 7, "steps": steps}, {"name": "Coords"}, trace, "ios")
    assert "Tap at 120,340" in d.description and 'Long-press "Go"' in d.description and "Swipe up" in d.description
    assert "Clear at e1" in d.description or "Clear" in d.description
    assert "no replayable path" in d.description and d.note


def test_label_gone_from_the_settled_screen_is_checked_as_appears():
    trace = [act(1, "tap", target={"label": "Save"}), screen(2, "Saved!", ["Saved!", "Home"]), screen(3, "Home", ["Home", "Feeds"]),
             act(4, "tap", target={"label": "Feeds"}), screen(5, "Feeds", ["Feeds list"])]
    steps = [{"index": 1, "reached": True, "result": 'a "Saved!" toast showed', "seq": 3},
             {"index": 2, "reached": True, "result": "the feeds list opened", "checked": ["Feeds list"], "seq": 5}]
    d = w2s.from_walk({"id": "w", "start_seq": 1, "end_seq": 5, "steps": steps}, {"name": "Save"}, trace, "ios")
    assert [c["line"] for c in d.checks if c["criterion_index"] == 0] == ['text "Saved!" appears']


def test_recorded_steps_and_scenario_data_helpers():
    rec = w2s.recorded_steps([{"seq": "3", "kind": "tap", "args": None}, {"seq": 1, "kind": "screen"}, {"kind": "x"}], 1, 2)
    assert [s["seq"] for s in rec] == [1]
    assert w2s.scenario_data({"name": "Amani", "password": "x", "api_key": "k", "x": "<secret:pw>"}) == {"name": "Amani"}
    assert w2s.from_walk({"steps": "not a list"}, None, [], "ios").problem
