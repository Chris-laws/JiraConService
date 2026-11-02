"""Guard-Checks für die Apps-Script-Fassung (apps-script/). Laufen mit Node; Browser-Prüfung mit Playwright."""

from __future__ import annotations

import base64
import re
import shutil

from dev.checks.base import ROOT, Result, sh, tracked_files

APPS = ROOT / "apps-script"
NODE = shutil.which("node") or "node"

# Firmen- und interne Namen, die im öffentlichen Repo nicht stehen dürfen (kodiert, damit sie hier selbst nicht stehen).
_BRAND = base64.b64decode("bGlkbHxzY2h3YXJ6IGdydXBwZXxzY2h3YXJ6IGl0fGFkIGZ1c2lvbnxsaWRsZmxvdw==").decode()
BRAND_RX = re.compile(r"(?i)\b(" + _BRAND + r")")
TEXT = {".gs", ".html", ".js", ".json", ".md", ".py", ".yaml", ".yml", ".toml", ".txt", ".css", ".example"}


def _node(*args: str, tail: int = 12) -> Result:
    proc = sh(NODE, *args)
    lines = (proc.stdout + proc.stderr).strip().splitlines()
    return Result(proc.returncode == 0, lines[-tail:])


def tests() -> Result:
    return _node("apps-script/dev/test.js", tail=4)


def stress() -> Result:
    return _node("apps-script/dev/stress.js", "--quick", tail=6)


def ui() -> Result:
    return _node("apps-script/dev/ui-check.js", tail=15)


def brand() -> Result:
    hits = []
    for path in tracked_files():
        if path.suffix not in TEXT or path == ROOT / "dev" / "checks" / "appscript.py":
            continue
        for n, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if BRAND_RX.search(line):
                hits.append(f"{path.relative_to(ROOT)}:{n}")
    return Result(not hits, hits[:20])


def privacy() -> Result:
    """Gemini-Prompts laufen durch redact(); der Melder (caller) verlässt den Server nicht."""
    hits = []
    services = (APPS / "src" / "Services.gs").read_text(encoding="utf-8")
    for m in re.finditer(r"var prompt = [^\n]+", services):
        line = m.group()
        needed = 2 if "{question}" in line else 1 if "{text}" in line else 0
        if line.count("redact(") < needed:
            hits.append("Services.gs: Prompt ohne redact(): " + line[:80])
    for m in re.finditer(r"llm\.generate\(([^)]*)\)", services):
        arg = m.group(1)
        if "redact(" not in arg and not arg.startswith("prompt"):
            hits.append("Services.gs: generate() ohne redact(): " + arg[:60])
    api = (APPS / "src" / "Api.gs").read_text(encoding="utf-8")
    if "k !== 'caller'" not in api:
        hits.append("Api.gs: Melder (caller) wird nicht aus dem Bug entfernt")
    return Result(not hits, hits)
