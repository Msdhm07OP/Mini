"""Scheduling rules that the whole system agrees on.

Every time in EventSync is stored as an integer number of minutes from
midnight. Comparing and overlapping integers is exact and O(1); it keeps
timezone and float issues out of the allocation logic entirely.
"""

OPENING_MIN = 8 * 60       # 08:00
CLOSING_MIN = 22 * 60      # 22:00

# Crew needs the hall before guests arrive and after they leave. The hall and
# every allocated resource are held for this buffer on both sides of the event.
LOAD_IN_MIN = 30
LOAD_OUT_MIN = 30

# Earliest/latest an *event* may run so that its reserved interval still fits
# inside operating hours: 08:30 and 21:30.
EARLIEST_START_MIN = OPENING_MIN + LOAD_IN_MIN
LATEST_END_MIN = CLOSING_MIN - LOAD_OUT_MIN

RESOURCE_KINDS = ("projectors", "audio_systems", "staff")

RESOURCE_LABELS = {
    "projectors": "projector",
    "audio_systems": "audio system",
    "staff": "support staff",
}


def reserved_window(start_min: int, end_min: int) -> tuple[int, int]:
    """Event times -> the interval the hall and resources are actually held."""
    return start_min - LOAD_IN_MIN, end_min + LOAD_OUT_MIN


def overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    """Half-open overlap: touching intervals (one ends as the other starts)
    do not conflict, because the buffers are already baked into both."""
    return a_start < b_end and b_start < a_end


def fmt(minutes: int) -> str:
    """960 -> '4:00 PM'. Handles values outside the day for error messages."""
    minutes = int(minutes)
    hour, minute = divmod(minutes % (24 * 60), 60)
    suffix = "AM" if hour < 12 else "PM"
    display_hour = hour % 12 or 12
    return f"{display_hour}:{minute:02d} {suffix}"


def fmt24(minutes: int) -> str:
    """960 -> '16:00'. Used on the timeline ruler where columns must align."""
    hour, minute = divmod(int(minutes) % (24 * 60), 60)
    return f"{hour:02d}:{minute:02d}"


def parse_hhmm(value: str) -> int:
    """'14:30' -> 870. Accepts the HTML time input format."""
    value = (value or "").strip()
    if not value:
        raise ValueError("Enter a time.")
    parts = value.split(":")
    if len(parts) < 2:
        raise ValueError(f"'{value}' is not a valid time.")
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        raise ValueError(f"'{value}' is not a valid time.") from None
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise ValueError(f"'{value}' is not a valid time.")
    return hour * 60 + minute


def duration_text(start_min: int, end_min: int) -> str:
    total = end_min - start_min
    hours, minutes = divmod(total, 60)
    if hours and minutes:
        return f"{hours}h {minutes}m"
    if hours:
        return f"{hours}h"
    return f"{minutes}m"
