"""Datenkonsistenz, Last-Kurzprofil, Performance-Budget, Lizenzen."""

from __future__ import annotations

import json
import time

from dev.checks.base import PY, ROOT, Result, sh

LOAD_REQUESTS = 200
LOAD_P95_MS = 60.0
COLD_START_S = 3.0
MAX_RUNTIME_DEPS = 6
ALLOWED_LICENSES = (
    "MIT",
    "BSD",
    "Apache",
    "PSF",
    "Python Software Foundation",
    "ISC",
    "MPL",
    "Unlicense",
    "HPND",
)
LICENSE_EXCEPTIONS = {"lidlalign"}


def consistency() -> Result:
    from lidlalign.config import load_settings
    from lidlalign.container import build_container

    c = build_container(load_settings({}))
    streams = {s.id: s for s in c.streams.all()}
    lifecycle = set(c.app_config.lifecycle)
    details = []
    for issue in c.jira.search_issues():
        if issue.stream and issue.stream not in streams:
            details.append(f"{issue.key}: unbekannter Stream {issue.stream}")
        elif issue.epic and issue.epic not in {e.key for e in streams[issue.stream].epics}:
            details.append(f"{issue.key}: Epic {issue.epic} gehört nicht zu {issue.stream}")
        if issue.status not in lifecycle:
            details.append(f"{issue.key}: Status {issue.status} nicht im Lebenszyklus")
    epic_keys = [e.key for s in streams.values() for e in s.epics]
    details += [f"Epic doppelt: {k}" for k in sorted({k for k in epic_keys if epic_keys.count(k) > 1})]
    change_ids = [ch.id for ch in c.changes.changes()]
    if len(change_ids) != len(set(change_ids)):
        details.append("Change-IDs doppelt")
    return Result(not details, details)


def load() -> Result:
    """Kurzprofil gegen Mocks, nie gegen Live-Systeme."""
    from lidlalign.config import load_settings
    from lidlalign.container import build_container

    c = build_container(load_settings({}))
    texts = [i.summary + ". " + i.description for i in c.jira.search_issues()]
    bugs = c.servicenow.bugs()
    timings = []
    for n in range(LOAD_REQUESTS):
        start = time.perf_counter()
        text = texts[n % len(texts)]
        c.ticket_writer.draft(text, "DE")
        c.classifier.classify(text)
        c.duplicates.check(text)
        c.rca.analyze(bugs[n % len(bugs)])
        timings.append((time.perf_counter() - start) * 1000)
    timings.sort()
    p95 = timings[int(len(timings) * 0.95) - 1]
    return Result(
        p95 <= LOAD_P95_MS,
        [f"p95 {p95:.1f} ms je Anfrage (Grenze {LOAD_P95_MS} ms, {LOAD_REQUESTS} Anfragen)"],
    )


def budget() -> Result:
    start = time.perf_counter()
    proc = sh(
        PY,
        "-c",
        "import sys; sys.path.insert(0,'src');"
        "from lidlalign.config import load_settings; from lidlalign.container import build_container;"
        "c=build_container(load_settings({})); len(c.index); c.classifier",
    )
    cold = time.perf_counter() - start
    deps = [
        line
        for line in (ROOT / "requirements.txt").read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]
    details = [f"Kaltstart {cold:.2f} s (Grenze {COLD_START_S} s)", f"{len(deps)} Laufzeit-Abhängigkeiten"]
    ok = proc.returncode == 0 and cold <= COLD_START_S and len(deps) <= MAX_RUNTIME_DEPS
    return Result(ok, details + proc.stderr.strip().splitlines()[-3:])


def license_check() -> Result:
    proc = sh(PY, "-m", "piplicenses", "--format=json", "--from=mixed")
    details = []
    for pkg in json.loads(proc.stdout or "[]"):
        name, lic = pkg["Name"], pkg["License"]
        if name.lower() in LICENSE_EXCEPTIONS:
            continue
        if not any(a.lower() in lic.lower() for a in ALLOWED_LICENSES):
            details.append(f"{name}: {lic}")
    readme = (ROOT / "README.md").read_text(encoding="utf-8") if (ROOT / "README.md").exists() else ""
    if "Markenhinweis" not in readme:
        details.append("README ohne Markenhinweis")
    return Result(not details, details, warnings=0)
