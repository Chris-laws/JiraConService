"""Meine Tickets: eigene Anforderungen aus Jira, nur Lesezugriff."""

import pandas as pd
import streamlit as st

from lidlalign.adapters.errors import SourceUnavailable
from lidlalign.ui.i18n import t
from lidlalign.ui.state import get_container, header_user

c = get_container()

st.title(t("mine.title"))
st.caption(t("mine.intro"))

user = header_user()
if not user:
    reporters = c.jira.reporters() if hasattr(c.jira, "reporters") else []
    user = st.selectbox(t("mine.pick_user"), reporters, help=t("mine.pick_user_help")) if reporters else ""
    user = user or st.text_input(t("mine.email"), help=t("mine.email_help"))
else:
    st.markdown(t("mine.signed_in", user=user))


@st.cache_data(ttl=300, show_spinner=False)
def _load(email: str):
    return c.my_tickets.for_user(email)


if st.button(t("mine.refresh"), icon=":material/refresh:"):
    _load.clear()

try:
    rows = _load(user or "")
except SourceUnavailable as exc:
    st.error(t("error.source", detail=str(exc)))
    st.stop()

if not rows:
    st.info(t("mine.empty"))
    st.stop()

done = sum(r.issue.status == "DONE" for r in rows)
rejected = sum(r.phase is None for r in rows)
m1, m2, m3 = st.columns(3)
m1.metric(t("mine.total"), len(rows))
m2.metric(t("mine.open"), len(rows) - done - rejected)
m3.metric(t("mine.done"), done)

table = pd.DataFrame(
    [
        {
            t("mine.col_key"): r.issue.url,
            t("mine.col_summary"): r.issue.summary,
            t("mine.col_status"): r.issue.status,
            t("mine.col_phase"): round(100 * (r.phase or 0) / r.phase_total),
            t("mine.col_stream"): r.issue.stream or "",
            t("mine.col_updated"): r.issue.updated,
        }
        for r in rows
    ]
)
st.dataframe(
    table,
    hide_index=True,
    use_container_width=True,
    column_config={
        t("mine.col_key"): st.column_config.LinkColumn(display_text=r"/browse/(.*)$"),
        t("mine.col_phase"): st.column_config.ProgressColumn(min_value=0, max_value=100, format="%d %%"),
        t("mine.col_updated"): st.column_config.DatetimeColumn(format="DD.MM.YYYY HH:mm"),
    },
)
st.caption(t("mine.readonly"))
