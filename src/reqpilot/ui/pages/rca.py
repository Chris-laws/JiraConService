"""Bug-Ursachenanalyse für ServiceNow-Bugs."""

import pandas as pd
import streamlit as st

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.ui.components import confidence_badge, page_header, section
from reqpilot.ui.i18n import t
from reqpilot.ui.state import get_container

c = get_container()

page_header("rca")
st.info(t("rca.disclaimer"), icon=":material/balance:")

try:
    bugs = c.servicenow.bugs()
except SourceUnavailable as exc:
    st.error(t("error.source", detail=str(exc)))
    st.stop()

if not bugs:
    st.info(t("rca.no_bugs"), icon=":material/inbox:")
    st.stop()

pick, go = st.columns([4, 1], vertical_alignment="bottom")
bug = pick.selectbox(
    t("rca.pick_bug"),
    bugs,
    format_func=lambda b: f"{b.number} · {b.short_description}",
    help=t("rca.pick_bug_help"),
)
if go.button(t("rca.submit"), type="primary", icon=":material/troubleshoot:", width="stretch"):
    st.session_state["rca_bug"] = bug.number

if st.session_state.get("rca_bug") != bug.number:
    st.stop()

try:
    with st.spinner(t("rca.working")):
        result = c.rca.analyze(bug)
except SourceUnavailable as exc:
    st.error(t("error.source", detail=str(exc)))
    st.stop()

with st.container(border=True):
    st.markdown(t("rca.bug_line", number=bug.number, url=bug.url, component=bug.component))
    st.caption(bug.description)

if not result.conclusive:
    st.warning(t("rca.inconclusive"), icon=":material/help:")
else:
    top = result.candidates[0]
    cause, people = st.columns([3, 2], gap="large")
    with cause, st.container(border=True):
        st.caption(t("rca.top_label"))
        st.subheader(top.change.title)
        confidence_badge(top.confidence)
        st.markdown(t("rca.top_meta", change=top.change.id, release=top.change.release or "–"))
        for reason in top.reasons:
            st.markdown(f":material/check_small: {reason}")
    with people, st.container(border=True):
        st.markdown(f"**{t('rca.people')}**")
        for person, conf in result.people[:3]:
            st.progress(min(conf, 1.0), text=t("rca.person_row", person=person, pct=round(conf * 100)))

if result.candidates:
    section("rca.candidates", "rca.candidates_help")
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
            t("rca.col_confidence"): st.column_config.ProgressColumn(min_value=0, max_value=100, format="%d %%"),
            t("rca.col_deployed"): st.column_config.DatetimeColumn(format="DD.MM.YYYY HH:mm"),
        },
    )

try:
    related = c.index.search(f"{bug.short_description}. {bug.description}", k=3, min_score=c.thresholds["similar"])
except SourceUnavailable as exc:
    related = []
    st.error(t("error.source", detail=str(exc)))
if related:
    section("rca.related")
    for hit in related:
        st.markdown(t("rca.related_row", title=hit.title, url=hit.url, source=hit.source))
