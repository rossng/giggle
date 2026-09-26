import pytest

from giggle_pipeline.artists import artists_for, names_from_text


@pytest.mark.parametrize(
    ("title", "names"),
    [
        ("Soft Gravel + Velvet Tram", ["Soft Gravel", "Velvet Tram"]),
        ("Hyphen Dash ft. Diana Sidibé", ["Hyphen Dash", "Diana Sidibé"]),
        ("Blanks • Haarlem Vinyl Festival", ["Blanks"]),
        ("The Pelumas – 023jazz", ["The Pelumas"]),
        ("TisDass (Niger)", ["TisDass"]),
        ("Uitverkocht: Snelle", ["Snelle"]),
        ("Discover: Ronker + Grote Geelstaart", ["Ronker", "Grote Geelstaart"]),
        ("néomí + support", ["néomí"]),
        # "and" / "&" stay: they are usually part of a band's name.
        ("Declan Welsh and The Decadent West", ["Declan Welsh and The Decadent West"]),
        ("Cato van Dijck & Anton Goudsmit", ["Cato van Dijck & Anton Goudsmit"]),
    ],
)
def test_names_from_text(title, names):
    assert names_from_text(title) == names


def test_title_leads_then_performers_and_support_without_repeats():
    gig = {
        "title": "Flat Earth Society - The Coltrane Mutations",
        "performers": ["Peter Vandenberghe", "Flat Earth Society"],
        "support": ["Ferry Lights"],
    }
    assert artists_for(gig) == ["Flat Earth Society", "Peter Vandenberghe", "Ferry Lights"]
