"""Formula rendering for the private Homebrew tap (spec:
docs/superpowers/specs/2026-06-11-homebrew-distribution-design.md §1-§3).
The release workflow renders a tracking `orcha.rb` plus a frozen
`orcha@X.Y.Z.rb` per release; these tests pin the contract."""
import importlib.util
import pathlib

import pytest

_SCRIPT = (pathlib.Path(__file__).resolve().parents[1]
           / "packaging" / "homebrew" / "render_formula.py")
_spec = importlib.util.spec_from_file_location("render_formula", _SCRIPT)
rf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rf)

SHA = "a" * 40


def test_class_name_plain():
    assert rf.class_name("orcha") == "Orcha"


def test_class_name_versioned_follows_brew_at_convention():
    # brew: foo@1.2.3 -> FooAT123 (non-alphanumerics dropped after AT)
    assert rf.class_name("orcha@0.2.1") == "OrchaAT021"


def test_tracking_formula_pins_tag_and_revision_no_leftover_placeholders():
    out = rf.render("0.2.0", SHA, versioned=False)
    assert "class Orcha < Formula" in out
    assert 'tag:      "v0.2.0"' in out
    assert f'revision: "{SHA}"' in out
    assert 'version "0.2.0"' in out
    assert "conflicts_with" not in out
    assert "{{" not in out and "}}" not in out


def test_versioned_formula_conflicts_with_tracking_formula():
    out = rf.render("0.2.0", SHA, versioned=True)
    assert "class OrchaAT020 < Formula" in out
    assert 'conflicts_with "orcha"' in out


def test_main_writes_both_formulae(tmp_path, monkeypatch):
    monkeypatch.setattr(rf.sys, "argv",
                        ["render_formula.py", "0.2.0", SHA, str(tmp_path)])
    rf.main()
    assert (tmp_path / "orcha.rb").exists()
    assert (tmp_path / "orcha@0.2.0.rb").exists()


@pytest.mark.parametrize("version,revision", [
    ("0.2", SHA),            # not X.Y.Z
    ("v0.2.0", SHA),         # leading v belongs to the tag, not the version
    ("0.2.0", "short-sha"),  # not a 40-char commit sha
])
def test_main_rejects_malformed_inputs(tmp_path, monkeypatch, version, revision):
    monkeypatch.setattr(rf.sys, "argv",
                        ["render_formula.py", version, revision, str(tmp_path)])
    with pytest.raises(SystemExit):
        rf.main()
