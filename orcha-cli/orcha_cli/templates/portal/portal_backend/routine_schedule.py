"""Routine schedule math: a small 5-field cron evaluated in an IANA timezone.

Pure (no DB, no FastAPI) so the DST/timezone rules are unit-tested directly.

Grammar (standard 5-field cron, evaluated on the routine's LOCAL wall clock):
    minute hour day-of-month month day-of-week
  - each field: `*`, `N`, `A-B`, `*/S`, `A-B/S`, `N/S`, comma lists of those;
  - month and day-of-week accept names (JAN..DEC, SUN..SAT); day-of-week 0 and 7 are Sunday;
  - when BOTH day-of-month and day-of-week are restricted a day matches if EITHER does
    (Vixie-cron semantics).

Wall-clock rules around daylight-saving transitions (documented, tested):
  - a local time that does NOT exist (spring-forward gap, e.g. 02:30 on the night the
    clock jumps 02:00→03:00) fires at the equivalent instant just after the jump
    (02:30 is read with the pre-transition offset, i.e. 03:30 new time) — a daily routine
    is never silently skipped;
  - a local time that happens TWICE (fall-back overlap) fires ONCE, at its first
    occurrence — a daily routine never runs twice.

Plain-English descriptions ("Every weekday at 09:00 Nairobi time") are produced for the
preset shapes the UI offers; anything else is described honestly as a custom schedule.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = timezone.utc

# A routine creates real, human-gated tasks: forbid schedules that would flood the
# project. The finest preset is hourly; advanced cron may go down to this gap.
MIN_INTERVAL_MINUTES = 15

_MONTHS = {n: i + 1 for i, n in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}
_DOWS = {n: i for i, n in enumerate(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"])}
DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# How far ahead next_after() searches before declaring a schedule impossible
# (e.g. "0 0 31 2 *" — Feb 31st never happens).
_SEARCH_DAYS = 366 * 5


class ScheduleError(ValueError):
    """A cron expression or timezone the scheduler cannot honour. `user_message` is the
    validation text written for the person typing the schedule — the only part of the
    exception a route returns."""

    def __init__(self, user_message: str):
        super().__init__(user_message)
        self.user_message = user_message


@dataclass(frozen=True)
class Cron:
    expr: str
    minutes: tuple
    hours: tuple
    days: frozenset
    months: frozenset
    dows: frozenset
    dom_star: bool
    dow_star: bool

    def day_matches(self, d: date) -> bool:
        if d.month not in self.months:
            return False
        dom_ok = d.day in self.days
        dow_ok = (d.isoweekday() % 7) in self.dows  # isoweekday: Mon=1..Sun=7 → Sun=0
        if self.dom_star and self.dow_star:
            return True
        if self.dom_star:
            return dow_ok
        if self.dow_star:
            return dom_ok
        return dom_ok or dow_ok


def _atom(tok: str, lo: int, hi: int, names: dict | None, field: str) -> int:
    t = tok.strip().upper()
    if names and t in names:
        return names[t]
    if not t.isdigit():
        raise ScheduleError(f"'{tok}' is not valid in the {field} field")
    v = int(t)
    if v < lo or v > hi:
        raise ScheduleError(f"{field} value {v} is out of range {lo}-{hi}")
    return v


def _field(spec: str, lo: int, hi: int, field: str, names: dict | None = None) -> tuple[set, bool]:
    """Parse one cron field → (allowed values, was it a bare `*`)."""
    spec = spec.strip()
    if not spec:
        raise ScheduleError(f"the {field} field is empty")
    out: set = set()
    star = spec == "*"
    dow = field == "day-of-week"
    atom_hi = 7 if dow else hi  # day-of-week: 7 is an alias for Sunday
    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            if not s.isdigit() or int(s) < 1:
                raise ScheduleError(f"step '/{s}' is not valid in the {field} field")
            step = int(s)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            x, y = part.split("-", 1)
            a = _atom(x, lo, atom_hi, names, field)
            b = _atom(y, lo, atom_hi, names, field)
            if a > b:
                raise ScheduleError(f"range {part} runs backwards in the {field} field")
        else:
            a = _atom(part, lo, atom_hi, names, field)
            b = hi if step > 1 else a
        for v in range(a, b + 1, step):
            out.add(0 if (dow and v == 7) else v)
    return out, star


def parse_cron(expr: str) -> Cron:
    if not isinstance(expr, str):
        raise ScheduleError("schedule must be a cron expression")
    parts = expr.split()
    if len(parts) != 5:
        raise ScheduleError(
            "a schedule needs 5 fields: minute hour day-of-month month day-of-week"
        )
    mi, _ = _field(parts[0], 0, 59, "minute")
    hr, _ = _field(parts[1], 0, 23, "hour")
    dm, dom_star = _field(parts[2], 1, 31, "day-of-month")
    mo, _ = _field(parts[3], 1, 12, "month", _MONTHS)
    dw, dow_star = _field(parts[4], 0, 6, "day-of-week", _DOWS)
    return Cron(" ".join(parts), tuple(sorted(mi)), tuple(sorted(hr)), frozenset(dm),
                frozenset(mo), frozenset(dw), dom_star, dow_star)


def load_zone(name: str) -> ZoneInfo:
    if not name or not isinstance(name, str):
        raise ScheduleError("a timezone is required")
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        raise ScheduleError(f"unknown timezone '{name}'") from None


def _to_utc(local_naive: datetime, tz: ZoneInfo) -> datetime:
    """Local wall time → the UTC instant it fires at (fold=0: first occurrence of an
    ambiguous time; a non-existent time maps past the gap with the pre-jump offset)."""
    return local_naive.replace(tzinfo=tz, fold=0).astimezone(UTC)


def next_after(cron: Cron, tz: ZoneInfo, after: datetime) -> datetime | None:
    """The first fire instant strictly after `after` (aware), in UTC; None if never."""
    after = after.astimezone(UTC)
    wall = after.astimezone(tz).replace(tzinfo=None, second=0, microsecond=0)
    day = wall.date()
    for _ in range(_SEARCH_DAYS):
        if cron.day_matches(day):
            for h in cron.hours:
                for m in cron.minutes:
                    local = datetime.combine(day, time(h, m))
                    if local < wall:
                        continue
                    fire = _to_utc(local, tz)
                    if fire > after:
                        return fire
        day += timedelta(days=1)
    return None


def occurrences(cron: Cron, tz: ZoneInfo, start: datetime, end: datetime, cap: int = 1000) -> list:
    """Fire instants in [start, end] (inclusive), at most `cap` of them."""
    out = []
    cur = start.astimezone(UTC) - timedelta(microseconds=1)
    while len(out) < cap:
        nxt = next_after(cron, tz, cur)
        if nxt is None or nxt > end:
            break
        out.append(nxt)
        cur = nxt
    return out


def validate(expr: str, tz_name: str, *, now: datetime | None = None) -> tuple[Cron, ZoneInfo]:
    """Parse + enforce the flood guard; returns (cron, zone) or raises ScheduleError."""
    cron = parse_cron(expr)
    tz = load_zone(tz_name)
    now = now or datetime.now(UTC)
    first = next_after(cron, tz, now)
    if first is None:
        raise ScheduleError("this schedule never runs")
    prev, cur = first, first
    for _ in range(60):
        cur = next_after(cron, tz, prev)
        if cur is None:
            break
        if cur - prev < timedelta(minutes=MIN_INTERVAL_MINUTES):
            raise ScheduleError(
                f"routines may run at most every {MIN_INTERVAL_MINUTES} minutes — "
                "each run creates a real task"
            )
        prev = cur
    return cron, tz


# ---------------------------------------------------------------------------
# Plain English
# ---------------------------------------------------------------------------

def zone_label(tz_name: str) -> str:
    """'Africa/Nairobi' → 'Nairobi time'; 'UTC' → 'UTC'."""
    if tz_name in ("UTC", "Etc/UTC", "GMT", "Etc/GMT"):
        return "UTC"
    city = tz_name.rsplit("/", 1)[-1].replace("_", " ")
    return f"{city} time"


def _hhmm(h: int, m: int) -> str:
    return f"{h:02d}:{m:02d}"


def _ordinal(n: int) -> str:
    suf = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def describe(expr: str, tz_name: str) -> str:
    """Plain-English schedule text for the preset shapes; honest 'Custom' otherwise."""
    try:
        cron = parse_cron(expr)
    except ScheduleError:
        return "Invalid schedule"
    zl = zone_label(tz_name)
    f = expr.split()
    single_min = len(cron.minutes) == 1
    single_hr = len(cron.hours) == 1
    all_months = f[3] == "*"
    if single_min and f[1] == "*" and f[2] == "*" and all_months and f[4] == "*":
        return f"Every hour at :{cron.minutes[0]:02d}"
    if not (single_min and single_hr and all_months):
        return f"Custom schedule ({cron.expr}) {zl}"
    at = _hhmm(cron.hours[0], cron.minutes[0])
    if f[2] == "*" and f[4] == "*":
        return f"Every day at {at} {zl}"
    if f[2] == "*" and cron.dows == frozenset({1, 2, 3, 4, 5}):
        return f"Every weekday at {at} {zl}"
    if f[2] == "*" and cron.dows == frozenset({0, 6}):
        return f"Every Saturday and Sunday at {at} {zl}"
    if f[2] == "*" and len(cron.dows) == 1:
        return f"Every {DAY_NAMES[next(iter(cron.dows))]} at {at} {zl}"
    if f[4] == "*" and len(cron.days) == 1:
        return f"On the {_ordinal(next(iter(cron.days)))} of every month at {at} {zl}"
    return f"Custom schedule ({cron.expr}) {zl}"
