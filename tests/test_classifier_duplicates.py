from pathlib import Path

import pytest

from lidlalign.adapters.mock import MockConfluence, MockJira
from lidlalign.index.embedder import HashingEmbedder
from lidlalign.index.vector_index import build_knowledge_index
from lidlalign.models import Epic, Stream
from lidlalign.services.classifier import StreamClassifier
from lidlalign.services.duplicates import DuplicateChecker
from lidlalign.streams import StreamRegistry, load_app_config

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
