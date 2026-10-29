"""Security, Secrets, XSS, Datenschutz."""

from __future__ import annotations

import re

from dev.checks.base import PY, ROOT, Result, sh, tracked_files, ui_files

SECRET_PATTERNS = [
    re.compile(r"AIza[0-9A-Za-z_\-]{35}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)(api[_-]?key|token|secret|password|pat)\s*[=:]\s*['\"][A-Za-z0-9_\-]{16,}['\"]"),
    re.compile(r"(?i)authorization:\s*bearer\s+[A-Za-z0-9._\-]{20,}"),
]
TEXT_SUFFIXES = {".py", ".yaml", ".yml", ".toml", ".json", ".md", ".txt", ".example", ".js", ".cfg"}
HTML_ALLOWED = {ROOT / "src" / "reqpilot" / "ui" / "theme.py"}


def security() -> Result:
    proc = sh(PY, "-m", "bandit", "-r", "src", "app.py", "-q", "-ll", "-f", "txt")
    return Result(proc.returncode == 0, proc.stdout.strip().splitlines()[-8:])


def secrets() -> Result:
    hits = []
    for path in tracked_files():
        if path.suffix not in TEXT_SUFFIXES and path.name not in {".env.example"}:
            continue
        if "dev/checks" in str(path):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for rx in SECRET_PATTERNS:
            for m in rx.finditer(text):
                hits.append(f"{path.relative_to(ROOT)}: {m.group()[:12]}…")
    if (ROOT / ".env").exists() and ".env" not in (ROOT / ".gitignore").read_text():
        hits.append(".env ist nicht in .gitignore")
    return Result(not hits, hits)


def xss() -> Result:
    hits = []
    for path in ui_files():
        text = path.read_text(encoding="utf-8")
        if "unsafe_allow_html=True" in text and path not in HTML_ALLOWED:
            hits.append(f"{path.relative_to(ROOT)}: unsafe_allow_html außerhalb von theme.py")
        if re.search(r"\bst\.(html|components)", text):
            hits.append(f"{path.relative_to(ROOT)}: st.html/components nicht erlaubt")
    theme = (ROOT / "src" / "reqpilot" / "ui" / "theme.py").read_text(encoding="utf-8")
    if re.search(r"st\.markdown\(f", theme):
        hits.append("theme.py: HTML-Markdown mit f-String (dynamischer Inhalt)")
    return Result(not hits, hits)


def privacy() -> Result:
    """Alle LLM-Prompts müssen durch redact() laufen; Melder (caller) darf nie in Prompts landen."""
    hits = []
    for path in (ROOT / "src" / "reqpilot" / "services").glob("*.py"):
        text = path.read_text(encoding="utf-8")
        if ".generate(" in text and "redact(" not in text:
            hits.append(f"{path.name}: LLM-Aufruf ohne redact()")
        if "caller" in text:
            hits.append(f"{path.name}: verwendet Melderdaten (caller)")
    return Result(not hits, hits)
