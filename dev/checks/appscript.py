"""Guard-Checks für die Apps-Script-Fassung (apps-script/). Laufen mit Node; Browser-Prüfung mit Playwright."""

from __future__ import annotations

import hashlib
import re
import shutil

from dev.checks.base import ROOT, Result, sh, tracked_files

APPS = ROOT / "apps-script"
NODE = shutil.which("node") or "node"

# Firmen- und interne Namen, die im öffentlichen Repo nicht stehen dürfen. Hier stehen nur Hash-Präfixe
# (SHA-256, 16 Zeichen) der kleingeschriebenen Wörter und Wortpaare, damit die Namen selbst nicht im Repo stehen.
BRAND_HASHES = frozenset(
    [
        "501e824f2cad9398",
        "5a0fd4feae0153d9",
        "712739d2658cd5ca",
        "8e1b664845300bb6",
        "af8bbfd98fc72684",
        "f3053000721117d7",
    ]
)
WORD_RX = re.compile(r"[a-zäöüß0-9]+")


def _brand_hits(line: str) -> bool:
    words = WORD_RX.findall(line.lower())
    grams = words + [a + " " + b for a, b in zip(words, words[1:], strict=False)]
    return any(hashlib.sha256(g.encode()).hexdigest()[:16] in BRAND_HASHES for g in grams)


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
        if path.suffix not in TEXT:
            continue
        for n, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if _brand_hits(line):
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
