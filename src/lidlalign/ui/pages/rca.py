"""Bug-Ursachenanalyse für ServiceNow-Bugs."""

import pandas as pd
import streamlit as st

from lidlalign.adapters.errors import SourceUnavailable
from lidlalign.ui.i18n import t
from lidlalign.ui.state import get_container
from lidlalign.ui.theme import confidence_label

c = get_container()

st.title(t("rca.title"))
st.caption(t("rca.intro"))

try:
    bugs = c.servicenow.bugs()
except SourceUnavailable as exc:
    st.error(t("error.source", detail=str(exc)))
    st.stop()

if not bugs:
    st.info(t("rca.no_bugs"))
    st.stop()

bug = st.selectbox(
    t("rca.pick_bug"),
    bugs,
    format_func=lambda b: f"{b.number} · {b.short_description}",
    help=t("rca.pick_bug_help"),
)

if not st.button(t("rca.submit"), type="primary"):
    st.stop()

try:
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
    st.success(
        t(
            "rca.top",
            change=top.change.id,
            title=top.change.title,
            release=top.change.release or "–",
            pct=round(top.confidence * 100),
            word=confidence_label(top.confidence),
        ),
        icon=":material/target:",
    )
    for reason in top.reasons:
        st.markdown(f"- {reason}")
    st.markdown(f"**{t('rca.people')}**")
    for person, conf in result.people[:3]:
        st.progress(min(conf, 1.0), text=t("rca.person_row", person=person, pct=round(conf * 100)))

if result.candidates:
    st.markdown(f"**{t('rca.candidates')}**")
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
    st.markdown(f"**{t('rca.related')}**")
    for hit in related:
        st.markdown(t("knowledge.source_row", n="•", title=hit.title, url=hit.url, source=hit.source))

st.caption(t("rca.disclaimer"))
