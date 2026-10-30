from pathlib import Path

import pytest

from reqpilot.adapters.mock import MockConfluence, MockJira
from reqpilot.index.embedder import HashingEmbedder
from reqpilot.index.vector_index import build_knowledge_index
from reqpilot.models import Epic, Stream
from reqpilot.services.classifier import StreamClassifier
from reqpilot.services.duplicates import DuplicateChecker
from reqpilot.streams import StreamRegistry, load_app_config

ROOT = Path(__file__).resolve().parents[1]
CFG = load_app_config(ROOT / "config" / "settings.yaml")
TH = CFG.thresholds("hashing")


@pytest.fixture(scope="module")
def classifier():
    reg = StreamRegistry.from_yaml(ROOT / "config" / "streams.yaml")
    return StreamClassifier(reg, HashingEmbedder(), TH)


@pytest.fixture(scope="module")
def checker():
    idx = build_knowledge_index(MockJira(ROOT / "fixtures"), MockConfluence(ROOT / "fixtures"), HashingEmbedder())
    return DuplicateChecker(idx, TH)


@pytest.mark.parametrize(
    ("text", "stream"),
    [
        ("Der Bestellvorschlag soll regionale Feiertage je Land berücksichtigen", "disposition"),
        ("Im Wareneingang sollen Teillieferungen einer Palette erfasst werden", "logistik"),
        ("Neuer Bericht mit Kennzahlen zu Abschriften als Export", "reporting"),
        ("Doppelte EAN im Artikelstamm beim Anlegen eines Artikels verhindern", "stammdaten"),
    ],
)
def test_top_stream(classifier, text, stream):
    result = classifier.classify(text)
    assert result.suggestions[0].stream.id == stream
    assert result.multi_stream is False
    assert result.uncertain is False


def test_confidences_sum_to_one_and_top3(classifier):
    result = classifier.classify("Bestellvorschlag für Aktionsartikel")
    assert len(result.suggestions) == 3
    assert abs(sum(s.confidence for s in classifier.classify("Bestand").all_scores) - 1) < 1e-6
    assert result.suggestions[0].confidence >= result.suggestions[1].confidence


def test_reasons_name_matching_keywords(classifier):
    top = classifier.classify("Der Bestellvorschlag ignoriert den Mindestbestand").suggestions[0]
    assert "Bestellvorschlag" in top.matched_keywords
    assert "Mindestbestand" in top.matched_keywords


def test_epic_suggested_within_top_stream(classifier):
    result = classifier.classify("Retouren und Abschriften bei Warenverlust automatisieren")
    assert result.suggestions[0].stream.id == "logistik"
    assert result.epic and result.epic.key == "ADF-201"


def test_multi_stream_detected_and_split_proposed(classifier):
    text = (
        "Bei Lieferantenwechsel soll die Gebindegröße im Artikelstamm aktualisiert werden. "
        "Der Bestellvorschlag soll die neue Gebindegröße bei der Bestellmenge nutzen."
    )
    result = classifier.classify(text)
    assert result.multi_stream is True
    assert {p.stream.id for p in result.split_proposal} == {"stammdaten", "disposition"}
    assert all(p.text for p in result.split_proposal)


def test_unrelated_text_is_uncertain(classifier):
    result = classifier.classify("Kantine soll vegetarisches Essen anbieten")
    assert result.uncertain is True
    assert result.multi_stream is False


def test_stream_without_epics_gives_no_epic():
    reg = StreamRegistry([Stream("x", "Kasse", "Kassensystem Bon Zahlung", ("Kasse",), epics=())])
    result = StreamClassifier(reg, HashingEmbedder(), TH).classify("Kasse Bon Zahlung mit Karte")
    assert result.epic is None
    assert len(result.suggestions) == 1


def test_epic_exists_for_registry_with_epics():
    reg = StreamRegistry([Stream("x", "Kasse", "Kassensystem", ("Kasse",), epics=(Epic("K-1", "Zahlung"),))])
    assert StreamClassifier(reg, HashingEmbedder(), TH).classify("Kasse Zahlung").epic == Epic("K-1", "Zahlung")


def test_near_identical_ticket_is_duplicate(checker):
    hits = checker.check("Teillieferungen einer Palette im Wareneingang der Filiale erfassen, Restmengen sichtbar")
    assert hits[0].hit.id == "ADF-1021"
    assert hits[0].level == "duplicate"


def test_related_content_is_similar_not_duplicate(checker):
    hits = checker.check("Kennzahlen für Abschriften als Bericht")
    assert hits
    assert all(h.level in {"duplicate", "similar"} for h in hits)
    assert hits[0].level == "similar"


def test_unrelated_text_has_no_hits(checker):
    assert checker.check("Kantine soll vegetarisches Essen anbieten") == []


class FixedEmbedder:
    """Liefert vorgegebene Vektoren, um Schwellwerte exakt zu testen."""

    name = "fixed"

    def __init__(self, mapping):
        self.mapping = mapping

    def embed(self, texts):
        import numpy as np

        return np.array([self.mapping.get(t, [0.0, 0.0, 1.0]) for t in texts], dtype=float)


def _two_stream_classifier(query_vec, th):
    a = Stream("a", "A", "a", epics=())
    b = Stream("b", "B", "b", epics=())
    emb = FixedEmbedder({a.profile_text(): [1.0, 0.0, 0.0], b.profile_text(): [0.0, 1.0, 0.0], "q": query_vec})
    return StreamClassifier(StreamRegistry([a, b]), emb, th)


def test_ratio_rule_needs_second_stream_above_minimum():
    th = {**TH, "multi_stream_ratio": 0.8, "multi_stream_min": 0.3}
    assert _two_stream_classifier([0.5, 0.45, 0.0], th).classify("q").multi_stream is True
    assert _two_stream_classifier([0.5, 0.29, 0.0], th).classify("q").multi_stream is False
    assert _two_stream_classifier([0.5, 0.3, 0.0], {**th, "multi_stream_ratio": 0.6}).classify("q").multi_stream
