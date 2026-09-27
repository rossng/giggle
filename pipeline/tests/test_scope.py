from datetime import datetime

import pytest

from giggle_pipeline.scope import exclusion_reason, load_rules
from podia import AMSTERDAM, Event, Status

RULES = load_rules()


def event(venue="melkweg", categories=(), genres=(), status=Status.SCHEDULED, room=None):
    return Event(
        venue=venue,
        source_id="x",
        title="Some Band",
        start=datetime(2026, 10, 16, 20, 30, tzinfo=AMSTERDAM),
        categories=list(categories),
        genres=list(genres),
        status=status,
        room=room,
    )


@pytest.mark.parametrize(
    ("e", "reason"),
    [
        (event(categories=["Concert"], genres=["Indie", "Pop"]), None),
        (event(status=Status.CANCELLED, categories=["Concert"]), "cancelled"),
        (event(categories=["Clubnacht"], genres=["Techno"]), "club night"),
        # A live band tagged with a club genre is still a concert.
        (event(categories=["Concert"], genres=["Electronic", "Drum & Bass"]), None),
        (event(categories=["Concert"], genres=["House"]), None),
        (event(venue="paradiso", genres=["Club - Techno/Hardcore"]), "club night"),
        (event(venue="tivolivredenburg", categories=["Chamber music"]), "classical"),
        (event(venue="muziekgebouw", genres=["hedendaags"]), "classical"),
        # Crossover shows filed under a popular genre stay.
        (event(venue="muziekgebouw", genres=["hedendaags", "jazz"]), None),
        (event(venue="patronaat", genres=["Klassiekers / Tributes"]), "tribute act"),
        (event(categories=["Film"]), "not music"),
        # Tolhuistuin files its weekly choir rehearsal under "Doorlopend" (ongoing).
        (event(venue="tolhuistuin", categories=["Doorlopend"], room="IJzaal"), "not music"),
        (event(venue="tivolivredenburg", categories=["Pop"], genres=["Comedy"]), "not music"),
        (event(venue="muziekgebouw"), "not music"),
        (event(venue="muziekgebouw", genres=["familie"]), "family / children"),
        # Untagged events at other venues are kept: many venues don't tag at all.
        (event(venue="occii", categories=["music"]), None),
        # Types in a venue's own words: whole words inside the label.
        (event(venue="nieuweanita", categories=["Comedy!"]), "not music"),
        (event(venue="nieuweanita", categories=["Movie screening!"]), "not music"),
        (event(venue="nieuweanita", categories=["Popquiz"]), "not music"),
        (event(venue="nieuweanita", categories=["Anita Monday!"]), "not music"),
        (event(venue="nieuweanita", categories=["Live!"]), None),
        (event(venue="nieuweanita", categories=["Listening session"]), None),
        (event(venue="nieuweanita", categories=["Acoustic café"]), None),
        (event(venue="nieuweanita", categories=["Gamelan"]), None),  # "game" as a word only
        (event(venue="qfactory", categories=["lezing"]), "not music"),
        (event(venue="zonnehuis", categories=["Rondleiding"]), "not music"),
        (event(venue="zonnehuis", categories=["Kinderen", "Muziek"]), "family / children"),
        (event(venue="zonnehuis", categories=["Divers"]), "not music"),
        (event(venue="zonnehuis", categories=["Divers", "Muziek"]), None),
        (event(venue="ekko", categories=["Overig"]), "not music"),
        (event(venue="ekko", genres=["club", "Pop"]), "club night"),
        (
            event(venue="qfactory", categories=["concert"], genres=["Dance", "Electronic"]),
            "club night",
        ),
        (event(venue="qfactory", categories=["concert"], genres=["Dance", "Pop"]), None),
        (event(venue="nieuweanita", categories=["DJ's all night!"]), "club night"),
        (event(venue="nieuweanita", categories=["Live + DJ!"]), None),
        (event(venue="ekko", categories=["Concert", "Overig"], genres=["rock"]), None),
    ],
)
def test_exclusion_reason(e, reason):
    assert exclusion_reason(e, RULES) == reason


def test_rules_reject_unknown_keys():
    with pytest.raises(ValueError, match="unknown keys"):
        load_rules('[[rule]]\nreason = "x"\ngenres = ["typo"]\n')
