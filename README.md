# Djoo

Djoo ist eine lokale DJ Library App fuer Serato, Engine DJ und Traktor. Dieses Grundgeruest baut zuerst die Library-Oberflaeche, Import-Flows, Preview-Wiedergabe fuer manuell geladene Audiodateien und die saubere Adapter-Struktur auf.

## Start

```bash
npm install
npm run dev
```

Danach laeuft die App standardmaessig unter `http://127.0.0.1:5173`.

Fuer den lokalen Desktop-Test mit echter Pfad-Erkennung:

```bash
npm run build
npm run desktop
```

## Aktueller Stand

- React/Vite App-Shell im Djoo Mockup-Stil
- Library-Tabelle mit Suche, Quellfilter und Preview-Deck
- Browser-Import fuer lokale Ordner mit Serato, Engine DJ oder Traktor Auswahl
- Electron Desktop-Bridge fuer read-only Auto-Erkennung typischer Windows-Pfade
- Marker-Erkennung fuer typische Library-Dateien und Ordner
- Duplikaterkennung nach Pfad, Titel/Artist und BPM-Naehe
- Sync-Screen als Dry-run Grundlage mit Sicherheitscheckliste
- LocalStorage Persistenz fuer Track-Metadaten und Import-Historie

## Desktop Bridge

Der Browser-Modus kann keine typischen Windows-Ordner automatisch scannen. Fuer deine lokalen Serato- und Engine-DJ-Ordner nutzt Djoo deshalb jetzt Electron als Desktop-Bridge.

Die Bridge liest aktuell read-only:

- `%USERPROFILE%\Music\_Serato_`
- `%USERPROFILE%\Music\Engine Library`
- externe Windows-Laufwerke mit `_Serato_` oder `Engine Library` am Laufwerksroot
- optional manuell gewaehlte Ordner

Aktuell werden Library-Marker und Audiodateien gescannt. Serato-/Engine-Datenbanken werden noch nicht voll geparst und es gibt noch keinen Writeback.

## Naechste technische Schritte

1. Serato-Crate-/Database-Parser aus den gefundenen `_Serato_` Ordnern bauen.
2. Engine DJ SQLite Parser fuer die gefundene `Engine Library` integrieren.
3. Traktor `.nml` Parser als erster vollstaendiger XML-Importadapter.
4. Sync-Diff-Modell und Backup-Strategie implementieren.
5. Writeback erst nach Dry-run, Diff und Backup freischalten.
