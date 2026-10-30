"""Innovation feature 1 — never say only "no".

A rejection is a lost sale. When a request cannot be placed, this module finds
the nearest times that *can* be placed and offers them back to the client.

Candidate generation is the interesting part. Scanning every 15-minute slot
from 08:30 to 21:30 works but does redundant work: between two consecutive
booking boundaries nothing changes, so the only start times worth testing are
the ones where the occupancy picture changes.

For a day with k confirmed bookings we test at most 2k + 1 candidates:
  * the first legal start of the day,
  * for each booking, starting right as its reserved interval ends,
  * for each booking, ending right as its reserved interval begins.

Each candidate is then run through the real allocator, so a suggestion is never
a guess — it is a slot the engine has already confirmed it would accept.
"""

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.allocator import Decision, Demand, allocate
from app.core.rules import (
    EARLIEST_START_MIN,
    LATEST_END_MIN,
    LOAD_IN_MIN,
    LOAD_OUT_MIN,
    fmt,
)
from app.models import CONFIRMED, Booking

MAX_SUGGESTIONS = 4
LOOKAHEAD_DAYS = 3


@dataclass
class Suggestion:
    event_date: date
    start_min: int
    end_min: int
    venue_id: str
    hall_id: str
    note: str

    @property
    def time_text(self) -> str:
        return f"{fmt(self.start_min)} – {fmt(self.end_min)}"


def _day_boundaries(session: Session, event_date: date) -> list[int]:
    bookings = session.scalars(
        select(Booking).where(
            Booking.event_date == event_date, Booking.status == CONFIRMED
        )
    )
    points: set[int] = set()
    for booking in bookings:
        points.add(booking.reserved_start)
        points.add(booking.reserved_end)
    return sorted(points)


def _candidate_starts(session: Session, demand: Demand) -> list[int]:
    duration = demand.end_min - demand.start_min
    # The two legal edges of the day matter on their own: when a request is
    # refused for running past closing, the useful answer is usually "start half
    # an hour earlier", which is no booking's boundary.
    candidates = {EARLIEST_START_MIN, LATEST_END_MIN - duration}

    for point in _day_boundaries(session, demand.event_date):
        # start as soon as someone else's hold ends
        candidates.add(point + LOAD_IN_MIN)
        # finish just before someone else's hold begins
        candidates.add(point - LOAD_OUT_MIN - duration)

    legal = [
        start
        for start in candidates
        if start >= EARLIEST_START_MIN and start + duration <= LATEST_END_MIN
    ]
    legal.sort(key=lambda start: (abs(start - demand.start_min), start))
    return legal


def suggest_alternatives(
    session: Session,
    demand: Demand,
    exclude_ids: tuple[int, ...] = (),
    limit: int = MAX_SUGGESTIONS,
) -> list[Suggestion]:
    """Nearest slots the allocator would actually accept."""
    duration = demand.end_min - demand.start_min
    found: list[Suggestion] = []
    seen: set[tuple[date, int]] = set()

    def consider(event_date: date, start_min: int, note: str) -> None:
        if len(found) >= limit or (event_date, start_min) in seen:
            return
        seen.add((event_date, start_min))
        trial = Demand(
            event_date=event_date,
            start_min=start_min,
            end_min=start_min + duration,
            attendees=demand.attendees,
            preferred_venue_id=demand.preferred_venue_id,
            projectors=demand.projectors,
            audio_systems=demand.audio_systems,
            staff=demand.staff,
        )
        decision: Decision = allocate(session, trial, exclude_ids=exclude_ids)
        if decision.ok and decision.venue_id and decision.hall_id:
            found.append(
                Suggestion(
                    event_date=event_date,
                    start_min=start_min,
                    end_min=start_min + duration,
                    venue_id=decision.venue_id,
                    hall_id=decision.hall_id,
                    note=note,
                )
            )

    # same day, nearest first
    for start in _candidate_starts(session, demand):
        shift = start - demand.start_min
        if shift == 0:
            note = "same slot, different venue"
        elif shift > 0:
            note = f"{_minutes_text(shift)} later"
        else:
            note = f"{_minutes_text(-shift)} earlier"
        consider(demand.event_date, start, note)
        if len(found) >= limit:
            return found

    # same time, following days
    for offset in range(1, LOOKAHEAD_DAYS + 1):
        consider(
            demand.event_date + timedelta(days=offset),
            demand.start_min,
            "same time" + (" next day" if offset == 1 else f", {offset} days later"),
        )
        if len(found) >= limit:
            break

    return found


def _minutes_text(minutes: int) -> str:
    hours, mins = divmod(minutes, 60)
    if hours and mins:
        return f"{hours}h {mins}m"
    if hours:
        return f"{hours}h"
    return f"{mins} min"
