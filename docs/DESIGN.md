# ReqPilot – Design-Sprache (provisorisch)

Es gibt noch kein Firmen-Designsystem für dieses Tool. Die Werte unten folgen dem App-Stil
**„Achromatic ledger“** aus dem Taste-Skill (Regeln für Arbeitsoberflächen, abgeleitet aus realen
Produkt-Screens). Grundfarben stehen in `.streamlit/config.toml`, alles Weitere als statisches CSS in
`src/reqpilot/ui/theme.py`. Der Guard prüft den Kontrast in hell und dunkel.

## Haltung

Ein Werkzeug, kein Prospekt. Das Chrome ist Tinte auf ruhigem Grund; Farbe steht nur auf Daten und
Status. Jede Seite beantwortet eine Frage, und der größte Block beantwortet sie. Aussagen nie nur über
Farbe (Badges immer mit Text und Symbol).

## Farben

| Rolle | Hell | Dunkel | Verwendung |
|---|---|---|---|
| Grund | `#f2f4f7` Blaugrau | `#0a0a0a` | Seite und Seitenleiste |
| Karte | `#ffffff` | `#111111` | Karten, 1px Linie `#e3e5e8` / `#262626` |
| Eingaben | `#ffffff` | `#141414` | Felder mit Linie `#d4d6da` / `#2a2a2a` |
| Text | `#0a0a0a` | `#fafafa` | Fließtext; Nebentext `#5f6368` / `#b4b4b4` |
| Primär | `#141414` | `#ededed` (Schrift dunkel) | die eine Hauptaktion je Seite |
| Datenton | `#1d5fbf` | `#7fb0ff` | Links, Fortschritt, Konfidenz |

Hinweise als blasse Paare mit 1px Kante: Fehler `#ffedea`/`#831c1e`, Warnung `#fffbeb`/`#92400e`.
Keine Verläufe, kein Lila/Indigo, keine Schatten auf ruhenden Flächen.

## Form und Typografie

- Schrift **Geist** (OFL, über Google Fonts; fällt sie im Firmennetz aus, greift die Systemschrift),
  Geist Mono nur für Code. Größen 12/13/14/18/24 px, Zahlen tabellarisch.
- Titel 24 px als Substantiv, darunter ein grauer Satz zu den Daten. Kein Hero-Band.
- Karten: 8 px Radius, 20 px Innenabstand, 1px Linie. Bedienelemente 6 px Radius.
- Ein Abstand überall: 12 px zwischen Karten, horizontal wie vertikal.
- Kennzahlen als ein Streifen mit Haarlinien (`kpi_strip`), nicht als einzelne Kacheln.
- Reiter als Unterstreichung auf einer 1px Linie.
- Bewegung nur als Rückmeldung: Buttons geben beim Drücken auf 97 % nach (160 ms, ease-out), bei
  `prefers-reduced-motion` ohne Bewegung. Nichts fährt beim Laden herein.

## Seitenmuster

1. Titelzeile (`page_header`).
2. Zwei Spalten: links die Eingabe oder Auswahl als Karte, rechts die Antwort. Karten einer Reihe enden
   auf einer Linie; in der Eingabekarte wächst das Textfeld mit, der Button sitzt am Fuß.
3. Vor dem ersten Lauf zeigt die rechte Spalte echte Bezugsdaten statt eines leeren Platzhalters:
   die zuletzt geänderten Tickets (Ticket erstellen) bzw. die zuletzt ausgerollten Changes (Bug-Ursache).
4. Danach: Befund zuerst (Duplikat, mehrere Streams), dann Kennzahlen-Streifen, dann Details in Reitern.

Karten entstehen über `st.container(key="card_…")`, Kennzahlen über `key="kpis_…"`, eine Fußaktion über
`key="foot_…"`; Streamlit setzt daraus die CSS-Klasse `.st-key-…`. Bausteine liegen in
`src/reqpilot/ui/components.py`.
