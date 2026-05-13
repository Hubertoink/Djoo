import type { ImportReport, ImportResult, LibraryFormat, Track } from '../domain/library';

export type ImportableFormat = Exclude<LibraryFormat, 'djoo'>;

export interface NativeLibraryCandidate {
  format: ImportableFormat;
  label: string;
  path: string;
  exists: boolean;
  markerFiles: number;
  audioFiles: number;
  markers: string[];
  warning?: string;
}

export interface NativeTrackDraft extends Track {
  previewUrl: string;
}

export interface NativeScanOptions {
  incremental?: boolean;
  previousTracks?: Track[];
}

export interface NativeScanResult {
  format: ImportableFormat;
  rootPath: string;
  sourceName: string;
  importedAt: string;
  libraryFingerprint: string;
  tracks: NativeTrackDraft[];
  markers: string[];
  warnings: string[];
  scannedFiles: number;
  markerFiles: number;
  audioFiles: number;
}

export interface NativeLibrarySyncStatus {
  format: ImportableFormat;
  rootPath: string;
  exists: boolean;
  fingerprint: string;
  changed: boolean;
  reason: string;
}

export interface NativeLibraryState {
  version: number;
  savedAt?: string;
  tracks: Track[];
  reports: ImportReport[];
  previewUrls: Record<string, string>;
}

export interface NativePathFixSuggestion {
  trackId: string;
  title: string;
  artist: string;
  currentPath: string;
  suggestedPath: string;
  reason: string;
  confidence: number;
}

export interface NativeRelocateResult {
  trackId: string;
  title: string;
  artist: string;
  previousPath: string;
  selectedPath: string;
}

export interface NativeBulkRelocateResult {
  rootPath: string;
  scannedFiles?: number;
  audioFiles?: number;
  truncated?: boolean;
  relocated: NativeRelocateResult[];
  unmatched: Array<{
    trackId: string;
    title: string;
    artist: string;
    previousPath: string;
  }>;
}

export interface NativeSyncCommitRequest {
  sourceFormat: LibraryFormat;
  targetFormat: ImportableFormat;
  targetPath: string;
  replaceTargetLibrary?: boolean;
  confirmedReplaceTarget?: boolean;
  updateTargetPlaylists?: boolean;
  playlistNames?: string[];
  tracks?: Track[];
  trackCount: number;
  addCount: number;
  keepCount: number;
  removeCandidateCount: number;
}

export interface NativeSyncCommitResult {
  backupPath: string;
  manifestPath: string;
  committed: boolean;
  exportedFiles?: string[];
  replacedTargetLibrary?: boolean;
  reimportedTrackCount?: number;
  reimportedCueTrackCount?: number;
  warnings: string[];
}

export interface DjooNativeBridge {
  platform: string;
  discoverLibraries: () => Promise<NativeLibraryCandidate[]>;
  scanLibrary: (request: { format: ImportableFormat; rootPath: string; incremental?: boolean; previousTracks?: Track[] }) => Promise<NativeScanResult>;
  getLibrarySyncStatus: (request: { format: ImportableFormat; rootPath: string; previousFingerprint?: string }) => Promise<NativeLibrarySyncStatus>;
  chooseLibraryFolder: (format: ImportableFormat) => Promise<NativeScanResult | null>;
  loadLibraryState: () => Promise<NativeLibraryState | null>;
  saveLibraryState: (state: NativeLibraryState) => Promise<{ savedAt: string; path: string }>;
  getCoverArt: (filePath: string) => Promise<string>;
  suggestPathFixes: (tracks: Track[]) => Promise<NativePathFixSuggestion[]>;
  relocateTrackFile: (track: Track) => Promise<NativeRelocateResult | null>;
  relocateMissingTracks: (tracks: Track[]) => Promise<NativeBulkRelocateResult | null>;
  commitSync: (request: NativeSyncCommitRequest) => Promise<NativeSyncCommitResult>;
}

declare global {
  interface Window {
    djooNative?: DjooNativeBridge;
  }
}

export function hasDesktopBridge() {
  return Boolean(window.djooNative);
}

export function discoverNativeLibraries() {
  return getBridge().discoverLibraries();
}

export function scanNativeLibrary(format: ImportableFormat, rootPath: string, options: NativeScanOptions = {}) {
  return getBridge().scanLibrary({ format, rootPath, ...options });
}

export function getNativeLibrarySyncStatus(format: ImportableFormat, rootPath: string, previousFingerprint?: string) {
  return getBridge().getLibrarySyncStatus({ format, rootPath, previousFingerprint });
}

export function chooseNativeLibraryFolder(format: ImportableFormat) {
  return getBridge().chooseLibraryFolder(format);
}

export function loadNativeLibraryState() {
  return getBridge().loadLibraryState();
}

export function saveNativeLibraryState(state: NativeLibraryState) {
  return getBridge().saveLibraryState(state);
}

export function getNativeCoverArt(filePath: string) {
  return getBridge().getCoverArt(filePath);
}

export function suggestNativePathFixes(tracks: Track[]) {
  return getBridge().suggestPathFixes(tracks);
}

export function relocateNativeTrackFile(track: Track) {
  return getBridge().relocateTrackFile(track);
}

export function relocateNativeMissingTracks(tracks: Track[]) {
  return getBridge().relocateMissingTracks(tracks);
}

export function commitNativeSync(request: NativeSyncCommitRequest) {
  return getBridge().commitSync(request);
}

export function nativeScanToImportResult(scanResult: NativeScanResult): ImportResult {
  const previewUrls: Record<string, string> = {};
  const tracks = scanResult.tracks.map((trackDraft) => {
    const { previewUrl, ...track } = trackDraft;
    previewUrls[track.id] = previewUrl;
    return track;
  });

  return {
    report: {
      id: `native-report-${scanResult.format}-${Date.now()}`,
      format: scanResult.format,
      sourceName: scanResult.sourceName,
      importedAt: scanResult.importedAt,
      trackCount: tracks.length,
      markers: scanResult.markers,
      warnings: scanResult.warnings,
      sourceRootPath: scanResult.rootPath,
      libraryFingerprint: scanResult.libraryFingerprint,
      autoSyncOnStart: true
    },
    tracks,
    previewUrls
  };
}

function getBridge() {
  if (!window.djooNative) {
    throw new Error('Djoo Desktop Bridge is not available.');
  }

  return window.djooNative;
}
