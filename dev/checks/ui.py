"""i18n, Kontrast, A11y, Seitenrechte."""

from __future__ import annotations

import ast
import os
import re
import tomllib

from dev.checks.base import ROOT, UI, Result, st_calls, ui_files

TEXT_CALLS = {
    "title", "header", "subheader", "markdown", "caption", "info", "warning", "error", "success",
    "button", "form_submit_button", "download_button", "selectbox", "text_input", "text_area", "metric",
    "badge", "pills", "segmented_control", "chat_input",
}  # fmt: skip
INPUT_CALLS = {"selectbox", "text_input", "text_area", "pills", "segmented_control"}
AA = 4.5
NON_TEXT = 3.0  # WCAG 1.4.11: Bedienelemente/Flächen gegen Hintergrund
_LETTERS = re.compile(r"[A-Za-zÄÖÜäöüß]{3,}")
_ICON = re.compile(r":material/[a-z0-9_]+:")  # Icon-Kürzel sind kein übersetzbarer Text


def _has_literal_text(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return bool(_LETTERS.search(_ICON.sub("", node.value)))
    if isinstance(node, ast.JoinedStr):
        return any(_has_literal_text(v) for v in node.values if isinstance(v, ast.Constant))
    return False


def _used_keys() -> set[str]:
    keys = set()
    for path in ui_files():
        keys |= set(re.findall(r"\bt\(\s*[\"']([a-z_]+\.[a-z_]+)[\"']", path.read_text(encoding="utf-8")))
    from reqpilot.ui.pages_registry import PAGES

    return keys | {p.title_key for p in PAGES}


def i18n() -> Result:
    import yaml

    de = yaml.safe_load((UI / "strings" / "de.yaml").read_text(encoding="utf-8"))
    en = yaml.safe_load((UI / "strings" / "en.yaml").read_text(encoding="utf-8"))
    details = [f"nur in de: {k}" for k in sorted(set(de) - set(en))]
    details += [f"nur in en: {k}" for k in sorted(set(en) - set(de))]
    details += [f"Schlüssel fehlt: {k}" for k in sorted(_used_keys() - set(de))]
    for path in ui_files():
        for call in st_calls(path):
            if call.func.attr in TEXT_CALLS and call.args and _has_literal_text(call.args[0]):
                details.append(f"{path.relative_to(ROOT)}:{call.lineno} hart codierter Text")
    details += _render_in_english()
    return Result(not details, details)


def _render_in_english() -> list[str]:
    """EN-Modus: jede Seite rendert und zeigt den englischen Titel."""
    import yaml
    from streamlit.testing.v1 import AppTest

    from reqpilot.ui import i18n as i18n_mod
    from reqpilot.ui.pages_registry import PAGES

    en = yaml.safe_load((UI / "strings" / "en.yaml").read_text(encoding="utf-8"))
    problems = []
    old = os.environ.get("REQPILOT_LANG")
    os.environ["REQPILOT_LANG"] = "en"
    i18n_mod.load_strings.cache_clear()
    try:
        for page in PAGES:
            at = AppTest.from_file(str(UI / "pages" / f"{page.module}.py"), default_timeout=30).run()
            if at.exception or not at.title or at.title[0].value != en[page.title_key]:
                problems.append(f"EN-Modus: Seite {page.module} nicht englisch oder fehlerhaft")
    finally:
        if old is None:
            os.environ.pop("REQPILOT_LANG", None)
        else:
            os.environ["REQPILOT_LANG"] = old
    return problems


def _luminance(hex_color: str) -> float:
    rgb = [int(hex_color.lstrip("#")[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast_ratio(a: str, b: str) -> float:
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def contrast() -> Result:
    """Prüft die Theme-Tokens aus .streamlit/config.toml für hell und dunkel."""
    config = tomllib.loads((ROOT / ".streamlit" / "config.toml").read_text(encoding="utf-8"))["theme"]
    details, count = [], 0
    for mode in ("light", "dark"):
        theme = config.get(mode)
        if not theme:
            details.append(f"[theme.{mode}] fehlt")
            continue
        pairs = [
            ("Text/Hintergrund", theme["textColor"], theme["backgroundColor"], AA),
            ("Text/Fläche", theme["textColor"], theme["secondaryBackgroundColor"], AA),
            ("Link/Hintergrund", theme["linkColor"], theme["backgroundColor"], AA),
            ("Button-Text/Primär", "#ffffff", theme["primaryColor"], AA),
            ("Primär/Hintergrund", theme["primaryColor"], theme["backgroundColor"], NON_TEXT),
        ]
        for label, fg, bg, minimum in pairs:
            count += 1
            ratio = contrast_ratio(fg, bg)
            if ratio < minimum:
                details.append(f"{mode} {label}: {ratio:.2f} < {minimum}")
    from reqpilot.ui.theme import HERO_COLORS

    for color in HERO_COLORS:  # weiße Schrift im Hero-Band, in beiden Modi gleich
        count += 1
        ratio = contrast_ratio("#ffffff", color)
        if ratio < AA:
            details.append(f"Hero-Text/Verlauf {color}: {ratio:.2f} < {AA}")
    return Result(not details, details or [f"{count} Farbpaare in hell und dunkel erfüllen WCAG AA"])


def a11y() -> Result:
    details = []
    for path in ui_files():
        for call in st_calls(path):
            name = call.func.attr
            kwargs = {k.arg: k.value for k in call.keywords}
            if name in INPUT_CALLS:
                if not call.args:
                    details.append(f"{path.name}:{call.lineno} Eingabe ohne Label")
                if "help" not in kwargs:
                    details.append(f"{path.name}:{call.lineno} Eingabe ohne Hilfetext")
            vis = kwargs.get("label_visibility")
            if isinstance(vis, ast.Constant) and vis.value in {"hidden", "collapsed"}:
                details.append(f"{path.name}:{call.lineno} Label versteckt")
    # Längere Aktionen zeigen einen Ladezustand
    for page in ("ticket.py", "knowledge.py"):
        if "st.spinner" not in (UI / "pages" / page).read_text(encoding="utf-8"):
            details.append(f"{page}: kein Ladezustand (st.spinner)")
    return Result(not details, details)


def permissions() -> Result:
    from reqpilot.ui.pages_registry import PAGES

    files = {p.stem for p in (UI / "pages").glob("*.py") if p.stem != "__init__"}
    registered = {p.module for p in PAGES}
    details = [f"Seite ohne Rechte-Eintrag: {m}" for m in sorted(files - registered)]
    details += [f"Eintrag ohne Datei: {m}" for m in sorted(registered - files)]
    details += [f"Seite ohne Rolle: {p.module}" for p in PAGES if not p.roles]
    return Result(not details, details)
