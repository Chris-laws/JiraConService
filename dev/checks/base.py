"""Gemeinsame Typen und Helfer für Guard-Checks."""

from __future__ import annotations

import ast
import subprocess
import sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src" / "reqpilot"
UI = SRC / "ui"
PY = sys.executable


@dataclass
class Result:
    ok: bool
    details: list[str] = field(default_factory=list)
    warnings: int = 0


@dataclass(frozen=True)
class Check:
    name: str
    purpose: str
    threshold: str
    run: Callable[[], Result]


def sh(*args: str, cwd: Path = ROOT) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)  # noqa: S603 - feste Argumente


def tracked_files() -> list[Path]:
    out = sh("git", "ls-files", "--cached", "--others", "--exclude-standard").stdout.split()
    return [ROOT / p for p in out if (ROOT / p).is_file()]


def ui_files() -> list[Path]:
    return [ROOT / "app.py", *sorted(UI.rglob("*.py"))]


def st_calls(path: Path) -> Iterator[ast.Call]:
    """Alle Aufrufe der Form st.<name>(...) bzw. <obj>.<name>(...) auf Streamlit-Objekten."""
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            yield node
