import type { LibraryFormat } from '../domain/library';

export interface SuggestedLibraryLocation {
  format: Exclude<LibraryFormat, 'djoo'>;
  label: string;
  windowsPath: string;
  hint: string;
}

export const suggestedLibraryLocations: SuggestedLibraryLocation[] = [
  {
    format: 'serato',
    label: 'Serato Musik Library',
    windowsPath: '%USERPROFILE%\\Music\\_Serato_',
    hint: 'Enthaelt Datenbank, Crates und Analyse-Daten. Audio liegt oft ausserhalb dieses Ordners.'
  },
  {
    format: 'serato',
    label: 'Serato externe Drives',
    windowsPath: '<Drive>:\\_Serato_',
    hint: 'Serato schreibt pro Laufwerk eigene Library-Daten.'
  },
  {
    format: 'engine',
    label: 'Engine DJ Library',
    windowsPath: '%USERPROFILE%\\Music\\Engine Library',
    hint: 'Typischer Ort fuer Engine-Datenbanken und Export-Infos.'
  },
  {
    format: 'engine',
    label: 'Engine DJ externe Drives',
    windowsPath: '<Drive>:\\Engine Library',
    hint: 'Relevant fuer Prime/Denon/Engine Export-Datentraeger.'
  },
  {
    format: 'traktor',
    label: 'Traktor Collection',
    windowsPath: '%USERPROFILE%\\Documents\\Native Instruments\\Traktor*\\collection.nml',
    hint: 'NML ist der erste Adapter, der spaeter voll geparst werden sollte.'
  }
];

export const desktopBridgeChecklist = [
  'Ordner automatisch finden',
  'Serato/Engine Datenbanken read-only parsen',
  'Backups vor Writeback erzeugen',
  'Sync-Diff nativ schreiben'
];
