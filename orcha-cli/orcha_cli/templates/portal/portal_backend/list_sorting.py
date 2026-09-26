"""Validate and build stable SQL ordering for paginated portal lists."""

from typing import Optional

from fastapi import HTTPException


def validate_sort(sort: Optional[str], sort_dir: Optional[str]) -> None:
    if sort is not None and sort not in ("priority", "time"):
        raise HTTPException(400, "sort must be 'priority' or 'time'")
    if sort_dir is not None and sort_dir not in ("asc", "desc"):
        raise HTTPException(400, "dir must be 'asc' or 'desc'")


def sort_clause(
    sort: Optional[str],
    sort_dir: Optional[str],
    *,
    bucket: str,
    time_col: str,
    prio_col: str,
    id_col: str,
    default: str,
) -> str:
    if sort is None:
        return default
    if sort == "time":
        direction = "ASC" if sort_dir == "asc" else "DESC"
        return f"ORDER BY {bucket}, {time_col} {direction}, {prio_col} ASC, {id_col}"
    direction = "DESC" if sort_dir == "desc" else "ASC"
    return f"ORDER BY {bucket}, {prio_col} {direction}, {time_col} DESC, {id_col}"
