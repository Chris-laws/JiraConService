"""Formt Freitext in das einheitliche Ticketformat (User Story + Akzeptanzkriterien)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from lidlalign.adapters.base import Llm
from lidlalign.adapters.errors import LlmUnavailable
from lidlalign.privacy import redact

MIN_WORDS = 5
TITLE_MAX = 80

Q_DETAILS = "Bitte beschreibe die Anforderung genauer: Was soll sich ändern, für wen und warum?"
Q_BENEFIT = "Welchen Nutzen hat die Änderung (damit …)?"
Q_CRITERIA = "Woran erkennt man, dass die Anforderung erfüllt ist? (Akzeptanzkriterien)"

_ROLE = re.compile(r"\bals\s+([\wÄÖÜäöüß-]+(?:\s[\wÄÖÜäöüß-]+)?)\s+(?:möchte|will|brauche|benötige)", re.I)
_GOAL = re.compile(r"(?:möchte|will|brauche|benötige)\s+ich\s+(.+?)(?:,?\s+(?:damit|um)\s|[.!?]|$)", re.I)
_BENEFIT = re.compile(r"\b(?:damit|um)\s+(.+?)(?:[.!?]|$)", re.I)
_CRITERION = re.compile(r"\b(soll|sollen|muss|müssen|darf|dürfen)\b", re.I)
_SENTENCE = re.compile(r"(?<=[.!?])\s+")

_PRIORITY_RULES = (
    ("Blocker", re.compile(r"\b(blocker|blockiert|stillstand|kann nicht arbeiten|können nicht)\b", re.I)),
    ("High", re.compile(r"\b(dringend|kritisch|sofort|heute)\b", re.I)),
    ("Low", re.compile(r"\b(wäre schön|nice to have|irgendwann|optional)\b", re.I)),
)

PROMPT = """Du bist Assistent im Anforderungsmanagement. Forme die Anforderung in das Standardformat.
Regeln: Erfinde nichts. Fehlende Angaben gehören in "open_questions". Priorität nur aus: {priorities}.
Antworte nur mit JSON mit den Feldern:
title (max. 80 Zeichen), role, goal, benefit, acceptance_criteria (Liste), background, priority, open_questions (Liste).
Land: {country}
Anforderung:
\"\"\"{text}\"\"\""""


@dataclass
class TicketDraft:
    title: str
    role: str
    goal: str
    benefit: str
    acceptance_criteria: list[str]
    background: str
    priority: str
    country: str
    open_questions: list[str] = field(default_factory=list)
    source: str = "offline"  # "gemini" | "offline"
    notice: str = ""

    def as_text(self) -> str:
        """Text für Ähnlichkeitssuche und Stream-Zuordnung."""
        return " ".join([self.title, self.goal, self.benefit, self.background, *self.acceptance_criteria])


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text) if s.strip()]


def _title(text: str) -> str:
    first = _sentences(text)[0] if text else "Neue Anforderung"
    first = first.rstrip(".!?")
    return first if len(first) <= TITLE_MAX else first[: TITLE_MAX - 1].rstrip() + "…"


def _str_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()]


class TicketWriter:
    def __init__(self, llm: Llm, priorities: list[str], default_priority: str):
        self._llm = llm
        self._priorities = priorities
        self._default = default_priority

    def draft(self, text: str, country: str) -> TicketDraft:
        text = " ".join(text.split())
        if self._llm.available and len(text.split()) >= MIN_WORDS:
            try:
                return self._from_llm(text, country)
            except (LlmUnavailable, ValueError, TypeError) as exc:
                d = self._offline(text, country)
                d.notice = f"KI nicht nutzbar ({exc}); Entwurf wurde offline erstellt."
                return d
        return self._offline(text, country)

    def _priority(self, value: str | None) -> str:
        return value if value in self._priorities else self._default

    def _from_llm(self, text: str, country: str) -> TicketDraft:
        prompt = PROMPT.format(priorities=", ".join(self._priorities), country=country, text=redact(text))
        data = json.loads(self._llm.generate(prompt, json_mode=True))
        if not isinstance(data, dict) or not str(data.get("title", "")).strip():
            raise ValueError("KI-Antwort hat kein gültiges Ticket")
        return TicketDraft(
            title=str(data["title"]).strip()[:TITLE_MAX],
            role=str(data.get("role") or "").strip(),
            goal=str(data.get("goal") or "").strip(),
            benefit=str(data.get("benefit") or "").strip(),
            acceptance_criteria=_str_list(data.get("acceptance_criteria")),
            background=str(data.get("background") or text).strip(),
            priority=self._priority(data.get("priority")),
            country=country,
            open_questions=_str_list(data.get("open_questions")),
            source="gemini",
        )

    def _offline(self, text: str, country: str) -> TicketDraft:
        if len(text.split()) < MIN_WORDS:
            return TicketDraft(
                title=_title(text) if text else "Neue Anforderung",
                role="",
                goal=text,
                benefit="",
                acceptance_criteria=[],
                background=text,
                priority=self._default,
                country=country,
                open_questions=[Q_DETAILS],
            )
        role = m.group(1).strip() if (m := _ROLE.search(text)) else ""
        goal = m.group(1).strip() if (m := _GOAL.search(text)) else _title(text)
        benefit = m.group(1).strip() if (m := _BENEFIT.search(text)) else ""
        criteria = [s.rstrip(".") for s in _sentences(text) if _CRITERION.search(s)]
        questions = []
        if not benefit:
            questions.append(Q_BENEFIT)
        if not criteria:
            questions.append(Q_CRITERIA)
        priority = next((p for p, rx in _PRIORITY_RULES if rx.search(text)), self._default)
        return TicketDraft(
            title=_title(text),
            role=role or f"Fachanwender ({country})",
            goal=goal,
            benefit=benefit,
            acceptance_criteria=criteria,
            background=text,
            priority=self._priority(priority),
            country=country,
            open_questions=questions,
        )


def to_jira_markup(draft: TicketDraft, stream_name: str | None = None, epic_key: str | None = None) -> str:
    lines = [f"h2. {draft.title}", "", "h3. User Story"]
    lines.append(f"*Als* {draft.role} *möchte ich* {draft.goal}, *damit* {draft.benefit or '…'}.")
    lines += ["", "h3. Akzeptanzkriterien"]
    lines += [f"* {c}" for c in draft.acceptance_criteria] or ["* (noch offen)"]
    lines += ["", "h3. Fachlicher Hintergrund", draft.background, "", "h3. Einordnung"]
    lines.append(f"Land: {draft.country}")
    lines.append(f"Priorität: {draft.priority}")
    if stream_name:
        lines.append(f"Stream: {stream_name}")
    if epic_key:
        lines.append(f"Epic: {epic_key}")
    if draft.open_questions:
        lines += ["", "h3. Offene Fragen"] + [f"# {q}" for q in draft.open_questions]
    return "\n".join(lines)
