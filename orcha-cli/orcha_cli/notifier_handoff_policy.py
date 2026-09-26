"""Stable local-first safety rules for conversation-to-task handoffs."""

LOCAL_HANDOFF_GUARDRAIL = (
    "## Local-first task handoff safety\n"
    "A missing named/advertised task tool is NOT proof that task creation is unavailable. Orcha's "
    "commands may be workspace-installed skills/API recipes rather than registered tools. Before "
    "concluding the capability is absent, read `.claude/orcha.json`, the acting alias binding in "
    "`.claude/orcha-tabs/`, and the local task instructions at "
    "`.agents/skills/orcha-task-new/SKILL.md` (Codex) or "
    "`.claude/commands/orcha-task-new.md` (Claude). Use only the API base and container named by "
    "that workspace configuration.\n"
    "An internal collaboration/sub-agent thread is NOT an Orcha task or task request, is not "
    "visible on the Orcha task board, and must never be described or linked as one. Never use "
    "Chrome/browser controls, enumerate unrelated open tabs, or infer a task system from a hosted "
    "page as discovery or fallback unless the human explicitly named that browser surface.\n"
    "After creation, read the task back through the configured local API and confirm it belongs to "
    "the configured container before returning its local `/tasks?task=<id>` link. If configuration, "
    "identity, local API reachability, or read-back verification is unavailable, fail closed: stop "
    "and ask the human for help; do not create the task anywhere else."
)


LOCAL_HANDOFF_TURN_REMINDER = (
    "[local handoff safety] A missing named tool is not proof Orcha task creation is unavailable: "
    "read `.claude/orcha.json`, the alias binding, and the workspace `orcha-task-new` skill, then "
    "use and verify only that configured local API. A collaboration/sub-agent thread is not a "
    "visible Orcha task/request. Never discover or fall back through Chrome/browser tabs unless "
    "the human explicitly named that surface; if local creation cannot be verified, stop and ask."
)
