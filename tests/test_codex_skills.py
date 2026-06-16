from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)


def test_install_orcha_skill_templates_writes_claude_commands_and_codex_skills(tmp_path):
    claude_commands, codex_skills = cli._install_orcha_skill_templates(tmp_path)

    claude_command = claude_commands / "orcha-next.md"
    codex_skill = codex_skills / "orcha-next" / "SKILL.md"

    assert claude_command.exists()
    assert codex_skill.exists()
    assert claude_command.read_text().startswith("---\ndescription:")

    skill_text = codex_skill.read_text()
    assert skill_text.startswith("---\nname: orcha-next\n")
    assert "Codex skill mirror of the Claude Code `/orcha-next` command" in skill_text
    assert "use the matching `$orcha-*` Codex skill" in skill_text
    assert "You are executing `/orcha-next`." in skill_text


def test_codex_skill_body_strips_claude_frontmatter_and_maps_claude_tools():
    command_md = (cli.PKG_TEMPLATES / "skills" / "orcha-status.md").read_text()

    skill_text = cli._codex_skill_body("orcha-status", command_md)

    assert skill_text.startswith("---\nname: orcha-status\n")
    assert "description: \"Print a human-friendly snapshot" in skill_text
    assert "allowed-tools:" not in skill_text
    assert "argument-hint:" not in skill_text
    assert "User arguments: `$ARGUMENTS`" in skill_text
    assert "ask the user a concise clarifying question directly" in skill_text
