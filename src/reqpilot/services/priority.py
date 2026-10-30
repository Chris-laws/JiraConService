"""Prüft die gewählte Priorität gegen den Ticket-Text ("Ist das wirklich ein Blocker?").

Bewusst regelbasiert und nachvollziehbar: jede Empfehlung nennt die Signale, auf denen sie beruht.
Die Entscheidung bleibt bei der Person, das Tool weist nur auf Widersprüche hin.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_STOPPAGE = re.compile(
    r"\b(stillstand|steht still|ausfall|fällt aus|kann nicht arbeiten|können nicht arbeiten|"
    r"nicht mehr möglich|geht nicht mehr|blockiert)\b",
    re.I,
)
_NO_WORKAROUND = re.compile(r"\b(kein(en)? workaround|keine umgehung|keine alternative)\b", re.I)
_WORKAROUND = re.compile(r"\b(workaround|manuell|umgehung|übergangsweise)\b", re.I)
_BREADTH = re.compile(r"\b(alle filialen|alle länder|alle lager|flächendeckend|gesamte[nrs]?)\b", re.I)
_IMPACT = re.compile(
    r"\b(umsatz|frist|gesetzlich|compliance|falsche[n]? (menge|bestellung)|fehlbestand|aktionsstart|kunden)\b",
    re.I,
)
_COMFORT = re.compile(r"\b(wäre schön|nice to have|komfort|optisch|darstellung|irgendwann|optional)\b", re.I)


@dataclass(frozen=True)
class PriorityAdvice:
    recommended: str
    reasons: tuple[str, ...]
    chosen: str

    @property
    def agrees(self) -> bool:
        return self.recommended == self.chosen


class PriorityAdvisor:
    def __init__(self, priorities: list[str]):
        # Reihenfolge aus settings.yaml: höchste zuerst, z. B. Blocker, High, Medium, Low
        self._priorities = priorities

    def assess(self, text: str, chosen: str) -> PriorityAdvice:
        reasons: list[str] = []
        stoppage = bool(_STOPPAGE.search(text))
        no_workaround = bool(_NO_WORKAROUND.search(text))
        workaround = bool(_WORKAROUND.search(text)) and not no_workaround
        broad = bool(_BREADTH.search(text))
        impact = bool(_IMPACT.search(text))
        comfort = bool(_COMFORT.search(text))

        if stoppage and not workaround:
            level = "Blocker"
            reasons.append("Der Text beschreibt einen Stillstand ohne Umgehung.")
        elif stoppage:
            level = "High"
            reasons.append("Es gibt einen Stillstand, aber auch eine Umgehung. Das spricht gegen Blocker.")
        elif impact or broad:
            level = "High"
            if impact:
                reasons.append("Es geht um Umsatz, Fristen oder falsche Mengen.")
            if broad:
                reasons.append("Betroffen sind viele Standorte oder Länder.")
        elif comfort:
            level = "Low"
            reasons.append("Der Text beschreibt eine Verbesserung des Komforts oder der Darstellung.")
        else:
            level = "Medium"
            reasons.append("Kein Hinweis auf Stillstand, Fristen oder breite Betroffenheit.")

        if chosen == "Blocker" and level != "Blocker":
            reasons.append("Blocker nur, wenn die Arbeit steht und es keine Umgehung gibt.")
        recommended = level if level in self._priorities else chosen
        return PriorityAdvice(recommended=recommended, reasons=tuple(reasons), chosen=chosen)
