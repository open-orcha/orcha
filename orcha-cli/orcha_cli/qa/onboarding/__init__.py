"""What a project folder says about its apps, for QA onboarding's "We found" sheet (docs/orcha-qa-plan.md,
"Onboarding"). Adapted from `onboarding_map`, `cloud/repolib`, `cloud/folder_scan` and
`test_import`. Pure detection: no model, no device, no network, nothing run, stdlib only, so it
works without the `[qa]` extra.

    from orcha_cli.qa.onboarding import read_folder
    sheet = read_folder("/path/to/project")
"""

from __future__ import annotations

from orcha_cli.qa.onboarding.found import PLATFORM_ORDER, primary_platform, read_folder

__all__ = ["PLATFORM_ORDER", "primary_platform", "read_folder"]
