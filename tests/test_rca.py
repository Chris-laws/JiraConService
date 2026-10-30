from datetime import datetime, timedelta
from pathlib import Path

from reqpilot.adapters.mock import MockChangeSource, MockServiceNow
from reqpilot.index.embedder import HashingEmbedder
from reqpilot.models import Bug, Change
from reqpilot.services.rca import RootCauseAnalyzer

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


def test_window_boundaries_are_inclusive():
    seen = datetime(2026, 10, 22)
    same_time = Change("C0", "Kasse", "Kasse", "A", seen, ("kasse",), "u")
    edge = Change("C21", "Kasse", "Kasse", "B", seen - timedelta(days=21), ("kasse",), "u")
    outside = Change("C22", "Kasse", "Kasse", "C", seen - timedelta(days=22), ("kasse",), "u")
    bug = Bug("INC1", "Kasse", "Kasse", "kasse", seen, "u")
    ids = {c.change.id for c in analyzer([same_time, edge, outside]).analyze(bug).candidates}
    assert ids == {"C0", "C21"}


def test_reasons_reflect_signals():
    seen = datetime(2026, 10, 20)
    bug = Bug("INC1", "Kassenbon Druck fehlerhaft", "Bondrucker an der Kasse druckt leer", "kasse", seen, "u")
    full = Change(
        "C1",
        "Bondrucker Treiber",
        "Bondrucker an der Kasse neu",
        "A",
        seen - timedelta(days=1),
        ("kasse",),
        "u",
    )
    partial = Change("C2", "Update", "Wartung", "B", seen - timedelta(days=1), ("bondrucker",), "u")
    none = Change("C3", "Update", "Wartung", "C", seen - timedelta(days=1), ("lager",), "u")
    by_id = {c.change.id: c for c in analyzer([full, partial, none]).analyze(bug).candidates}
    assert by_id["C1"].signals["komponente"] == 1.0
    assert any("dieselbe Komponente" in r for r in by_id["C1"].reasons)
    assert any("ähneln sich" in r for r in by_id["C1"].reasons)
    assert by_id["C2"].signals["komponente"] == 0.4
    assert any("erwähnte Komponente" in r for r in by_id["C2"].reasons)
    assert by_id["C3"].signals["komponente"] == 0.0
    assert not any("Komponente" in r for r in by_id["C3"].reasons)
    assert not any("ähneln sich" in r for r in by_id["C3"].reasons)


def test_inconclusive_threshold_is_inclusive():
    seen = datetime(2026, 10, 20)
    change = Change("C1", "x", "y", "A", seen, ("kasse",), "u")
    bug = Bug("INC1", "q", "r", "kasse", seen, "u")
    result = analyzer([change]).analyze(bug)
    score = result.candidates[0].score

    class Src:
        def changes(self):
            return [change]

    assert RootCauseAnalyzer(Src(), HashingEmbedder(), min_score=score).analyze(bug).conclusive is True
    assert RootCauseAnalyzer(Src(), HashingEmbedder(), min_score=score + 0.01).analyze(bug).conclusive is False
