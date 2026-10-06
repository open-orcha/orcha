"""Personal (non-agent) sessions: the user's own terminal tabs in Orcha Desktop.

Orcha Desktop sets ``ORCHA_PERSONAL_SESSION=1`` in the env of every pty it launches.
A Claude started in such a tab still runs the project's SessionStart/SessionEnd hooks,
but it is the USER's session, not an Orcha agent: the hooks that bind or inject an
agent identity (``rehydrate`` — "you are Atlas (Architect)", ``watch`` — the agent's
inbox poller, ``poll-inbox`` — surfacing that inbox, ``unwatch`` — killing the folder's
watchers, ``task-claim-guard`` — posting to the portal AS the bound agent) exit 0
silently. Infrastructure hooks (notifier/bridge ``--ensure``, reachability,
file-guard) keep working.

Managed embodiments must never inherit the marker — a daemon started from a personal
tab would otherwise hand it to every worker / paired terminal it later spawns — so
every Orcha spawn path passes its env through :func:`strip`.
"""

from __future__ import annotations

import os
from typing import Mapping, MutableMapping, Optional

ENV = "ORCHA_PERSONAL_SESSION"


def active(env: Optional[Mapping[str, str]] = None) -> bool:
    """True inside a personal desktop tab (the marker is exactly ``"1"``)."""
    return (os.environ if env is None else env).get(ENV) == "1"


def strip(env: MutableMapping[str, str]) -> MutableMapping[str, str]:
    """Drop the marker from a child env (in place) and return it."""
    env.pop(ENV, None)
    return env
