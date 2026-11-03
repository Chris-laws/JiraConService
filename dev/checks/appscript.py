"""Guard-Checks für die Apps-Script-Fassung (apps-script/). Laufen mit Node; Browser-Prüfung mit Playwright."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess

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


BUDGETS = "apps-script/dev/budgets.json"


def _ratchet() -> list[str]:
    """Budgets dürfen nur sinken: jeder Zahlenwert höchstens so hoch wie im letzten Commit."""
    proc = subprocess.run(["git", "show", "HEAD:" + BUDGETS], cwd=ROOT, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        return []  # neu angelegt: noch nichts zu vergleichen
    old, new = json.loads(proc.stdout), json.loads((ROOT / BUDGETS).read_text(encoding="utf-8"))
    raised = []
    for group in ("page", "response", "load"):
        for key, value in new.get(group, {}).items():
            before = old.get(group, {}).get(key)
            if (
                isinstance(value, (int, float))
                and isinstance(before, (int, float))
                and key != "users"
                and value > before
            ):
                raised.append(f"budgets.json {group}.{key}: {before} → {value} (Ratsche: nur senken)")
            if key == "users" and isinstance(before, (int, float)) and value < before:
                raised.append(f"budgets.json load.users: {before} → {value} (Ziel darf nicht kleiner werden)")
    return raised


def budget() -> Result:
    res = _node("apps-script/dev/budget.js", tail=6)
    raised = _ratchet()
    return Result(res.ok and not raised, res.details + raised)


def load() -> Result:
    return _node("apps-script/dev/load.js", "--quick", tail=8)


def ui() -> Result:
    """Prüft die ausgelieferte, gekürzte Oberfläche (bundle/Index.html) im Browser."""
    return _node("apps-script/dev/ui-check.js", "--bundle", tail=15)


def brand() -> Result:
    hits = []
    for path in tracked_files():
        if path.suffix not in TEXT:
            continue
        for n, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if _brand_hits(line):
                hits.append(f"{path.relative_to(ROOT)}:{n}")
    return Result(not hits, hits[:20])


SCOPES_ALLOWED = {
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/script.scriptapp",  # nur für den Zeitauslöser des BigQuery-Abgleichs
}


def _readonly_files(src) -> list[str]:
    hits = []
    for path in sorted(src.glob("*.gs")):
        if path.name == "MockData.gs":
            continue
        text = path.read_text(encoding="utf-8")
        if "UrlFetchApp." in text and path.name not in ("Adapters.gs", "Vertex.gs"):
            hits.append(f"{path.name}: UrlFetchApp außerhalb von Adapters.gs/Vertex.gs")
        bad = [m.group(1) for m in re.finditer(r"requestJson(?:All)?\(\s*'(\w+)'", text) if m.group(1) != "GET"]
        if bad and path.name not in ("Vertex.gs", "BigQuery.gs"):
            hits.append(f"{path.name}: requestJson mit {', '.join(bad)} an Jira/Confluence/ServiceNow")
        if re.search(r"method:\s*'(put|patch|delete)'", text, re.I):
            hits.append(f"{path.name}: PUT/PATCH/DELETE im Code")
    return hits


def _readonly_adapters(src) -> list[str]:
    hits = []
    adapters = (src / "Adapters.gs").read_text(encoding="utf-8")
    body = adapters[adapters.index("function requestJson(") :]
    if "assertReadOnly_(method, url);" not in body[: body.index("UrlFetchApp.fetch")]:
        hits.append("Adapters.gs: requestJson ruft assertReadOnly_ nicht vor dem Abruf auf")
    for m in re.finditer(r"\nfunction (\w+)\([^)]*\) \{\n([\s\S]*?)\n\}\n", adapters):
        if "UrlFetchApp." in m.group(2) and "assertReadOnly_(" not in m.group(2):
            hits.append(f"Adapters.gs: {m.group(1)} ruft UrlFetchApp ohne assertReadOnly_")
    if "JiraRestWriter" in adapters or "/rest/api/2/issue'" in adapters:
        hits.append("Adapters.gs: Code zum Anlegen in Jira ist zurück")
    if "assertReadOnly_('POST', url);" not in (src / "Vertex.gs").read_text(encoding="utf-8"):
        hits.append("Vertex.gs: paralleles Einbetten ohne assertReadOnly_")
    hits += _readonly_bigquery(src)
    return hits


def _readonly_bigquery(src) -> list[str]:
    """BigQuery: jede Anweisung geht vorher durch assertOwnDataset_ (nur eigener Datensatz, kein DROP & Co.)."""
    path = src / "BigQuery.gs"
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    hits = []
    posts = [m.start() for m in re.finditer(r"requestJson\(\s*'POST'", text)]
    query = text.find("BigQueryClient.prototype.query = function")
    guard = text.find("assertOwnDataset_(sql, this.project, this.dataset);", query)
    if len(posts) != 1 or query < 0 or not (query < guard < posts[0]):
        hits.append("BigQuery.gs: POST nur in BigQueryClient.query und erst nach assertOwnDataset_")
    if re.search(r"\b(DROP|TRUNCATE)\s+(TABLE|SCHEMA)", text, re.I):
        hits.append("BigQuery.gs: DROP/TRUNCATE im Code")
    return hits


def readonly() -> Result:
    """Nur lesen: jeder HTTP-Aufruf läuft durch die Sperre, nur GET (außer Vertex), keine Schreib-Berechtigungen."""
    src = APPS / "src"
    hits = _readonly_files(src) + _readonly_adapters(src)
    manifest = json.loads((src / "appsscript.json").read_text(encoding="utf-8"))
    extra = set(manifest.get("oauthScopes", [])) - SCOPES_ALLOWED
    hits += [f"appsscript.json: zusätzliche Berechtigung {x}" for x in sorted(extra)]
    return Result(not hits, hits)


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
