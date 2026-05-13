export type LibraryFormat = 'djoo' | 'serato' | 'engine' | 'traktor';

export type TrackStatus = 'ready' | 'missing-file' | 'needs-review';

export interface CuePoint {
  id: string;
  label: string;
  positionMs: number;
  color: string;
}

export interface LoopRegion {
  id: string;
  label: string;
  startMs: number;
  endMs: number;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  bpm?: number;
  genre?: string;
  musicalKey?: string;
  durationSeconds?: number;
  sourceFormat: LibraryFormat;
  sourcePath?: string;
  originalSourcePath?: string;
  sourceSignature?: string;
  crate?: string;
  crates?: string[];
  dateAdded: string;
  cues: CuePoint[];
  loops: LoopRegion[];
  coverArtUrl?: string;
  rating?: number;
  status: TrackStatus;
}

export interface ImportReport {
  id: string;
  format: LibraryFormat;
  sourceName: string;
  importedAt: string;
  trackCount: number;
  markers: string[];
  warnings: string[];
  sourceRootPath?: string;
  libraryFingerprint?: string;
  autoSyncOnStart?: boolean;
}

export interface ImportResult {
  report: ImportReport;
  tracks: Track[];
  previewUrls: Record<string, string>;
}

export const formatLabels: Record<LibraryFormat, string> = {
  djoo: 'Djoo',
  serato: 'Serato',
  engine: 'Engine DJ',
  traktor: 'Traktor'
};
