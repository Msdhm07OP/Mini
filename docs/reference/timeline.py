"""Innovation feature 3 — make the schedule and the resource load visible.

The allocator's reasoning is invisible by nature: it says yes or no. This
module projects the same data the allocator reads onto a 08:00-22:00 ruler, so
an operator can see *why* a slot is tight — including the setup and clearing
buffers, which are normally the hidden cause of a refusal.

Everything is returned as percentages so the template is pure layout and the
positioning maths stays testable here.
"""

from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.intervals import Load, peak_load
from app.core.rules import (
    CLOSING_MIN,
    LOAD_IN_MIN,
    OPENING_MIN,
    RESOURCE_KINDS,
    RESOURCE_LABELS,
    fmt,
    fmt24,
)
from app.models import CONFIRMED, Booking, Venue

DAY_SPAN = CLOSING_MIN - OPENING_MIN  # 840 minutes on screen


def _pct(minutes: int) -> float:
    return round((minutes - OPENING_MIN) / DAY_SPAN * 100, 4)


def _width(minutes: int) -> float:
    return round(minutes / DAY_SPAN * 100, 4)


@dataclass
class Block:
    """One booking drawn on a hall row."""

    booking_id: int
    title: str
    client: str
    left: float
    width: float
    setup_width: float      # % of the block taken by load-in
    clear_width: float      # % of the block taken by load-out
    time_text: str
    reserved_text: str
    attendees: int


@dataclass
class HallRow:
    hall_id: str
    capacity: int
    blocks: list[Block] = field(default_factory=list)


@dataclass
class LoadSegment:
    left: float
    width: float
    used: int
    stock: int
    height: float  # % of the strip height
    full: bool


@dataclass
class ResourceStrip:
    kind: str
    label: str
    stock: int
    peak: int
    segments: list[LoadSegment] = field(default_factory=list)


@dataclass
class VenueBoard:
    venue_id: str
    venue_name: str
    rows: list[HallRow] = field(default_factory=list)
    strips: list[ResourceStrip] = field(default_factory=list)
    booked_count: int = 0


def hour_ticks() -> list[dict]:
    return [
        {"left": _pct(minute), "label": fmt24(minute)}
        for minute in range(OPENING_MIN, CLOSING_MIN + 1, 60)
    ]


def build_board(session: Session, event_date: date) -> list[VenueBoard]:
    venues = list(session.scalars(select(Venue).order_by(Venue.id)))
    bookings = list(
        session.scalars(
            select(Booking).where(
                Booking.event_date == event_date, Booking.status == CONFIRMED
            )
        )
    )

    boards: list[VenueBoard] = []
    for venue in venues:
        mine = [b for b in bookings if b.venue_id == venue.id]
        board = VenueBoard(
            venue_id=venue.id,
            venue_name=venue.name,
            booked_count=len(mine),
        )

        for hall in sorted(venue.halls, key=lambda h: h.id):
            row = HallRow(hall_id=hall.id, capacity=hall.capacity)
            for booking in sorted(
                (b for b in mine if b.hall_id == hall.id), key=lambda b: b.start_min
            ):
                span = booking.reserved_end - booking.reserved_start
                row.blocks.append(
                    Block(
                        booking_id=booking.id,
                        title=booking.title,
                        client=booking.client.name if booking.client else "",
                        left=_pct(booking.reserved_start),
                        width=_width(span),
                        setup_width=round(LOAD_IN_MIN / span * 100, 4),
                        clear_width=round(LOAD_IN_MIN / span * 100, 4),
                        time_text=f"{fmt(booking.start_min)} – {fmt(booking.end_min)}",
                        reserved_text=(
                            f"held {fmt(booking.reserved_start)} – {fmt(booking.reserved_end)}"
                        ),
                        attendees=booking.attendees,
                    )
                )
            board.rows.append(row)

        for kind in RESOURCE_KINDS:
            stock = venue.stock(kind)
            loads = [
                Load(b.reserved_start, b.reserved_end, b.requested(kind), b.title)
                for b in mine
                if b.requested(kind) > 0
            ]
            strip = ResourceStrip(
                kind=kind,
                label=RESOURCE_LABELS[kind].replace("support staff", "support staff"),
                stock=stock,
                peak=peak_load(loads, OPENING_MIN, CLOSING_MIN).amount,
            )

            cuts = {OPENING_MIN, CLOSING_MIN}
            for load in loads:
                cuts.add(max(load.start, OPENING_MIN))
                cuts.add(min(load.end, CLOSING_MIN))
            points = sorted(cuts)

            for left, right in zip(points, points[1:]):
                used = sum(
                    load.amount for load in loads if load.start < right and left < load.end
                )
                if used == 0:
                    continue
                strip.segments.append(
                    LoadSegment(
                        left=_pct(left),
                        width=_width(right - left),
                        used=used,
                        stock=stock,
                        height=round(min(used / stock, 1) * 100, 2) if stock else 0,
                        full=used >= stock,
                    )
                )
            board.strips.append(strip)

        boards.append(board)
    return boards
