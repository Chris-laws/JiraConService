from pathlib import Path

import numpy as np

from reqpilot.adapters.mock import MockConfluence, MockJira
from reqpilot.index.embedder import HashingEmbedder, tokens
from reqpilot.index.vector_index import IndexItem, VectorIndex, build_knowledge_index

FIX = Path(__file__).resolve().parents[1] / "fixtures"


def test_hashing_embedder_is_deterministic_and_normalized():
    e = HashingEmbedder()
    a, b = e.embed(["Bestellvorschlag Filiale", "Bestellvorschlag Filiale"])
    assert np.allclose(a, b)
    assert abs(np.linalg.norm(a) - 1) < 1e-5
    assert np.linalg.norm(e.embed([""])[0]) == 0


def test_compounds_and_inflections_are_similar():
    e = HashingEmbedder()
    v = e.embed(["Bestellvorschläge prüfen", "Bestellvorschlag prüfen", "Handscanner Anmeldung"])
    assert v[0] @ v[1] > 0.6
    assert v[0] @ v[2] < 0.2


def test_stopwords_removed():
    assert "der" not in tokens("der Bestand und die Filiale")


def test_index_search_orders_by_similarity():
    idx = build_knowledge_index(MockJira(FIX), MockConfluence(FIX), HashingEmbedder())
    assert len(idx) == 15
    hits = idx.search("Teillieferungen im Wareneingang erfassen", k=3)
    assert hits[0].id == "ADF-1021"
    assert hits[0].score >= hits[1].score


def test_empty_index_and_empty_query():
    idx = VectorIndex(HashingEmbedder())
    assert idx.search("x") == []
    idx.add([IndexItem("1", "Bestand", "T", "u", "jira", {})])
    assert idx.search("   ") == []
