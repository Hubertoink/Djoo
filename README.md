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

Fuer eine Windows-Distribution als Installer und portable EXE:

```bash
npm run dist
```

## Aktueller Stand

- React/Vite App-Shell im Djoo Mockup-Stil
- Library-Tabelle mit Suche, Quellfilter und Preview-Deck
- Browser-Import fuer lokale Ordner mit Serato, Engine DJ oder Traktor Auswahl
- Electron Desktop-Bridge fuer read-only Auto-Erkennung typischer Windows-Pfade
- Engine-DJ-Database2-Import fuer Track-Metadaten, BPM, Key, Hotcues und einfache Loops
- Serato-ID3-Marker-Import fuer Hotcues aus `Serato Markers2`
- Marker-Erkennung fuer typische Library-Dateien und Ordner
- Duplikaterkennung nach Pfad, Titel/Artist und BPM-Naehe
- Sync-Screen mit Diff und Backup; Serato-Ziele werden nach Nachfrage komplett durch die Quelle ersetzt und danach wieder importiert
- Playlist-Reiter zum Vergleichen zweier Libraries nach Playlist/Crate mit Trackanzahl und gezieltem Serato-Update per Pfeil
- LocalStorage Persistenz fuer Track-Metadaten und Import-Historie
- Missing-File-Filter mit Auto-Relocate, Einzel-Relocate und Bulk-Relocate ueber einen gewaehlten Ueberordner
- Fixes-Hub mit eingeklappten Missing-/Cleanup-Bereichen, Auto-Relocate und Auto-Cleanup fuer sichere Duplikate

## Desktop Bridge

Der Browser-Modus kann keine typischen Windows-Ordner automatisch scannen. Fuer deine lokalen Serato- und Engine-DJ-Ordner nutzt Djoo deshalb jetzt Electron als Desktop-Bridge.

Die Bridge liest aktuell read-only:

- `%USERPROFILE%\Music\_Serato_`
- `%USERPROFILE%\Music\Engine Library`
- externe Windows-Laufwerke mit `_Serato_` oder `Engine Library` am Laufwerksroot
- optional manuell gewaehlte Ordner

Aktuell werden Library-Marker, Audiodateien, Serato-Marker aus ID3 und Engine-DJ-Database2-Metadaten gelesen. Serato-Sync erstellt vorher ein Backup, ersetzt nach Bestaetigung `database V2`, `Subcrates` und `neworder.pref` durch die gewaehlte Quelle und importiert das Ziel danach wieder. Fuer Serato DJ Lite 4 sichert Djoo zusaetzlich `root.sqlite` und setzt den Legacy-Import-State zurueck, damit Serato die aktualisierten V2-/Crate-Dateien beim naechsten Start in seinen SQLite-Index uebernimmt. Playlist-Einzelupdates schreiben gezielt aktive Serato-Crates und mergen die Tracks in `database V2`. Cue-/Loop-Daten werden im Djoo-Sync-Manifest gesichert; direkter Serato-`Markers2` Tag-Writeback bleibt bis zur Markerwriter-Validierung gesperrt.

## Naechste technische Schritte

1. Serato-Crate-/Database-Parser weiter ausbauen, damit auch Cue-Daten ausserhalb von ID3 sicher uebernommen werden.
2. Traktor `.nml` Parser als erster vollstaendiger XML-Importadapter.
3. Vendor-Writeback fuer Hotcues/Loops nach Dry-run, Diff und Backup freischalten.
4. Cue-/Loop-Konvertierung je Zielformat mit Roundtrip-Tests absichern.
