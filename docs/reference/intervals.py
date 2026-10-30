"""Interval arithmetic for shared-resource checking.

The hard part of EventSync is not "do two events overlap" — it is "across the
whole window I want, does the number of projectors in simultaneous use ever
exceed what the venue owns". That is a maximum-concurrent-load problem, and a
sweep line answers it exactly.

Checking only at the requested start instant is the classic wrong answer: a
booking that starts later but inside your window can still push the venue over
its limit.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Load:
    """A quantity of one resource held over a half-open interval."""

    start: int
    end: int
    amount: int
    label: str = ""


@dataclass(frozen=True)
class Peak:
    """The worst moment inside the queried window."""

    amount: int
    start: int
    end: int
    contributors: tuple[str, ...] = ()


def peak_load(loads: list[Load], window_start: int, window_end: int) -> Peak:
    """Maximum simultaneous `amount` at any instant inside the window.

    Sweep line: every interval boundary that falls inside the window becomes a
    cut point. Between two consecutive cut points the set of active intervals
    cannot change, so one sample per segment is enough.

    Complexity: O(n log n) for the sort, O(n) per segment scan.
    """
    if window_end <= window_start:
        return Peak(0, window_start, window_end)

    relevant = [
        load
        for load in loads
        if load.amount > 0 and load.start < window_end and window_start < load.end
    ]
    if not relevant:
        return Peak(0, window_start, window_end)

    cuts = {window_start, window_end}
    for load in relevant:
        if window_start < load.start < window_end:
            cuts.add(load.start)
        if window_start < load.end < window_end:
            cuts.add(load.end)
    points = sorted(cuts)

    best = Peak(0, window_start, window_end)
    for left, right in zip(points, points[1:]):
        active = [load for load in relevant if load.start < right and left < load.end]
        total = sum(load.amount for load in active)
        if total > best.amount:
            best = Peak(
                amount=total,
                start=left,
                end=right,
                contributors=tuple(dict.fromkeys(a.label for a in active if a.label)),
            )
    return best


def free_gaps(
    busy: list[tuple[int, int]], window_start: int, window_end: int, minimum: int = 0
) -> list[tuple[int, int]]:
    """Merge busy intervals and return the gaps left inside the window.

    Used by the timeline view and by the alternative-slot suggester to describe
    where a hall is actually open.
    """
    clipped = sorted(
        (max(start, window_start), min(end, window_end))
        for start, end in busy
        if start < window_end and window_start < end
    )

    merged: list[list[int]] = []
    for start, end in clipped:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    gaps: list[tuple[int, int]] = []
    cursor = window_start
    for start, end in merged:
        if start - cursor >= max(minimum, 1):
            gaps.append((cursor, start))
        cursor = max(cursor, end)
    if window_end - cursor >= max(minimum, 1):
        gaps.append((cursor, window_end))
    return gaps
