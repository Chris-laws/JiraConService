"""Meine Tickets: eigene Anforderungen aus Jira, nur Lesezugriff.

Frage der Seite: "Wo stehen meine Tickets?" Ein Block: Kennzahlen, Filter und Person, darunter die Tabelle.
"""

import pandas as pd
import streamlit as st

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.ui.components import kpi_strip, page_header
from reqpilot.ui.i18n import t
from reqpilot.ui.state import current_user, display_name, get_container, header_user

c = get_container()
FILTERS = ("all", "open", "done", "rejected")

page_header("mine")
card = st.container(key="card_table")
kpi_slot = card.container()  # wird gefüllt, sobald die Tickets geladen sind
toolbar = card.container(key="toolbar_mine", horizontal=True, vertical_alignment="bottom")
choice = toolbar.segmented_control(
    t("mine.filter"), FILTERS, default="all", format_func=lambda f: t(f"mine.filter_{f}"), help=t("mine.filter_help")
)

user = header_user()
if user:
    toolbar.markdown(t("mine.signed_in", user=display_name(user)))
else:
    reporters = c.jira.reporters() if hasattr(c.jira, "reporters") else []
    if reporters:
        preset = current_user()
        user = toolbar.selectbox(
            t("mine.pick_user"),
            reporters,
            index=reporters.index(preset) if preset in reporters else 0,
            format_func=display_name,
            help=t("mine.pick_user_help"),
            width=320,
        )
    else:
        user = toolbar.text_input(t("mine.email"), help=t("mine.email_help"), width=320)


@st.cache_data(ttl=300, show_spinner=False)
def _load(email: str):
    return c.my_tickets.for_user(email)


if toolbar.button(t("mine.refresh"), icon=":material/refresh:"):
    _load.clear()

try:
    rows = _load(user or "")
except SourceUnavailable as exc:
    card.error(t("error.source", detail=str(exc)))
    st.stop()

if not rows:
    card.info(t("mine.empty"), icon=":material/inbox:")
    st.stop()


def _bucket(row) -> str:
    if row.phase is None:
        return "rejected"
    return "done" if row.issue.status == "DONE" else "open"


counts = {f: sum(_bucket(r) == f for r in rows) for f in FILTERS[1:]}
with kpi_slot:
    kpi_strip(
        "mine",
        [
            (t("mine.total"), len(rows), None),
            (t("mine.open"), counts["open"], None),
            (t("mine.done"), counts["done"], None),
            (t("mine.rejected"), counts["rejected"], None),
        ],
    )

visible = [r for r in rows if choice in (None, "all") or _bucket(r) == choice]

table = pd.DataFrame(
    [
        {
            t("mine.col_key"): r.issue.url,
            t("mine.col_summary"): r.issue.summary,
            t("mine.col_status"): r.issue.status.capitalize(),
            t("mine.col_phase"): round(100 * (r.phase or 0) / r.phase_total),
            t("mine.col_stream"): r.issue.stream or "–",
            t("mine.col_updated"): r.issue.updated,
        }
        for r in visible
    ]
)
if table.empty:
    card.caption(t("mine.filter_empty"))
else:
    card.dataframe(
        table,
        hide_index=True,
        width="stretch",
        column_config={
            t("mine.col_key"): st.column_config.LinkColumn(display_text=r"/browse/(.*)$", width="small"),
            t("mine.col_summary"): st.column_config.TextColumn(width="large"),
            t("mine.col_phase"): st.column_config.ProgressColumn(min_value=0, max_value=100, format="%d %%"),
            t("mine.col_updated"): st.column_config.DatetimeColumn(format="YYYY-MM-DD HH:mm"),
        },
    )
card.caption(t("mine.readonly"))
