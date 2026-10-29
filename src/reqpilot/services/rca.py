"""Bug-Ursachenanalyse: welcher Change/Patch hat den ServiceNow-Bug wahrscheinlich ausgelöst?

Bewusst nachvollziehbar statt Blackbox: drei Signale mit festen Gewichten.
Das Ergebnis ist eine Hypothese für die Ursachenforschung, keine Schuldzuweisung.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np

from reqpilot.adapters.base import ChangeSource
from reqpilot.index.embedder import Embedder, tokens
from reqpilot.models import Bug, Change

WEIGHTS = {"komponente": 0.45, "zeit": 0.30, "text": 0.25}
PARTIAL_COMPONENT = 0.4
FULL_CONFIDENCE_SCORE = 0.7


@dataclass(frozen=True)
class RcaCandidate:
    change: Change
    score: float
    confidence: float
    signals: dict[str, float]
    reasons: list[str]


@dataclass
class RcaResult:
    bug: Bug
    candidates: list[RcaCandidate] = field(default_factory=list)
    conclusive: bool = False
    people: list[tuple[str, float]] = field(default_factory=list)


class RootCauseAnalyzer:
    def __init__(
        self,
        changes: ChangeSource,
        embedder: Embedder,
        window_days: int = 21,
        half_life_days: float = 4.0,
        min_score: float = 0.35,
        top: int = 5,
    ):
        self._changes = changes
        self._embedder = embedder
        self._window = window_days
        self._half_life = half_life_days
        self._min = min_score
        self._top = top

    def _component(self, bug: Bug, change: Change) -> float:
        if bug.component and bug.component.lower() in (c.lower() for c in change.components):
            return 1.0
        bug_tokens = set(tokens(f"{bug.short_description} {bug.description}"))
        return PARTIAL_COMPONENT if bug_tokens & set(tokens(" ".join(change.components))) else 0.0

    def _in_window(self, bug: Bug, change: Change) -> bool:
        days = (bug.first_seen - change.deployed_at).total_seconds() / 86400
        return 0 <= days <= self._window

    def analyze(self, bug: Bug) -> RcaResult:
        pool = [c for c in self._changes.changes() if self._in_window(bug, c)]
        if not pool:
            return RcaResult(bug)
        vectors = self._embedder.embed(
            [f"{bug.short_description}. {bug.description}"] + [f"{c.title}. {c.description}" for c in pool]
        )
        text_sims = np.clip(vectors[1:] @ vectors[0], 0.0, 1.0)

        raw = []
        for change, text_sim in zip(pool, text_sims, strict=True):
            days = (bug.first_seen - change.deployed_at).total_seconds() / 86400
            signals = {
                "komponente": self._component(bug, change),
                "zeit": round(0.5 ** (days / self._half_life), 4),
                "text": round(float(text_sim), 4),
            }
            score = sum(WEIGHTS[k] * v for k, v in signals.items())
            raw.append((change, score, signals, days))
        raw.sort(key=lambda r: r[1], reverse=True)
        raw = raw[: self._top]

        total = sum(r[1] for r in raw) or 1.0
        candidates = [
            RcaCandidate(
                change=change,
                score=round(score, 4),
                confidence=round((score / total) * min(1.0, score / FULL_CONFIDENCE_SCORE), 3),
                signals=signals,
                reasons=self._reasons(bug, change, signals, days),
            )
            for change, score, signals, days in raw
        ]
        people: dict[str, float] = defaultdict(float)
        for c in candidates:
            people[c.change.author] += c.confidence
        return RcaResult(
            bug=bug,
            candidates=candidates,
            conclusive=candidates[0].score >= self._min,
            people=sorted(((p, round(v, 3)) for p, v in people.items()), key=lambda x: x[1], reverse=True),
        )

    @staticmethod
    def _reasons(bug: Bug, change: Change, signals: dict[str, float], days: float) -> list[str]:
        reasons = []
        if signals["komponente"] == 1.0:
            reasons.append(f"Change betrifft dieselbe Komponente „{bug.component}“.")
        elif signals["komponente"] > 0:
            reasons.append("Change betrifft eine im Bug erwähnte Komponente.")
        reasons.append(f"Ausgerollt {days:.1f} Tage vor dem ersten Auftreten.")
        if signals["text"] >= 0.2:
            reasons.append("Beschreibung von Bug und Change ähneln sich inhaltlich.")
        return reasons
