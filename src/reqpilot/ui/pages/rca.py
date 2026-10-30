"""Bug-Ursachenanalyse für ServiceNow-Bugs. Links Auswahl und Bug, rechts die Analyse."""

import pandas as pd
import streamlit as st

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.ui.components import card_title, confidence_badge, page_header
from reqpilot.ui.i18n import t
from reqpilot.ui.state import get_container

c = get_container()
RECENT_ROWS = 6

page_header("rca")

try:
    bugs = c.servicenow.bugs()
except SourceUnavailable as exc:
    st.error(t("error.source", detail=str(exc)))
    st.stop()

if not bugs:
    st.info(t("rca.no_bugs"), icon=":material/inbox:")
    st.stop()

side, main = st.columns([4, 8])

with side, st.container(key="card_bug"):
    card_title("rca.pick_title", "rca.disclaimer")
    bug = st.selectbox(
        t("rca.pick_bug"),
        bugs,
        format_func=lambda b: f"{b.number} · {b.short_description}",
        help=t("rca.pick_bug_help"),
    )
    if st.button(t("rca.submit"), type="primary", icon=":material/troubleshoot:", width="stretch"):
        st.session_state["rca_bug"] = bug.number
    st.markdown(t("rca.bug_line", number=bug.number, url=bug.url, component=bug.component))
    st.caption(bug.description)

if st.session_state.get("rca_bug") != bug.number:
    with main, st.container(key="card_changes"):
        card_title("rca.changes_title", "rca.empty_text")
        try:
            changes = sorted(c.changes.changes(), key=lambda ch: ch.deployed_at, reverse=True)[:RECENT_ROWS]
        except SourceUnavailable as exc:
            changes = []
            st.error(t("error.source", detail=str(exc)))
        for ch in changes:
            st.markdown(
                t(
                    "rca.change_row",
                    id=ch.id,
                    url=ch.url,
                    title=ch.title,
                    component=", ".join(ch.components) or "–",
                    date=ch.deployed_at.strftime("%d.%m.%Y"),
                )
            )
    st.stop()

try:
    with st.spinner(t("rca.working")):
        result = c.rca.analyze(bug)
except SourceUnavailable as exc:
    main.error(t("error.source", detail=str(exc)))
    st.stop()

try:
    related = c.index.search(f"{bug.short_description}. {bug.description}", k=3, min_score=c.thresholds["similar"])
except SourceUnavailable as exc:
    related = []
    side.error(t("error.source", detail=str(exc)))
if related:
    with side, st.container(key="card_related"):
        card_title("rca.related")
        for hit in related:
            st.markdown(t("rca.related_row", title=hit.title, url=hit.url, source=hit.source))

with main:
    if not result.conclusive:
        st.warning(t("rca.inconclusive"), icon=":material/help:")
    else:
        top = result.candidates[0]
        cause, people = st.columns([3, 2])
        with cause, st.container(key="card_cause"):
            st.caption(t("rca.top_label"))
            st.subheader(top.change.title)
            confidence_badge(top.confidence)
            st.markdown(t("rca.top_meta", change=top.change.id, release=top.change.release or "–"))
            st.markdown("\n".join(f":material/check_small: {reason}  " for reason in top.reasons))
        with people, st.container(key="card_people"):
            card_title("rca.people")
            for person, conf in result.people[:3]:
                st.progress(min(conf, 1.0), text=t("rca.person_row", person=person, pct=round(conf * 100)))

    if result.candidates:
        with st.container(key="card_candidates"):
            card_title("rca.candidates", "rca.candidates_help")
            st.dataframe(
                pd.DataFrame(
                    [
                        {
                            t("rca.col_change"): cand.change.id,
                            t("rca.col_title"): cand.change.title,
                            t("rca.col_author"): cand.change.author,
                            t("rca.col_deployed"): cand.change.deployed_at,
                            t("rca.col_component"): cand.signals["komponente"],
                            t("rca.col_time"): cand.signals["zeit"],
                            t("rca.col_text"): cand.signals["text"],
                            t("rca.col_confidence"): round(cand.confidence * 100),
                        }
                        for cand in result.candidates
                    ]
                ),
                hide_index=True,
                width="stretch",
                column_config={
                    t("rca.col_component"): st.column_config.NumberColumn(format="%.2f"),
                    t("rca.col_time"): st.column_config.NumberColumn(format="%.2f"),
                    t("rca.col_text"): st.column_config.NumberColumn(format="%.2f"),
                    t("rca.col_confidence"): st.column_config.ProgressColumn(
                        min_value=0, max_value=100, format="%d %%"
                    ),
                    t("rca.col_deployed"): st.column_config.DatetimeColumn(format="DD.MM.YYYY HH:mm"),
                },
            )
