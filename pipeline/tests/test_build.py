import json
from pathlib import Path

from giggle_pipeline.build import main

FIXTURES = Path(__file__).parents[2] / "packages" / "podia" / "tests" / "fixtures"


def test_offline_build_writes_consistent_outputs(tmp_path):
    assert main(["--replay", str(FIXTURES), "--out", str(tmp_path)]) == 0
    site = json.loads((tmp_path / "gigs.json").read_text())
    excluded = json.loads((tmp_path / "excluded.json").read_text())
    health = json.loads((tmp_path / "health.json").read_text())

    gigs = site["gigs"]
    assert len(gigs) > 100
    ids = [g["id"] for g in gigs] + [e["id"] for e in excluded]
    assert len(ids) == len(set(ids)), "every event is either kept or excluded, once"
    assert all(e["reason"] for e in excluded)
    assert set(site["venues"]) == set(health["venues"])
    assert health["problems"] == []
    assert not (tmp_path / "health-history.json").exists(), "replays don't touch the baseline"
