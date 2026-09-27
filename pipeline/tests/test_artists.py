import pytest

from giggle_pipeline.artists import names_from_text


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
