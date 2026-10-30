"""Wissensabfrage über Jira und Confluence, als Chat. Links das Gespräch, rechts Vorschläge."""

import streamlit as st

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.ui.components import card_title, page_header
from reqpilot.ui.i18n import t
from reqpilot.ui.state import get_container

c = get_container()
SUGGESTIONS = ("knowledge.suggest_1", "knowledge.suggest_2", "knowledge.suggest_3")

page_header("knowledge")
history: list[dict] = st.session_state.setdefault("knowledge_history", [])


def _take_suggestion() -> None:
    """Vorschlag einmalig übernehmen und die Auswahl zurücksetzen, sonst würde er bei jedem Rerun neu gefragt."""
    st.session_state["knowledge_pending"] = st.session_state.get("knowledge_pick")
    st.session_state["knowledge_pick"] = None


def _suggestions() -> None:
    st.pills(
        t("knowledge.suggestions_label"),
        SUGGESTIONS,
        format_func=t,
        key="knowledge_pick",
        on_change=_take_suggestion,
        help=t("knowledge.help"),
    )
    st.caption(t("knowledge.sources_hint"))


if not history:
    # Erster Besuch: ein Block mit Frage, Vorschlägen und Eingabe, keine leere Chatfläche
    with st.container(key="card_start"):
        st.markdown(f"### {t('knowledge.empty_title')}")
        st.caption(t("knowledge.empty_text"))
        typed = st.chat_input(t("knowledge.placeholder"))
        _suggestions()
else:
    chat_col, side = st.columns([8, 4])
    with side, st.container(key="card_suggest"):
        card_title("knowledge.suggestions", "knowledge.help")
        _suggestions()
        st.markdown(f"**{t('knowledge.asked')}**")
        st.markdown("\n".join(f"- {turn['question']}" for turn in reversed(history)))
        with st.container(key="foot_clear"):
            if st.button(t("knowledge.clear"), icon=":material/delete_sweep:", width="stretch"):
                history.clear()
                st.rerun()
    with chat_col:
        with st.container(key="card_chat", height=520, border=False):
            for turn in history:
                with st.chat_message("user", avatar=":material/person:"):
                    st.markdown(turn["question"])
                with st.chat_message("assistant", avatar=":material/auto_awesome:"):
                    if turn.get("notice"):
                        st.caption(turn["notice"])
                    st.markdown(turn["answer"])
                    for n, (title, url, source) in enumerate(turn["sources"], 1):
                        st.caption(t("knowledge.source_row", n=n, title=title, url=url, source=source))
        typed = st.chat_input(t("knowledge.placeholder"))

pending = st.session_state.pop("knowledge_pending", None)
question = typed or (t(pending) if pending else None)
if question and question.strip():
    try:
        with st.spinner(t("knowledge.working")):
            answer = c.knowledge.ask(question)
    except SourceUnavailable as exc:
        st.error(t("error.source", detail=str(exc)))
        st.stop()
    history.append(
        {
            "question": question,
            "answer": answer.text,
            "notice": answer.notice,
            "sources": [(h.title, h.url, h.source) for h in answer.sources],
        }
    )
    st.rerun()
