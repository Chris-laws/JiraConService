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

## Form und Typografie

- Radius `0.5rem` für Felder, Karten und Buttons.
- System-Schrift (`sans-serif`), Überschriften mit leicht engerer Laufweite, Zahlen tabellarisch.
- Inhaltsbreite max. `76rem`.

## Seitenmuster

Jede Seite: Titel → ein Satz Einleitung → Eingabe in einer Karte → Ergebnis mit Kennzahlen-Zeile
(`st.metric` mit Rahmen) → Details in Karten → Aktionen am Ende. Lange Aktionen zeigen einen Spinner.
Bausteine liegen in `src/reqpilot/ui/components.py`.
