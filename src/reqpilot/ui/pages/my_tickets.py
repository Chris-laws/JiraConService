"""Meine Tickets: eigene Anforderungen aus Jira, nur Lesezugriff."""

import pandas as pd
import streamlit as st

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.ui.components import page_header
from reqpilot.ui.i18n import t
from reqpilot.ui.state import get_container, header_user

c = get_container()
FILTERS = ("all", "open", "done", "rejected")

page_header("mine")

user = header_user()
top_left, top_right = st.columns([3, 1], vertical_alignment="bottom")
if user:
    top_left.markdown(t("mine.signed_in", user=user))
else:
    reporters = c.jira.reporters() if hasattr(c.jira, "reporters") else []
    if reporters:
        user = top_left.selectbox(t("mine.pick_user"), reporters, help=t("mine.pick_user_help"))
    else:
        user = top_left.text_input(t("mine.email"), help=t("mine.email_help"))


@st.cache_data(ttl=300, show_spinner=False)
def _load(email: str):
    return c.my_tickets.for_user(email)


if top_right.button(t("mine.refresh"), icon=":material/refresh:", width="stretch"):
    _load.clear()

try:
    rows = _load(user or "")
except SourceUnavailable as exc:
    st.error(t("error.source", detail=str(exc)))
    st.stop()

if not rows:
    st.info(t("mine.empty"), icon=":material/inbox:")
    st.stop()


def _bucket(row) -> str:
    if row.phase is None:
        return "rejected"
    return "done" if row.issue.status == "DONE" else "open"


counts = {f: sum(_bucket(r) == f for r in rows) for f in FILTERS[1:]}
m1, m2, m3, m4 = st.columns(4)
m1.metric(t("mine.total"), len(rows), border=True)
m2.metric(t("mine.open"), counts["open"], border=True)
m3.metric(t("mine.done"), counts["done"], border=True)
m4.metric(t("mine.rejected"), counts["rejected"], border=True)

choice = st.segmented_control(
    t("mine.filter"), FILTERS, default="all", format_func=lambda f: t(f"mine.filter_{f}"), help=t("mine.filter_help")
)
visible = [r for r in rows if choice in (None, "all") or _bucket(r) == choice]

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
        for r in visible
    ]
)
if table.empty:
    st.caption(t("mine.filter_empty"))
else:
    st.dataframe(
        table,
        hide_index=True,
        width="stretch",
        column_config={
            t("mine.col_key"): st.column_config.LinkColumn(display_text=r"/browse/(.*)$", width="small"),
            t("mine.col_phase"): st.column_config.ProgressColumn(min_value=0, max_value=100, format="%d %%"),
            t("mine.col_updated"): st.column_config.DatetimeColumn(format="DD.MM.YYYY HH:mm"),
        },
    )
st.caption(t("mine.readonly"))
