"""Tests, Coverage, Mutation, Lint."""

from __future__ import annotations

import ast
import random
import shutil
import tempfile
from pathlib import Path

from dev.checks.base import PY, ROOT, Result, sh

COVERAGE_MIN = 85
MUTATION_TARGETS = {
    "src/lidlalign/services/rca.py": "tests/test_rca.py",
    "src/lidlalign/services/classifier.py": "tests/test_classifier_duplicates.py",
    "src/lidlalign/services/ticket_writer.py": "tests/test_ticket_writer.py",
    "src/lidlalign/services/my_tickets.py": "tests/test_my_tickets_knowledge.py",
}
MUTANTS_PER_FILE = 6
MUTATION_MIN = 0.7
_SWAP = {
    ast.Gt: ast.LtE,
    ast.GtE: ast.Lt,
    ast.Lt: ast.GtE,
    ast.LtE: ast.Gt,
    ast.Eq: ast.NotEq,
    ast.NotEq: ast.Eq,
}


def tests() -> Result:
    proc = sh(
        PY,
        "-m",
        "pytest",
        "-q",
        "--cov",
        f"--cov-fail-under={COVERAGE_MIN}",
        "--cov-report=term:skip-covered",
    )
    tail = proc.stdout.strip().splitlines()[-6:]
    return Result(proc.returncode == 0, tail)


def lint() -> Result:
    check = sh(PY, "-m", "ruff", "check", ".")
    fmt = sh(PY, "-m", "ruff", "format", "--check", ".")
    details = (check.stdout.strip().splitlines() + fmt.stdout.strip().splitlines())[-10:]
    return Result(check.returncode == 0 and fmt.returncode == 0, details)


def _mutants(source: str) -> list[tuple[int, str]]:
    tree = ast.parse(source)
    sites = [
        (node, i)
        for node in ast.walk(tree)
        if isinstance(node, ast.Compare)
        for i, op in enumerate(node.ops)
        if type(op) in _SWAP
    ]
    random.Random(42).shuffle(sites)  # noqa: S311 - deterministische Auswahl, keine Kryptografie
    result = []
    for node, i in sites[:MUTANTS_PER_FILE]:
        original = node.ops[i]
        node.ops[i] = _SWAP[type(original)]()
        result.append((node.lineno, ast.unparse(tree)))
        node.ops[i] = original
    return result


def mutation() -> Result:
    killed = total = 0
    survivors = []
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "repo"
        shutil.copytree(
            ROOT, work, ignore=shutil.ignore_patterns(".git", ".venv", "venv", "__pycache__", ".superpowers")
        )
        for target, test in MUTATION_TARGETS.items():
            path = work / target
            original = path.read_text(encoding="utf-8")
            for lineno, mutated in _mutants(original):
                path.write_text(mutated, encoding="utf-8")
                total += 1
                if sh(PY, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", test, cwd=work).returncode != 0:
                    killed += 1
                else:
                    survivors.append(f"{target}:{lineno}")
            path.write_text(original, encoding="utf-8")
    score = killed / total if total else 1.0
    details = [f"Mutation-Score {score:.0%} ({killed}/{total})"] + [f"überlebt: {s}" for s in survivors]
    return Result(score >= MUTATION_MIN, details, warnings=len(survivors))
