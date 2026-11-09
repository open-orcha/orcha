"""The QA device layer's element tree and targets (`orcha_cli/qa/device/tree.py`, `targets.py`),
adapted from the original `tests/unit/recording/test_tree.py` and `test_targets.py`, with Orcha's
`e12` refs. No device and no `qa` extra needed."""

from __future__ import annotations

import pytest

from orcha_cli.qa.device.targets import (
    Target,
    chosen,
    covered,
    covering,
    identity,
    nearest,
    off_screen,
    parse_target,
    refind,
    resolve,
    tree_order_layers,
)
from orcha_cli.qa.device.tree import (
    CLOCK_PATTERN,
    compact,
    compact_capped,
    find,
    foreground_app,
    has_unlabeled_or_ambiguous_nodes,
    parse_tree,
    screen_shape,
    screen_size,
    to_json_dict,
    tree_hash,
    tree_value_hash,
)

# A trimmed `idb ui describe-all --json` of a real app screen.
RAW = [
    {"type": "Application", "AXLabel": "Slate", "pid": 4242, "frame": {"x": 0, "y": 0, "width": 402, "height": 874}},
    {"type": "Heading", "AXLabel": "Library", "frame": {"x": 16, "y": 60, "width": 200, "height": 40}},
    {"type": "Button", "AXLabel": "Account", "AXUniqueId": "tab-account", "frame": {"x": 342, "y": 74, "width": 44, "height": 40}, "enabled": True},
    {"type": "GenericElement", "frame": {"x": 0, "y": 120, "width": 402, "height": 600}},
    {"type": "Cell", "AXLabel": "The Hobbit", "frame": {"x": 0, "y": 140, "width": 402, "height": 60}},
    {"type": "Cell", "AXLabel": "Dune", "frame": {"x": 0, "y": 200, "width": 402, "height": 60}},
]


def test_parse_keeps_index_and_int_bounds():
    els = parse_tree(RAW)
    assert [e.index for e in els] == list(range(len(RAW)))
    btn = next(e for e in els if e.identifier == "tab-account")
    assert (btn.type, btn.label, btn.ref) == ("Button", "Account", "e2")
    assert (btn.x1, btn.y1, btn.x2, btn.y2) == (342, 74, 386, 114)
    assert btn.enabled is True and btn.center == (364, 94)


def test_parse_tolerates_missing_frame():
    els = parse_tree([{"type": "Button", "AXLabel": "x"}])
    assert els[0].x1 == els[0].y1 == els[0].x2 == els[0].y2 == 0


def test_compact_names_elements_by_ref_and_drops_noise():
    els = parse_tree(
        [
            {"type": "GenericElement", "frame": {"x": 0, "y": 0, "width": 10, "height": 10}},
            {"type": "Button", "AXLabel": "Go", "AXUniqueId": "go", "frame": {"x": 1, "y": 2, "width": 3, "height": 4}, "enabled": True},
            {"type": "TextField", "AXValue": "hello", "frame": {"x": 0, "y": 0, "width": 10, "height": 10}, "enabled": False, "traits": ["Selected"]},
        ]
    )
    assert compact(els).splitlines() == [
        'e1 Button "Go" id=go (1,2)-(4,6)',
        'e2 TextField "" value="hello" (0,0)-(10,10) disabled selected',
    ]


def test_compact_keeps_unlabelled_interactive_elements():
    assert compact(parse_tree([{"type": "Button", "frame": {"x": 0, "y": 0, "width": 1, "height": 1}}])) == 'e0 Button "" (0,0)-(1,1)'


def test_compact_capped_says_how_many_were_left_out():
    els = parse_tree([{"type": "StaticText", "AXLabel": f"row {i}"} for i in range(5)])
    text = compact_capped(els, max_nodes=3)
    assert text.count("\n") == 3 and "2 more" in text and "find(text)" in text


def test_tree_hash_ignores_values_and_bounds_but_not_labels():
    def one(value, label, x):
        return parse_tree([{"type": "TextField", "AXValue": value, "AXLabel": label, "frame": {"x": x, "y": 0, "width": 1, "height": 1}}])

    assert tree_hash(one("a", "Name", 0)) == tree_hash(one("b", "Name", 5))
    assert tree_hash(one("a", "Name", 0)) != tree_hash(one("a", "Other", 0))
    assert tree_value_hash(one("a", "Name", 0)) != tree_value_hash(one("b", "Name", 0))
    assert len(tree_hash(one("a", "Name", 0))) == 12


def test_screen_shape_keeps_values_and_masks_clocks():
    def shot(label, value=""):
        return parse_tree([{"type": "Button", "AXLabel": label, "AXValue": value, "frame": {"x": 0, "y": 0, "width": 9, "height": 9}}])

    assert screen_shape(shot("Pay", "0")) != screen_shape(shot("Pay", "1"))
    for t in ("12:05", "0:59", "23:59:59"):
        assert "<time>" in screen_shape(shot(f"Ends in {t}"))
    assert screen_shape(shot("Ends in 0:59")) == screen_shape(shot("Ends in 0:58"))
    assert not CLOCK_PATTERN.search("Room 101") and "<time>" not in screen_shape(shot("2024:1"))


def test_find_is_case_insensitive_substring_with_optional_role():
    els = parse_tree(RAW)
    assert any(e.identifier == "tab-account" for e in find(els, "account"))
    assert all(e.type == "Button" for e in find(els, "account", role="Button"))
    assert find(els, "zzz-not-there") == []


def test_foreground_app_and_screen_size():
    els = parse_tree(RAW)
    assert foreground_app(els) == ("Slate", 4242)
    assert screen_size(els) == (402, 874)
    assert foreground_app(parse_tree([{"type": "Button"}])) == (None, None)
    assert screen_size(parse_tree([{"type": "Button"}])) == (0, 0)


def test_unlabeled_or_ambiguous_nodes():
    named = parse_tree([{"type": "Button", "AXLabel": "Go"}, {"type": "TextField", "AXUniqueId": "email"}])
    assert has_unlabeled_or_ambiguous_nodes(named) is False
    assert has_unlabeled_or_ambiguous_nodes(parse_tree([{"type": "Button"}])) is True
    assert has_unlabeled_or_ambiguous_nodes(parse_tree([{"type": "Cell", "AXLabel": "Item"}, {"type": "Cell", "AXLabel": "Item"}])) is True
    assert has_unlabeled_or_ambiguous_nodes(parse_tree([{"type": "GenericElement"}])) is False
    assert has_unlabeled_or_ambiguous_nodes([]) is False


def test_to_json_dict_matches_compact_visibility():
    out = to_json_dict(parse_tree([
        {"type": "GenericElement"},
        {"type": "Button", "AXLabel": "Go", "AXUniqueId": "go", "frame": {"x": 1, "y": 2, "width": 3, "height": 4}},
    ]))
    assert out == [{"ref": "e1", "index": 1, "type": "Button", "label": "Go", "value": "", "identifier": "go",
                    "bounds": [1, 2, 4, 6], "enabled": True, "traits": []}]


# ---------- targets ----------


@pytest.fixture
def els():
    return parse_tree([
        {"type": "Button", "AXLabel": "Save", "AXUniqueId": "saveButton", "frame": {"x": 10, "y": 10, "width": 20, "height": 20}},
        {"type": "Button", "AXLabel": "Save", "frame": {"x": 100, "y": 100, "width": 20, "height": 20}},
        {"type": "TextField", "AXValue": "Draft", "frame": {"x": 0, "y": 200, "width": 100, "height": 40}},
    ])


@pytest.mark.parametrize("spec, want", [
    ("e12", Target(index=12)),
    ("[3]", Target(index=3)),
    (" e0 ", Target(index=0)),
    ("id=save_button", Target(id="save_button")),
    ("text=e12", Target(text="e12")),
    ("Save", Target(text="Save")),
    ("120,340", Target(bounds="120,340,120,340")),
    ("10, 20, 110, 60", Target(bounds="10,20,110,60")),
    ("12", Target(text="12")),  # a keypad's "12" is a text, never a ref
    ("", Target()),
    (None, Target()),
    ({"ref": "e4"}, Target(index=4)),
    ({"text": "Save", "text_index": 1}, Target(text="Save", text_index=1)),
    ({"x": 5, "y": 6}, Target(bounds="5,6,5,6")),
])
def test_parse_target_reads_every_form(spec, want):
    assert parse_target(spec) == want


def test_parse_target_refuses_a_bad_ref():
    with pytest.raises(ValueError):
        parse_target({"ref": "save"})


def test_bounds_win_over_everything(els):
    assert resolve(Target(bounds="0,0,10,10", id="saveButton", text="Save"), els) == ((5, 5), "bounds")
    assert resolve(parse_target("7,9"), els) == ((7, 9), "bounds")


def test_ref_resolves_to_centre_and_out_of_range_is_an_error(els):
    assert resolve(parse_target("e1"), els) == ((110, 110), "ref")
    point, how = resolve(parse_target("e99"), els)
    assert point is None and "e99" in how and "e0..e2" in how


def test_id_before_text_and_text_matches_label_or_value(els):
    assert resolve(Target(id="saveButton", text="Save", text_index=1), els) == ((20, 20), "id")
    assert resolve(Target(text="Save", text_index=1), els) == ((110, 110), "text")
    assert resolve(Target(text="draft"), els) == ((50, 220), "text")
    assert resolve(Target(id="nope", text="Save"), els) == ((20, 20), "text")


def test_errors_say_what_was_wrong(els):
    assert "no locator" in resolve(Target(), els)[1]
    assert "bounds" in resolve(Target(bounds="1,2,3"), els)[1]
    assert "text_index 5 out of range" in resolve(Target(text="Save", text_index=5), els)[1]
    assert "no element matched" in resolve(Target(text="Delete"), els)[1]


def test_to_dict_and_describe():
    assert parse_target("e3").to_dict() == {"ref": "e3"}
    assert parse_target("1,2").describe() == "(1,2)"
    assert parse_target("Save").describe() == "'Save'"
    assert parse_target(None).describe() == "the focused field"


def _row(label, y, ident="row", type_="Button", value=None):
    node = {"type": type_, "AXLabel": label, "AXUniqueId": ident, "frame": {"x": 0, "y": y, "width": 100, "height": 40}}
    if value is not None:
        node["AXValue"] = value
    return node


def test_chosen_picks_the_element_each_locator_names(els):
    assert chosen(Target(index=1), els) is els[1]
    assert chosen(Target(id="saveButton"), els) is els[0]
    assert chosen(Target(text="Save", text_index=1), els) is els[1]
    assert chosen(Target(bounds="0,0,10,10"), els) is None
    assert chosen(Target(index=99), els) is None


def test_refind_follows_an_element_that_moved():
    seen = parse_tree([_row("Banner", 0, "banner"), _row("Delete", 100), _row("Keep", 140)])
    live = parse_tree([_row("Banner", 0, "banner"), _row("New item", 100), _row("Delete", 140), _row("Keep", 180)])
    now = refind(seen[1], live)
    assert now is not None and now.label == "Delete" and now.y1 == 140


def test_refind_prefers_the_nearest_and_never_crosses_types():
    assert refind(parse_tree([_row("Edit", 100), _row("Edit", 300)])[1], parse_tree([_row("Edit", 120), _row("Edit", 320)])).y1 == 320
    assert refind(parse_tree([_row("Delete", 100)])[0], parse_tree([_row("Undo", 100, "undo")])) is None
    seen = parse_tree([_row("OK", 100, "ok")])
    assert refind(seen[0], parse_tree([_row("OK", 100, "other"), _row("OK", 100, "ok", type_="StaticText")])) is None


def test_identity_is_a_control_by_label_and_a_text_by_place():
    a = parse_tree([_row("Save", 10), {"type": "StaticText", "AXLabel": "3 items", "frame": {"x": 0, "y": 80, "width": 50, "height": 20}}])
    b = parse_tree([_row("Save", 50), {"type": "StaticText", "AXLabel": "4 items", "frame": {"x": 0, "y": 80, "width": 50, "height": 20}}])
    assert identity(a[0]) == identity(b[0]) and identity(a[1]) == identity(b[1])


def test_off_screen_says_how_far_and_which_way():
    assert off_screen((100, 100), 402, 874) is None
    assert off_screen((100, 100), 0, 0) is None
    below = off_screen((200, 1000), 402, 874)
    assert "127 pt below the bottom edge" in below and "swipe up" in below
    assert "swipe down" in off_screen((200, -50), 402, 874)
    assert "swipe up 7 times (distance_percent 80)" in off_screen((200, 4000), 402, 874)
    assert "px" in off_screen((-5, 10), 1080, 2400, unit="px")


def test_a_sheet_over_the_whole_target_covers_it():
    tree = parse_tree([
        {"type": "Application", "AXLabel": "App", "frame": {"x": 0, "y": 0, "width": 402, "height": 874}},
        {"type": "Button", "AXLabel": "Behind", "frame": {"x": 20, "y": 500, "width": 100, "height": 40}},
        {"type": "Button", "AXLabel": "Close sheet", "frame": {"x": 0, "y": 300, "width": 402, "height": 574}},
    ])
    assert covered(Target(text="Behind"), tree, (70, 520)) == 'Button "Close sheet"'
    assert covered(Target(bounds="70,520,70,520"), tree, (70, 520)) is None


def test_a_context_menus_scrim_does_not_cover_the_menu():
    tree = parse_tree([
        {"type": "Application", "AXLabel": "App", "frame": {"x": 0, "y": 0, "width": 402, "height": 874}},
        {"type": "Button", "AXLabel": "Export PDF", "frame": {"x": 40, "y": 300, "width": 250, "height": 44}},
        {"type": "Button", "AXLabel": "Dismiss context menu", "frame": {"x": 0, "y": 0, "width": 402, "height": 874}},
    ])
    layers = tree_order_layers(tree)
    mine = next(layer for layer in layers if layer.index == 1)
    assert covering(mine, layers, whole=True) is None


def test_nearest_suggests_what_reads_alike():
    els = parse_tree([_row("Save draft", 10), _row("Delete", 50, "del"), _row("Settings", 90, "settings")])
    hits = nearest("save", els)
    assert hits and hits[0].label == "Save draft" and all(e.label != "Delete" for e in hits)
    assert nearest("", els) == []


def test_the_device_chrome_never_changes_the_hash_or_the_shape():
    def shot(signal):
        return parse_tree([
            {"type": "StaticText", "AXLabel": signal, "traits": ["System"]},
            {"type": "Button", "AXLabel": "Pay"},
        ])

    assert tree_hash(shot("T-Mobile, one bar.")) == tree_hash(shot("T-Mobile, no signal."))
    assert screen_shape(shot("one bar")) == screen_shape(shot("no signal"))
    assert "one bar" in compact(shot("one bar"))  # still shown to the agent
