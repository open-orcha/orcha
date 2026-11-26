"""Reply style lookups shared by the reply-style routes and the wake protocol (mig 102).

Stored values: containers.reply_style (project setting, default normal) and the nullable
per-thread overrides conversations.reply_style / tasks.reply_style (NULL follows the project).
"""

from __future__ import annotations

from typing import Optional

REPLY_STYLES = ("normal", "caveman", "asd_ste100")
DEFAULT_REPLY_STYLE = "normal"


def clean_style(value) -> Optional[str]:
    """A stored style if it is one we know, else None (an unknown value never reaches a prompt)."""
    return value if value in REPLY_STYLES else None


def project_style(cur, cid) -> str:
    cur.execute("SELECT reply_style FROM containers WHERE id=%s", (cid,))
    row = cur.fetchone()
    return clean_style(row["reply_style"] if row else None) or DEFAULT_REPLY_STYLE


def reply_style_for_prompt(cur, cid, *, task_id=None, agent_id=None) -> dict:
    """The ``reply_style`` block the protocol route sends the notifier: the project setting
    plus the task-thread override (when a task resolved) and the agent's active conversation
    override. The notifier picks the thread value by lane (notifier_reply_style.py)."""
    task = None
    if task_id:
        cur.execute("SELECT reply_style FROM tasks WHERE id=%s", (str(task_id),))
        row = cur.fetchone()
        task = clean_style(row["reply_style"]) if row else None
    conversation = None
    if agent_id:
        cur.execute("SELECT reply_style FROM conversations WHERE agent_id=%s AND status='active' "
                    "ORDER BY created_at DESC LIMIT 1", (str(agent_id),))
        row = cur.fetchone()
        conversation = clean_style(row["reply_style"]) if row else None
    return {"project": project_style(cur, cid), "task": task, "conversation": conversation}
