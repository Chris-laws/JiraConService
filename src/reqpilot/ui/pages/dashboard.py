"""Übersicht: Wo stehen die Anforderungen im Pilot, was ist neu, was brennt?

Ein Bildschirm ohne Scrollen der Seite: oben Kennzahlen und die Linie des Lebenszyklus (je Phase eine
Haltestelle mit Anzahl), darunter Widgets fester Höhe, die in sich scrollen.
"""

from datetime import datetime, timedelta

import streamlit as st

from reqpilot.adapters.errors import SourceUnavailable
from reqpilot.config import ConfigError
from reqpilot.ui.components import card_title, kpi_strip
from reqpilot.ui.i18n import t
from reqpilot.ui.state import current_role, current_user, display_name, get_container, phase_label

c = get_container()
TICKET_PAGE = "src/reqpilot/ui/pages/ticket.py"
RCA_PAGE = "src/reqpilot/ui/pages/rca.py"
ROW_1 = 340  # Höhe der scrollbaren Listen in Pixel
ROW_2 = 236


def _stream(stream_id: str | None) -> str:
    """Kurzname ohne Zusatz in Klammern; unbekannte Streams aus Jira zeigen ihre ID."""
    if not stream_id:
        return "–"
    try:
        return c.streams.get(stream_id).name.split(" (")[0]
    except ConfigError:
        return stream_id


def _load(fn):
    try:
        return fn(), None
    except SourceUnavailable as exc:
        return [], str(exc)


issues, jira_error = _load(c.jira.search_issues)
bugs, sn_error = _load(c.servicenow.bugs)
changes, change_error = _load(c.changes.changes)
documents = c.documents.documents() if c.documents else []
issues = sorted(issues, key=lambda i: i.updated, reverse=True)
changes = sorted(changes, key=lambda ch: ch.deployed_at, reverse=True)
user = current_user()
role = current_role()

path = [s for s in c.app_config.lifecycle if s != "REJECTED"]
open_issues = [i for i in issues if i.status not in {"DONE", "REJECTED"}]
mine = [i for i in issues if user and i.reporter == user]
week_ago = datetime.now() - timedelta(days=7)

head = st.container(key="dash_head", horizontal=True, vertical_alignment="bottom")
with head.container():
    st.title(t("dash.title"))
    st.caption(t("dash.intro", user=display_name(user) or t("dash.nobody"), role=role))
if head.button(t("dash.new_ticket"), type="primary", icon=":material/add:"):
    st.switch_page(TICKET_PAGE)

kpi_strip(
    "dash",
    [
        (t("dash.k_open"), len(open_issues), t("dash.k_open_help")),
        (t("dash.k_week"), sum(i.updated >= week_ago for i in issues), t("dash.k_week_help")),
        (t("dash.k_validation"), sum(i.status.startswith("VALIDATION") for i in issues), t("dash.k_validation_help")),
        (t("dash.k_ready"), sum(i.status == "READY FOR DEPLOYMENT" for i in issues), t("dash.k_ready_help")),
        (t("dash.k_bugs"), len(bugs), t("dash.k_bugs_help")),
        (t("dash.k_mine"), sum(i.status not in {"DONE", "REJECTED"} for i in mine), t("dash.k_mine_help")),
    ],
)

# Signatur: der Lebenszyklus als Linie mit Haltestellen. Gefüllte Haltestelle = dort liegen Tickets.
with st.container(key="card_line"):
    rejected = sum(i.status == "REJECTED" for i in issues)
    card_title("dash.line_title", "dash.line_help", rejected=rejected)
    if jira_error:
        st.error(t("error.source", detail=jira_error))
    with st.container(key="line", horizontal=True):
        for n, status in enumerate(path, start=1):
            count = sum(i.status == status for i in issues)
            with st.container(key=f"stop_{'on' if count else 'off'}_{n}"):
                st.markdown(f"**{count}**")
                st.caption(phase_label(status))

left, middle, right = st.columns([5, 4, 3])

with left, st.container(key="card_recent"):
    card_title("dash.recent_title", "dash.recent_help", n=len(issues))
    phases = st.pills(
        t("dash.filter"),
        ["open", "done"],
        format_func=lambda f: t(f"dash.filter_{f}"),
        help=t("dash.filter_help"),
    )
    shown = [i for i in issues if not phases or (phases == "done") == (i.status in {"DONE", "REJECTED"})]
    with st.container(height=ROW_1, border=False, key="scroll_recent"):
        for i in shown:
            st.markdown(
                t(
                    "dash.issue_row",
                    key=i.key,
                    url=i.url,
                    summary=i.summary,
                    phase=phase_label(i.status),
                    stream=_stream(i.stream),
                    date=i.updated.strftime("%d.%m."),
                )
            )

with middle, st.container(key="card_mine"):
    card_title("dash.mine_title", "dash.mine_help", user=display_name(user) or t("dash.nobody"))
    with st.container(height=ROW_1 + 44, border=False, key="scroll_mine"):
        if not mine:
            st.caption(t("dash.mine_empty"))
        for i in mine:
            done = i.status in {"DONE", "REJECTED"}
            phase = path.index(i.status) + 1 if i.status in path else len(path)
            st.markdown(t("dash.mine_row", key=i.key, url=i.url, summary=i.summary))
            st.progress(
                1.0 if done else phase / len(path),
                text=t("dash.mine_phase", phase=phase_label(i.status), n=phase, total=len(path)),
            )

with right, st.container(key="card_streams"):
    card_title("dash.streams_title", "dash.streams_help")
    active = c.streams.active()
    counts = {s.id: sum(i.stream == s.id for i in open_issues) for s in active}
    top = max(counts.values(), default=0) or 1
    with st.container(height=ROW_1 + 44, border=False, key="scroll_streams"):
        for s in active:
            st.progress(
                counts[s.id] / top,
                text=t("dash.stream_row", name=_stream(s.id), n=counts[s.id], epics=len(s.epics)),
            )
            epic_rows = [
                t("dash.epic_row", key=e.key, title=e.title, n=sum(i.epic == e.key for i in open_issues))
                for e in s.epics
            ]
            if epic_rows:
                st.caption("  \n".join(epic_rows))
        st.caption(t("dash.streams_more", n=len(active)))

b_col, ch_col, doc_col = st.columns(3)

with b_col, st.container(key="card_bugs"):
    card_title("dash.bugs_title", "dash.bugs_help")
    if sn_error:
        st.error(t("error.source", detail=sn_error))
    with st.container(height=ROW_2, border=False, key="scroll_bugs"):
        for b in sorted(bugs, key=lambda b: b.priority):
            row = st.container(horizontal=True, vertical_alignment="center", key=f"bugrow_{b.number}")
            row.markdown(
                t(
                    "dash.bug_row",
                    number=b.number,
                    url=b.url,
                    title=b.short_description,
                    priority=b.priority.split(" - ")[-1] or "–",
                )
            )
            if row.button(
                t("dash.bug_check"),
                key=f"rca_{b.number}",
                type="tertiary",
                icon=":material/troubleshoot:",
                help=t("dash.bug_check_help"),
            ):
                st.session_state["rca_bug"] = b.number
                st.switch_page(RCA_PAGE)

with ch_col, st.container(key="card_changes"):
    card_title("dash.changes_title", "dash.changes_help")
    if change_error:
        st.error(t("error.source", detail=change_error))
    with st.container(height=ROW_2, border=False, key="scroll_changes"):
        for ch in changes:
            st.markdown(
                t(
                    "dash.change_row",
                    id=ch.id,
                    url=ch.url,
                    title=ch.title,
                    release=ch.release or "–",
                    date=ch.deployed_at.strftime("%d.%m."),
                )
            )

with doc_col, st.container(key="card_docs"):
    card_title("dash.docs_title", "dash.docs_help")
    with st.container(height=ROW_2, border=False, key="scroll_docs"):
        if not documents:
            st.caption(t("dash.docs_empty"))
        for d in documents:
            first = d.body.splitlines()[0] if d.body else ""
            excerpt = first if len(first) <= 90 else first[:88].rsplit(" ", 1)[0] + " …"
            st.markdown(t("dash.doc_row", title=d.title, url=d.url or "#", kind=t(f"source.{d.kind}"), excerpt=excerpt))
