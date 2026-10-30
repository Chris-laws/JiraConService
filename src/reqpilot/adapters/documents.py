"""Weitere Wissensquellen als Markdown-Dateien: Change Log, Anleitungen, Schulungsunterlagen.

Jede Datei beginnt mit einem kurzen Kopf:

    ---
    title: Release Notes 2026.10
    kind: changelog          # changelog | guide | training
    url: https://…           # optional, Link zum Original
    ---

Der Ordner kommt aus REQPILOT_DOCS_DIR (lokal: fixtures/docs). So lassen sich Exporte aus Wiki oder
Laufwerk einspielen, ohne dass es dafür eine eigene Schnittstelle braucht.
"""

from __future__ import annotations

from pathlib import Path

from reqpilot.models import Document

KINDS = ("changelog", "guide", "training")


def _split_front_matter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text
    head, _, body = text[3:].partition("\n---")
    meta = {}
    for line in head.strip().splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            meta[key.strip()] = value.split(" #", 1)[0].strip()
    return meta, body.lstrip("-\n")


class LocalDocuments:
    def __init__(self, folder: Path | None):
        self._folder = folder

    def documents(self) -> list[Document]:
        if not self._folder or not self._folder.is_dir():
            return []
        docs = []
        for path in sorted(self._folder.glob("*.md")):
            meta, body = _split_front_matter(path.read_text(encoding="utf-8"))
            kind = meta.get("kind", "guide")
            docs.append(
                Document(
                    id=path.stem,
                    title=meta.get("title", path.stem),
                    body=body.strip(),
                    kind=kind if kind in KINDS else "guide",
                    url=meta.get("url", ""),
                )
            )
        return docs
