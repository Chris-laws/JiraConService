# ReqPilot – Design-Sprache (provisorisch)

Es gibt noch kein Firmen-Designsystem für dieses Tool. Die Werte unten sind bewusst gewählte, aber
**provisorische** Tokens auf Basis der Tailwind-Palette. Sie stehen technisch in `.streamlit/config.toml`
und werden vom Guard auf WCAG-AA-Kontrast geprüft (hell und dunkel).

## Haltung

Ruhig, sachlich, vertrauenswürdig: Business-User sollen ohne Schulung zurechtkommen. Eine Akzentfarbe,
viel Weißraum, Aussagen nie nur über Farbe (Badges immer mit Text und Symbol).

## Farben

| Token | Hell | Dunkel | Verwendung |
|---|---|---|---|
| primary | `#4f46e5` indigo-600 | `#5a53ea` | Hauptaktion, Fortschritt, Logo |
| background | `#f8fafc` slate-50 | `#0b1120` | Seitenhintergrund |
| secondary | `#f1f5f9` slate-100 | `#1e293b` slate-800 | Sidebar, Eingabefelder |
| text | `#0f172a` slate-900 | `#f1f5f9` slate-100 | Fließtext |
| border | `#e2e8f0` slate-200 | `#334155` slate-700 | Karten, Tabellen |
| link | `#4338ca` indigo-700 | `#a5b4fc` indigo-300 | Links |

Status-Badges: grün = hohe Konfidenz, orange = mittel, grau = niedrig/neutral, rot = wahrscheinliches
Duplikat, blau = ähnlich, violett = Priorität/KI.

Flächen (nur CSS in `theme.py`, per `light-dark()`): Karte `#ffffff` / `#111a2e`, Kachel `#f1f4f9` /
`#0f1729`, Linie `#e6eaf1` / `#1f2b44`. Hero-Band: Verlauf `#4338ca` → `#6d28d9` mit weißer Schrift
(Kontrast prüft der Guard).

## Form und Typografie

- Grundschrift 15 px, Radius `0.5rem` für Felder und Buttons, `0.875rem` für Karten.
- Karten: weiß mit feiner Linie und weichem Schatten; Kacheln für leere Zustände ohne Schatten.
- System-Schrift (`sans-serif`), Überschriften mit engerer Laufweite, Zahlen tabellarisch.
- Volle Breite bis `104rem`, wenig Leerraum oben.

## Seitenmuster

Jede Seite ist eine Arbeitsfläche ohne langes Scrollen:

1. Hero-Band (`page_header`): Titel, ein Satz Einleitung, optional Schritte.
2. Darunter zwei Spalten: links schmal die Eingabe oder Auswahl als Karte, rechts breit das Ergebnis.
3. Vor dem ersten Ergebnis zeigt die rechte Spalte einen leeren Zustand mit drei Kacheln, die erklären,
   was passieren wird. Danach: Kennzahlen-Zeile (gleich hohe `st.metric`-Karten), Hinweise, dann
   Details in einer Karte mit Reitern (Segment-Optik).

Karten entstehen über `st.container(key="card_…")`, das Hero über `key="hero"`; Streamlit setzt daraus
die CSS-Klasse `.st-key-…`. Bausteine liegen in `src/reqpilot/ui/components.py` (`page_header`,
`card_title`, `tile`, Badges). Lange Aktionen zeigen einen Spinner.
