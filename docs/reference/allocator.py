"""The allocation engine.

One entry point, `allocate()`, answers a single question: can this request be
placed, and if not, exactly why not. Nothing in here writes to the database —
it is a pure decision function over the current confirmed bookings, which is
what makes it reusable for rescheduling (exclude yourself), for the waitlist
(replay a pending request), for the suggester (try a hypothetical time) and
for the tests.

Order of checks, cheapest and most decisive first:

  1. Operating hours   — reserved interval must fit inside 08:00-22:00.
  2. Venue stock       — does the venue even own this many projectors?
  3. Hall capacity     — is there a hall large enough at all?
  4. Hall availability — is such a hall free for the reserved interval?
  5. Resource load     — sweep line over concurrent bookings at that venue.

A hall is chosen by smallest sufficient capacity (best fit), ties broken by
hall id ascending, so the same inputs always produce the same allocation.
"""

from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.intervals import Load, peak_load
from app.core.rules import (
    CLOSING_MIN,
    EARLIEST_START_MIN,
    LATEST_END_MIN,
    OPENING_MIN,
    RESOURCE_KINDS,
    RESOURCE_LABELS,
    fmt,
    overlaps,
    reserved_window,
)
from app.models import CONFIRMED, Booking, Hall, Venue


@dataclass
class Demand:
    """A request, independent of whether it is stored yet."""

    event_date: date
    start_min: int
    end_min: int
    attendees: int
    preferred_venue_id: str | None = None
    projectors: int = 0
    audio_systems: int = 0
    staff: int = 0

    def requested(self, kind: str) -> int:
        return getattr(self, kind)

    @property
    def reserved(self) -> tuple[int, int]:
        return reserved_window(self.start_min, self.end_min)

    @classmethod
    def from_booking(cls, booking: Booking) -> "Demand":
        return cls(
            event_date=booking.event_date,
            start_min=booking.start_min,
            end_min=booking.end_min,
            attendees=booking.attendees,
            preferred_venue_id=booking.preferred_venue_id,
            projectors=booking.req_projectors,
            audio_systems=booking.req_audio_systems,
            staff=booking.req_staff,
        )


@dataclass
class VenueVerdict:
    """What happened when we tried one venue."""

    venue_id: str
    ok: bool
    hall_id: str | None = None
    notes: list[str] = field(default_factory=list)
    was_preferred: bool = False


@dataclass
class Decision:
    ok: bool
    headline: str
    venue_id: str | None = None
    hall_id: str | None = None
    hall_capacity: int | None = None
    verdicts: list[VenueVerdict] = field(default_factory=list)
    blocker: str = ""  # hours | capacity | hall | resources | none

    @property
    def detail(self) -> str:
        lines = []
        for verdict in self.verdicts:
            for note in verdict.notes:
                lines.append(f"Venue {verdict.venue_id}: {note}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# step 1 — operating hours
# ---------------------------------------------------------------------------


def check_operating_hours(demand: Demand) -> str | None:
    if demand.end_min <= demand.start_min:
        return "The event must end after it starts."
    reserved_start, reserved_end = demand.reserved
    if reserved_start < OPENING_MIN or reserved_end > CLOSING_MIN:
        return (
            f"With 30 minutes of setup and 30 of clearing, this booking holds the hall "
            f"{fmt(reserved_start)}–{fmt(reserved_end)}, which falls outside operating "
            f"hours ({fmt(OPENING_MIN)}–{fmt(CLOSING_MIN)}). "
            f"Events can run between {fmt(EARLIEST_START_MIN)} and {fmt(LATEST_END_MIN)}."
        )
    return None


# ---------------------------------------------------------------------------
# lookups
# ---------------------------------------------------------------------------


def venue_search_order(session: Session, preferred_venue_id: str | None) -> list[Venue]:
    """Preferred venue first, then the rest by id — a fixed, explainable order."""
    venues = list(session.scalars(select(Venue).order_by(Venue.id)))
    if not preferred_venue_id:
        return venues
    preferred = [v for v in venues if v.id == preferred_venue_id]
    others = [v for v in venues if v.id != preferred_venue_id]
    return preferred + others


def confirmed_bookings(
    session: Session,
    venue_id: str,
    event_date: date,
    exclude_ids: tuple[int, ...] = (),
) -> list[Booking]:
    """Confirmed bookings at one venue on one day.

    `exclude_ids` is what makes rescheduling correct: a booking must not be
    treated as a conflict with its own current allocation.
    """
    stmt = select(Booking).where(
        Booking.venue_id == venue_id,
        Booking.event_date == event_date,
        Booking.status == CONFIRMED,
    )
    if exclude_ids:
        stmt = stmt.where(Booking.id.notin_(exclude_ids))
    return list(session.scalars(stmt))


def overlapping(bookings: list[Booking], window: tuple[int, int]) -> list[Booking]:
    start, end = window
    return [b for b in bookings if overlaps(start, end, b.reserved_start, b.reserved_end)]


# ---------------------------------------------------------------------------
# step 5 — shared resources
# ---------------------------------------------------------------------------


def resource_shortfalls(
    venue: Venue,
    neighbours: list[Booking],
    demand: Demand,
    window: tuple[int, int],
) -> list[str]:
    """Check every resource kind across the whole reserved interval.

    For each kind we build one Load per concurrent booking and sweep. The peak
    is the worst instant in the window; if peak + requested exceeds stock, the
    booking cannot be confirmed even though it might look free at its start.
    """
    window_start, window_end = window
    problems: list[str] = []

    for kind in RESOURCE_KINDS:
        wanted = demand.requested(kind)
        if wanted <= 0:
            continue

        stock = venue.stock(kind)
        label = RESOURCE_LABELS[kind]
        plural = f"{label}s" if not label.endswith("staff") else label

        if wanted > stock:
            problems.append(
                f"the venue owns {stock} {plural} in total and {wanted} were requested"
            )
            continue

        loads = [
            Load(b.reserved_start, b.reserved_end, b.requested(kind), b.title)
            for b in neighbours
            if b.requested(kind) > 0
        ]
        peak = peak_load(loads, window_start, window_end)
        if peak.amount + wanted > stock:
            free = max(stock - peak.amount, 0)
            held_by = ", ".join(peak.contributors[:3])
            problems.append(
                f"{free} of {stock} {plural} free between {fmt(peak.start)} and "
                f"{fmt(peak.end)}, {wanted} requested"
                + (f" (held by {held_by})" if held_by else "")
            )
    return problems


# ---------------------------------------------------------------------------
# main entry point
# ---------------------------------------------------------------------------


def allocate(
    session: Session,
    demand: Demand,
    exclude_ids: tuple[int, ...] = (),
) -> Decision:
    hours_problem = check_operating_hours(demand)
    if hours_problem:
        return Decision(ok=False, headline=hours_problem, blocker="hours")

    window = demand.reserved
    verdicts: list[VenueVerdict] = []
    saw_capacity_problem = False
    saw_resource_problem = False
    saw_busy_hall = False

    for venue in venue_search_order(session, demand.preferred_venue_id):
        verdict = VenueVerdict(
            venue_id=venue.id,
            ok=False,
            was_preferred=(venue.id == demand.preferred_venue_id),
        )

        halls = sorted(
            [h for h in venue.halls if h.capacity >= demand.attendees],
            key=lambda h: (h.capacity, h.id),
        )
        if not halls:
            largest = max((h.capacity for h in venue.halls), default=0)
            verdict.notes.append(
                f"largest hall seats {largest}, {demand.attendees} guests expected"
            )
            verdicts.append(verdict)
            saw_capacity_problem = True
            continue

        neighbours_all = confirmed_bookings(session, venue.id, demand.event_date, exclude_ids)
        neighbours = overlapping(neighbours_all, window)

        shortfalls = resource_shortfalls(venue, neighbours, demand, window)
        if shortfalls:
            verdict.notes.extend(shortfalls)
            verdicts.append(verdict)
            saw_resource_problem = True
            continue

        chosen: Hall | None = None
        busy_notes: list[str] = []
        for hall in halls:
            clash = next((b for b in neighbours if b.hall_id == hall.id), None)
            if clash is None:
                chosen = hall
                break
            busy_notes.append(
                f"{hall.id} ({hall.capacity}) is held "
                f"{fmt(clash.reserved_start)}–{fmt(clash.reserved_end)} for "
                f"\u201c{clash.title}\u201d"
            )

        if chosen is None:
            saw_busy_hall = True
            verdict.notes.extend(busy_notes)
            verdicts.append(verdict)
            continue

        verdict.ok = True
        verdict.hall_id = chosen.id
        verdicts.append(verdict)
        return Decision(
            ok=True,
            headline=(
                f"Hall {chosen.id} at Venue {venue.id} "
                f"(seats {chosen.capacity}) held {fmt(window[0])}–{fmt(window[1])}"
            ),
            venue_id=venue.id,
            hall_id=chosen.id,
            hall_capacity=chosen.capacity,
            verdicts=verdicts,
        )

    # Summarise with the blocker that actually stood in the way. A hall that is
    # big enough but busy is a different message from no big enough hall at all.
    if saw_busy_hall:
        blocker = "hall"
        headline = (
            f"Every hall that seats {demand.attendees} is already held for part of "
            f"{fmt(window[0])}–{fmt(window[1])}."
        )
    elif saw_resource_problem:
        blocker = "resources"
        headline = "Equipment or support staff run short at every venue for this interval."
    else:
        blocker = "capacity"
        headline = f"No hall at any venue seats {demand.attendees} guests."

    return Decision(ok=False, headline=headline, verdicts=verdicts, blocker=blocker)
