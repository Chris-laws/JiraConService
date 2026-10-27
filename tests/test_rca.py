from datetime import datetime, timedelta
from pathlib import Path

from lidlalign.adapters.mock import MockChangeSource, MockServiceNow
from lidlalign.index.embedder import HashingEmbedder
from lidlalign.models import Bug, Change
from lidlalign.services.rca import RootCauseAnalyzer

FIX = Path(__file__).resolve().parents[1] / "fixtures"


def analyzer(changes=None):
    class Src:
        def changes(self):
            return changes

    return RootCauseAnalyzer(Src() if changes is not None else MockChangeSource(FIX), HashingEmbedder())


def test_rounding_bug_points_to_rounding_patch_and_author():
    bug = MockServiceNow(FIX).bug("INC0041871")
    result = analyzer().analyze(bug)
    top = result.candidates[0]
    assert result.conclusive is True
    assert top.change.id == "CHG0030110"
    assert result.people[0][0] == "Felix Hartmann"
    assert 0 < top.confidence <= 1
    assert top.confidence > result.candidates[1].confidence
    assert set(top.signals) == {"komponente", "zeit", "text"}
    assert top.reasons


def test_changes_after_first_seen_are_ignored():
    bug = MockServiceNow(FIX).bug("INC0041902")
    ids = [c.change.id for c in analyzer().analyze(bug).candidates]
    assert "CHG0030130" not in ids
    assert ids[0] == "CHG0030111"


def test_changes_outside_window_are_ignored():
    bug = MockServiceNow(FIX).bug("INC0041871")
    assert "CHG0029900" not in [c.change.id for c in analyzer().analyze(bug).candidates]


def test_bug_without_matching_change_is_inconclusive():
    result = analyzer().analyze(MockServiceNow(FIX).bug("INC0042010"))
    assert result.conclusive is False


def test_no_changes_at_all():
    bug = Bug("INC1", "x", "y", "kasse", datetime(2026, 10, 1), "u")
    result = analyzer([]).analyze(bug)
    assert result.candidates == []
    assert result.conclusive is False
    assert result.people == []


def test_time_signal_decays():
    seen = datetime(2026, 10, 20)
    near = Change("C1", "Kasse Update", "Kasse", "A", seen - timedelta(days=1), ("kasse",), "u")
    far = Change("C2", "Kasse Update", "Kasse", "B", seen - timedelta(days=10), ("kasse",), "u")
    bug = Bug("INC1", "Kasse Fehler", "Kasse", "kasse", seen, "u")
    result = analyzer([far, near]).analyze(bug)
    assert result.candidates[0].change.id == "C1"
    assert result.candidates[0].signals["zeit"] > result.candidates[1].signals["zeit"]
