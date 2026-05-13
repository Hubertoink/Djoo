import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowRightLeft,
  AudioLines,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FileAudio,
  FolderInput,
  Gauge,
  HardDriveDownload,
  ListMusic,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Shuffle,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
  Wrench,
  XCircle
} from 'lucide-react';
import backgroundFloat from '../assets/Background_Float_Gradient.png';
import { seedTracks } from './data/seedTracks';
import type { ImportReport, ImportResult, LibraryFormat, Track } from './domain/library';
import { formatLabels } from './domain/library';
import { useLocalStorage } from './hooks/useLocalStorage';
import { normalizeCamelotKey } from './services/camelot';
import type { NativeBulkRelocateResult, NativeLibraryCandidate, NativePathFixSuggestion, NativeRelocateResult, NativeScanResult, NativeSyncCommitResult } from './services/desktopBridge';
import {
  chooseNativeLibraryFolder,
  commitNativeSync,
  discoverNativeLibraries,
  getNativeLibrarySyncStatus,
  getNativeCoverArt,
  hasDesktopBridge,
  loadNativeLibraryState,
  nativeScanToImportResult,
  relocateNativeMissingTracks,
  relocateNativeTrackFile,
  saveNativeLibraryState,
  scanNativeLibrary,
  suggestNativePathFixes
} from './services/desktopBridge';
import { findDuplicateCandidates } from './services/duplicates';
import { importFilesFromDirectory } from './services/importAdapters';
import { suggestedLibraryLocations } from './services/libraryDiscovery';

type ViewId = 'library' | 'import' | 'sync' | 'playlists' | 'fixes' | 'settings';
type ImportableFormat = Exclude<LibraryFormat, 'djoo'>;
type StatusFilter = Track['status'] | 'all';

interface BlockingTask {
  title: string;
  detail: string;
}

interface RepairSummary {
  title: string;
  details: string[];
  wroteToVendorLibrary: boolean;
}

interface SyncConfirmState {
  plan: SyncPlan;
}

interface SyncPlan {
  sourceFormat: LibraryFormat;
  targetLabel: string;
  targetFormat: ImportableFormat;
  targetPath: string;
  sourceTracks: Track[];
  targetTrackKeys: string[];
  includeAllTracks: boolean;
  selectedPlaylistNames?: string[];
  djooCount: number;
  targetCount: number;
  keepCount: number;
  addCount: number;
  removeCandidateCount: number;
  warnings: string[];
}

interface PlaylistCompareRow {
  name: string;
  targetName: string;
  sourceCount: number;
  targetCount: number;
  status: 'same' | 'missing' | 'different';
}

type PlaylistStatusFilter = 'all' | 'updates' | PlaylistCompareRow['status'];

interface MetadataGapSummary {
  format: LibraryFormat;
  total: number;
  ready: number;
  missingFiles: number;
  needsReview: number;
  missingBpm: number;
  missingKey: number;
  missingCues: number;
}

interface DuplicateCleanupSuggestion {
  candidateId: string;
  removeTrackId: string;
  keepTrackId: string;
  reason: string;
}

const views: Array<{ id: ViewId; label: string; icon: typeof ListMusic }> = [
  { id: 'library', label: 'Library', icon: ListMusic },
  { id: 'import', label: 'Import', icon: FolderInput },
  { id: 'sync', label: 'Sync', icon: HardDriveDownload },
  { id: 'playlists', label: 'Playlists', icon: ArrowRightLeft },
  { id: 'fixes', label: 'Fixes', icon: Wrench },
  { id: 'settings', label: 'Settings', icon: Settings }
];

const importFormats: ImportableFormat[] = ['serato', 'engine', 'traktor'];


function SyncConfirmModal(props: {
  state: SyncConfirmState;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { state, busy, onCancel, onConfirm } = props;

  return (
    <div className="blocking-overlay" role="dialog" aria-modal="true" aria-labelledby="sync-confirm-title">
      <div className="confirm-modal">
        <div className="confirm-header">
          <div className="confirm-icon">
            <ShieldCheck size={20} />
          </div>
          <div>
            <p>Sync bestaetigen</p>
            <h2 id="sync-confirm-title">{state.plan.targetLabel} komplett ersetzen?</h2>
          </div>
        </div>

        <div className="confirm-copy">
          <p>{formatLabels[state.plan.sourceFormat]} wird als neue Serato Library geschrieben. {getSyncPlaylistSelectionText(state.plan)}</p>
          <ul>
            <li>{state.plan.targetCount} Tracks sind aktuell im Ziel vorhanden.</li>
            <li>Nach dem Replace bleiben {state.plan.djooCount} Tracks im Serato-Ziel.</li>
            <li>{state.plan.removeCandidateCount} Ziel-Tracks und vorhandene Serato-Crates fallen aus dem aktiven Ziel heraus.</li>
            <li>Djoo erstellt vorher ein Backup und importiert das Ergebnis danach direkt wieder.</li>
            <li>Serato sollte waehrend des Commits geschlossen sein, damit es die neuen Crates beim naechsten Start frisch einliest.</li>
            <li>Audiodateien werden nicht geloescht.</li>
          </ul>
        </div>

        <div className="confirm-actions">
          <button className="ghost-button" onClick={onCancel} disabled={busy}>Abbrechen</button>
          <button className="primary-button" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}
            Backup + Serato ersetzen
          </button>
        </div>
      </div>
    </div>
  );
}
const statusLabels: Record<Track['status'], string> = {
  ready: 'Ready',
  'missing-file': 'Missing Files',
  'needs-review': 'Needs Review'
};

export function App() {
  const [tracks, setTracks] = useLocalStorage<Track[]>('djoo.library.tracks', seedTracks);
  const [reports, setReports] = useLocalStorage<ImportReport[]>('djoo.import.reports', []);
  const [activeView, setActiveView] = useState<ViewId>('library');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<LibraryFormat | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedImportFormat, setSelectedImportFormat] = useState<ImportableFormat>('engine');
  const [importBusy, setImportBusy] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeMessage, setNativeMessage] = useState('');
  const [nativeCandidates, setNativeCandidates] = useState<NativeLibraryCandidate[]>([]);
  const [isDesktopApp] = useState(() => hasDesktopBridge());
  const [nativeStateReady, setNativeStateReady] = useState(() => !hasDesktopBridge());
  const [syncSourceFormat, setSyncSourceFormat] = useState<LibraryFormat>('djoo');
  const [syncTargetFormat, setSyncTargetFormat] = useState<ImportableFormat>('serato');
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncCommitBusy, setSyncCommitBusy] = useState(false);
  const [syncPlan, setSyncPlan] = useState<SyncPlan | null>(null);
  const [syncCommitResult, setSyncCommitResult] = useState<NativeSyncCommitResult | null>(null);
  const [syncSelectedPlaylistsByKey, setSyncSelectedPlaylistsByKey] = useLocalStorage<Record<string, string[]>>('djoo.sync.selectedPlaylists', {});
  const [syncIncludeAllTracksByKey, setSyncIncludeAllTracksByKey] = useLocalStorage<Record<string, boolean>>('djoo.sync.includeAllTracks', {});
  const [playlistSourceFormat, setPlaylistSourceFormat] = useState<ImportableFormat>('engine');
  const [playlistTargetFormat, setPlaylistTargetFormat] = useState<ImportableFormat>('serato');
  const [playlistSourceScan, setPlaylistSourceScan] = useState<NativeScanResult | null>(null);
  const [playlistTargetScan, setPlaylistTargetScan] = useState<NativeScanResult | null>(null);
  const [playlistCompareBusy, setPlaylistCompareBusy] = useState(false);
  const [playlistCommitBusy, setPlaylistCommitBusy] = useState(false);
  const [playlistMessage, setPlaylistMessage] = useState('');
  const [playlistCommitResult, setPlaylistCommitResult] = useState<NativeSyncCommitResult | null>(null);
  const [pathFixes, setPathFixes] = useState<NativePathFixSuggestion[]>([]);
  const [pathFixBusy, setPathFixBusy] = useState(false);
  const [blockingTask, setBlockingTask] = useState<BlockingTask | null>(null);
  const [repairSummary, setRepairSummary] = useState<RepairSummary | null>(null);
  const [syncConfirmState, setSyncConfirmState] = useState<SyncConfirmState | null>(null);
  const [coverArtUrl, setCoverArtUrl] = useState('');
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [selectedTrackId, setSelectedTrackId] = useState(tracks[0]?.id ?? '');
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [playerError, setPlayerError] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlsRef = useRef(previewUrls);

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? tracks[0];

  const filteredTracks = useMemo(() => {
    const normalizedQuery = query.toLowerCase().trim();

    return tracks.filter((track) => {
      const matchesSource = sourceFilter === 'all' || track.sourceFormat === sourceFilter;
      const matchesStatus = statusFilter === 'all' || track.status === statusFilter;
      const crateText = Array.isArray(track.crates) ? track.crates.join(' ') : track.crate;
      const haystack = [track.title, track.artist, track.genre, track.musicalKey, crateText, track.sourcePath]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return matchesSource && matchesStatus && (!normalizedQuery || haystack.includes(normalizedQuery));
    });
  }, [query, sourceFilter, statusFilter, tracks]);

  const sameLibraryDuplicates = useMemo(() => findDuplicateCandidates(tracks, { sameSourceOnly: true }), [tracks]);
  const duplicateCleanupSuggestions = useMemo(() => createDuplicateCleanupSuggestions(sameLibraryDuplicates), [sameLibraryDuplicates]);
  const duplicateTrackIds = useMemo(() => {
    const ids = new Set<string>();
    sameLibraryDuplicates.forEach((candidate) => candidate.tracks.forEach((track) => ids.add(track.id)));
    return ids;
  }, [sameLibraryDuplicates]);
  const metadataGaps = useMemo(() => createMetadataGapSummary(tracks), [tracks]);
  const tracksWithPreview = Object.keys(previewUrls).length;
  const availableLibraryFormats = useMemo(() => {
    const importedFormats = importFormats.filter((format) => tracks.some((track) => track.sourceFormat === format));
    return ['djoo', ...importedFormats] as LibraryFormat[];
  }, [tracks]);

  const missingTrackCount = useMemo(() => tracks.filter((track) => track.status === 'missing-file').length, [tracks]);

  useEffect(() => {
    previewUrlsRef.current = previewUrls;
  }, [previewUrls]);

  useEffect(() => {
    if (!availableLibraryFormats.includes(sourceFilter as LibraryFormat)) {
      setSourceFilter('all');
    }

    if (!availableLibraryFormats.includes(syncSourceFormat)) {
      setSyncSourceFormat('djoo');
    }

    const availableTargets = availableLibraryFormats.filter((format): format is ImportableFormat => format !== 'djoo');

    if (availableTargets.length > 0 && !availableTargets.includes(syncTargetFormat)) {
      setSyncTargetFormat(availableTargets[0]);
    }

    if (availableTargets.length > 0 && !availableTargets.includes(playlistSourceFormat)) {
      setPlaylistSourceFormat(availableTargets[0]);
    }

    if (availableTargets.length > 0 && !availableTargets.includes(playlistTargetFormat)) {
      setPlaylistTargetFormat(availableTargets[0]);
    }
  }, [availableLibraryFormats, playlistSourceFormat, playlistTargetFormat, sourceFilter, syncSourceFormat, syncTargetFormat]);

  useEffect(() => {
    const storedCoverArtUrl = selectedTrack?.coverArtUrl ?? '';

    if (!isDesktopApp || !selectedTrack?.sourcePath || selectedTrack.status === 'missing-file') {
      setCoverArtUrl(storedCoverArtUrl);
      return;
    }

    let cancelled = false;
    setCoverArtUrl(storedCoverArtUrl);

    getNativeCoverArt(selectedTrack.sourcePath)
      .then((artUrl) => {
        if (!cancelled) {
          setCoverArtUrl(artUrl || storedCoverArtUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCoverArtUrl(storedCoverArtUrl);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDesktopApp, selectedTrack?.coverArtUrl, selectedTrack?.id, selectedTrack?.sourcePath, selectedTrack?.status]);

  useEffect(() => {
    if (!isDesktopApp) {
      return;
    }

    let cancelled = false;

    loadNativeLibraryState()
      .then(async (state) => {
        if (cancelled || !state) {
          return;
        }

        let nextState = {
          tracks: state.tracks.length > 0 ? state.tracks : seedTracks,
          reports: state.reports ?? [],
          previewUrls: state.previewUrls ?? {}
        };

        nextState = {
          ...nextState,
          reports: await hydrateStartupImportReports(nextState.reports)
        };

        setTracks(nextState.tracks);
        setReports(nextState.reports);
        setPreviewUrls(nextState.previewUrls);
        setSelectedTrackId(nextState.tracks[0]?.id ?? seedTracks[0].id);
        setNativeMessage(`Persistente Library geladen: ${nextState.tracks.length} Tracks.`);

        const startupReports = getStartupImportSyncReports(nextState.reports);

        if (startupReports.length === 0) {
          return;
        }

        setBlockingTask({
          title: 'Import-Sync wird geprueft',
          detail: `${startupReports.length} importierte Librarys werden auf Aenderungen geprueft.`
        });

        const startupSync = await refreshImportedLibrariesOnStart(startupReports, nextState);

        if (cancelled) {
          return;
        }

        nextState = startupSync.state;
        setTracks(nextState.tracks);
        setReports(nextState.reports);
        setPreviewUrls(nextState.previewUrls);
        setSelectedTrackId(nextState.tracks[0]?.id ?? seedTracks[0].id);
        setNativeMessage(createStartupImportSyncMessage(nextState.tracks.length, startupSync.updatedFormats, startupSync.warnings));
      })
      .catch((error) => setNativeMessage(getErrorMessage(error)))
      .finally(() => {
        if (!cancelled) {
          setBlockingTask(null);
          setNativeStateReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDesktopApp, setReports, setTracks]);

  useEffect(() => {
    if (!isDesktopApp || !nativeStateReady) {
      return;
    }

    const persistTimer = window.setTimeout(() => {
      const durablePreviewUrls = Object.fromEntries(
        Object.entries(previewUrls).filter(([, url]) => url.startsWith('file:'))
      );

      saveNativeLibraryState({
        version: 1,
        tracks,
        reports,
        previewUrls: durablePreviewUrls
      }).catch((error) => setNativeMessage(getErrorMessage(error)));
    }, 700);

    return () => window.clearTimeout(persistTimer);
  }, [isDesktopApp, nativeStateReady, previewUrls, reports, tracks]);

  useEffect(() => {
    return () => {
      Object.values(previewUrlsRef.current)
        .filter((url) => url.startsWith('blob:'))
        .forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  async function handleDirectorySelected(event: ChangeEvent<HTMLInputElement>) {
    if (!event.currentTarget.files) {
      return;
    }

    const selectedFileCount = event.currentTarget.files.length;
    setImportBusy(true);
    setPlayerError('');
    setBlockingTask({
      title: `${formatLabels[selectedImportFormat]} Ordner wird importiert`,
      detail: `${selectedFileCount} Dateien werden im Browser gelesen. Audiofiles werden fuer Preview vorbereitet.`
    });

    try {
      const result = await importFilesFromDirectory(event.currentTarget.files, selectedImportFormat);
      ingestImportResult(result);
    } finally {
      setImportBusy(false);
      setBlockingTask(null);
      event.currentTarget.value = '';
    }
  }

  function ingestImportResult(result: ImportResult, options: { nextView?: ViewId } = {}) {
    const nextState = applyImportResultToLibraryState({ tracks, reports, previewUrls }, result);
    setTracks(nextState.tracks);
    setReports(nextState.reports);
    setPreviewUrls(nextState.previewUrls);
    setSelectedTrackId(result.tracks[0]?.id ?? selectedTrackId);
    setActiveView(options.nextView ?? 'library');
  }

  function handleSetImportAutoSync(format: ImportableFormat, enabled: boolean) {
    setReports((currentReports) => updateImportAutoSyncReports(currentReports, format, enabled));
  }

  async function handleNativeDiscover() {
    setNativeBusy(true);
    setNativeMessage('');
    setBlockingTask({
      title: 'Library-Orte werden gesucht',
      detail: 'Djoo prueft typische Serato-, Engine-DJ- und Traktor-Pfade read-only.'
    });

    try {
      const candidates = await discoverNativeLibraries();
      const foundCount = candidates.filter((candidate) => candidate.exists).length;
      setNativeCandidates(candidates);
      setNativeMessage(`${foundCount} typische Library-Orte gefunden.`);
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setNativeBusy(false);
      setBlockingTask(null);
    }
  }

  async function handleNativeCandidateScan(candidate: NativeLibraryCandidate) {
    setNativeBusy(true);
    setNativeMessage(`Scanne ${candidate.label}...`);
    setBlockingTask({
      title: `${candidate.label} wird importiert`,
      detail: `${formatLabels[candidate.format]} wird read-only gescannt. Datenbanken, Marker, BPM, Keys, Hotcues und lokale Audio-Pfade werden zusammengefuehrt.`
    });

    try {
      const scanResult = await scanNativeLibrary(candidate.format, candidate.path);
      ingestImportResult(nativeScanToImportResult(scanResult));
      setNativeMessage(formatScanMessage(scanResult));
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setNativeBusy(false);
      setBlockingTask(null);
    }
  }

  async function handleNativeFolderPick() {
    setNativeBusy(true);
    setNativeMessage('');
    setBlockingTask({
      title: `${formatLabels[selectedImportFormat]} Ordner auswaehlen`,
      detail: 'Nach der Auswahl scannt Djoo den Ordner read-only und importiert Metadaten, Marker und lokale Pfade.'
    });

    try {
      const scanResult = await chooseNativeLibraryFolder(selectedImportFormat);

      if (!scanResult) {
        setNativeMessage('Ordnerauswahl abgebrochen.');
        return;
      }

      ingestImportResult(nativeScanToImportResult(scanResult));
      setNativeMessage(formatScanMessage(scanResult));
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setNativeBusy(false);
      setBlockingTask(null);
    }
  }

  function handlePlay(track: Track) {
    setSelectedTrackId(track.id);
    setPlayerError('');

    if (playingTrackId === track.id) {
      audioRef.current?.pause();
      setPlayingTrackId(null);
      return;
    }

    const previewUrl = previewUrls[track.id];

    if (!previewUrl) {
      setPlayerError('Fuer diesen Track ist noch keine lokale Audiodatei im Browser geladen. Importiere einen Musikordner zum Testhoeren.');
      setPlayingTrackId(null);
      return;
    }

    if (!audioRef.current) {
      audioRef.current = new Audio();
    }

    audioRef.current.src = previewUrl;
    audioRef.current.onended = () => setPlayingTrackId(null);
    audioRef.current.play().then(() => setPlayingTrackId(track.id)).catch(() => {
      setPlayerError('Preview konnte nicht gestartet werden. Pruefe Dateiformat oder Browser-Freigabe.');
      setPlayingTrackId(null);
    });
  }

  function resetDemoLibrary() {
    setTracks(seedTracks);
    setReports([]);
    setPreviewUrls({});
    setSelectedTrackId(seedTracks[0].id);
    setPlayingTrackId(null);
    setPlayerError('');
  }

  async function refreshImportedLibrariesOnStart(startupReports: ImportReport[], initialState: { tracks: Track[]; reports: ImportReport[]; previewUrls: Record<string, string> }) {
    let nextState = initialState;
    const updatedFormats: string[] = [];
    const warnings: string[] = [];

    for (const report of startupReports) {
      if (!report.sourceRootPath || report.format === 'djoo') {
        continue;
      }

      try {
        const syncStatus = await getNativeLibrarySyncStatus(report.format as ImportableFormat, report.sourceRootPath, report.libraryFingerprint);

        if (!syncStatus.exists) {
          warnings.push(`${formatLabels[report.format]} nicht gefunden: ${report.sourceRootPath}`);
          continue;
        }

        if (!syncStatus.changed) {
          continue;
        }

        const scanResult = await scanNativeLibrary(
          report.format as ImportableFormat,
          report.sourceRootPath,
          report.format === 'engine'
            ? {
                incremental: true,
                previousTracks: nextState.tracks.filter((track) => track.sourceFormat === 'engine')
              }
            : {}
        );
        nextState = applyImportResultToLibraryState(nextState, nativeScanToImportResult(scanResult));
        updatedFormats.push(formatLabels[report.format]);
      } catch (error) {
        warnings.push(`${formatLabels[report.format]} Auto-Sync fehlgeschlagen: ${getErrorMessage(error)}`);
      }
    }

    return { state: nextState, updatedFormats, warnings };
  }

  async function hydrateStartupImportReports(currentReports: ImportReport[]) {
    const reportsNeedingPath = currentReports.filter((report) => report.format !== 'djoo' && !report.sourceRootPath);

    if (reportsNeedingPath.length === 0) {
      return currentReports;
    }

    try {
      const candidates = await discoverNativeLibraries();
      const candidatesByFormat = new Map<ImportableFormat, NativeLibraryCandidate[]>();

      for (const candidate of candidates.filter((candidate) => candidate.exists)) {
        const currentCandidates = candidatesByFormat.get(candidate.format) || [];
        currentCandidates.push(candidate);
        candidatesByFormat.set(candidate.format, currentCandidates);
      }

      return currentReports.map((report) => {
        if (report.format === 'djoo' || report.sourceRootPath) {
          return report;
        }

        const formatCandidates = candidatesByFormat.get(report.format as ImportableFormat) || [];

        if (formatCandidates.length !== 1) {
          return report;
        }

        return {
          ...report,
          sourceRootPath: formatCandidates[0].path,
          autoSyncOnStart: true
        };
      });
    } catch {
      return currentReports;
    }
  }

  function handleSyncSourceFormatChange(format: LibraryFormat) {
    setSyncSourceFormat(format);
    setSyncPlan(null);
    setSyncCommitResult(null);
  }

  function handleSyncTargetFormatChange(format: ImportableFormat) {
    setSyncTargetFormat(format);
    setSyncPlan(null);
    setSyncCommitResult(null);
  }

  function handleSyncPlaylistSelectionChange(playlistNames: string[]) {
    if (!syncPlan) {
      return;
    }

    const nextPlan = applySyncPlaylistSelection(syncPlan, playlistNames);
    const selectionKey = getSyncSelectionKey(nextPlan.sourceFormat, nextPlan.targetFormat);
    setSyncPlan(nextPlan);
    setSyncCommitResult(null);
    setSyncSelectedPlaylistsByKey((currentSelections) => ({
      ...currentSelections,
      [selectionKey]: nextPlan.selectedPlaylistNames ?? []
    }));
  }

  function handleSyncIncludeAllTracksChange(includeAllTracks: boolean) {
    if (!syncPlan) {
      return;
    }

    const nextPlan = applySyncIncludeAllTracks(syncPlan, includeAllTracks);
    const selectionKey = getSyncSelectionKey(nextPlan.sourceFormat, nextPlan.targetFormat);
    setSyncPlan(nextPlan);
    setSyncCommitResult(null);
    setSyncIncludeAllTracksByKey((currentSelections) => ({
      ...currentSelections,
      [selectionKey]: includeAllTracks
    }));
  }

  async function handleBuildSyncPlan(candidate: NativeLibraryCandidate) {
    setSyncBusy(true);
    setSyncPlan(null);
    setSyncCommitResult(null);
    setBlockingTask({
      title: 'Sync-Diff wird erstellt',
      detail: `${formatLabels[syncSourceFormat]} und ${candidate.label} werden read-only gescannt und verglichen.`
    });

    try {
      let sourceTracks = getSyncSourceTracks(tracks, syncSourceFormat);

      if (syncSourceFormat !== 'djoo') {
        const sourceCandidate = nativeCandidates.find((libraryCandidate) => libraryCandidate.exists && libraryCandidate.format === syncSourceFormat);

        if (sourceCandidate) {
          const sourceScan = await scanNativeLibrary(sourceCandidate.format, sourceCandidate.path);
          const sourceResult = nativeScanToImportResult(sourceScan);
          sourceTracks = getSyncSourceTracks(sourceResult.tracks, syncSourceFormat);
          ingestImportResult(sourceResult, { nextView: 'sync' });
        }
      }

      const targetScan = await scanNativeLibrary(candidate.format, candidate.path);
      setSyncPlan(createSyncPlan(tracks, targetScan, candidate.label, syncSourceFormat, sourceTracks, syncSelectedPlaylistsByKey, syncIncludeAllTracksByKey));
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setSyncBusy(false);
      setBlockingTask(null);
    }
  }

  async function handleBuildPlaylistCompare() {
    if (!isDesktopApp) {
      setPlaylistMessage('Playlist-Vergleich benoetigt die Desktop Bridge.');
      return;
    }

    if (playlistSourceFormat === playlistTargetFormat) {
      setPlaylistMessage('Quelle und Ziel muessen unterschiedliche Librarys sein.');
      return;
    }

    setPlaylistCompareBusy(true);
    setPlaylistCommitResult(null);
    setPlaylistMessage('');
    setBlockingTask({
      title: 'Playlists werden verglichen',
      detail: `${formatLabels[playlistSourceFormat]} und ${formatLabels[playlistTargetFormat]} werden read-only gescannt.`
    });

    try {
      let candidates = nativeCandidates;

      if (candidates.length === 0) {
        candidates = await discoverNativeLibraries();
        setNativeCandidates(candidates);
      }

      const sourceCandidate = getNativeCandidateForFormat(candidates, playlistSourceFormat);
      const targetCandidate = getNativeCandidateForFormat(candidates, playlistTargetFormat);

      if (!sourceCandidate || !targetCandidate) {
        throw new Error('Quelle oder Ziel wurde nicht gefunden. Nutze Import > Librarys finden oder waehle den Ordner manuell.');
      }

      const [sourceScan, targetScan] = await Promise.all([
        scanNativeLibrary(sourceCandidate.format, sourceCandidate.path),
        scanNativeLibrary(targetCandidate.format, targetCandidate.path)
      ]);

      setPlaylistSourceScan(sourceScan);
      setPlaylistTargetScan(targetScan);
      setPlaylistMessage(`${formatLabels[sourceScan.format]}: ${createPlaylistSummaries(sourceScan.tracks).length} Playlists. ${formatLabels[targetScan.format]}: ${createPlaylistSummaries(targetScan.tracks).length} Playlists.`);
    } catch (error) {
      setPlaylistMessage(getErrorMessage(error));
    } finally {
      setPlaylistCompareBusy(false);
      setBlockingTask(null);
    }
  }

  async function handleApplyPlaylistUpdate(playlistNames: string[]) {
    if (!playlistSourceScan || !playlistTargetScan) {
      setPlaylistMessage('Bitte zuerst den Playlist-Vergleich laden.');
      return;
    }

    if (playlistTargetScan.format !== 'serato') {
      setPlaylistMessage('Aktive Playlist-Updates sind aktuell nur fuer Serato-Ziele freigeschaltet.');
      return;
    }

    const selectedPlaylistNames = playlistNames.map((playlistName) => playlistName.trim()).filter(Boolean);

    if (selectedPlaylistNames.length === 0) {
      return;
    }

    const selectedTrackCount = countTracksInPlaylists(playlistSourceScan.tracks, selectedPlaylistNames);
    setPlaylistCommitBusy(true);
    setPlaylistMessage('');
    setBlockingTask({
      title: selectedPlaylistNames.length === 1 ? 'Playlist wird aktualisiert' : 'Playlists werden aktualisiert',
      detail: `${selectedPlaylistNames.length} Playlist(s) werden mit Backup aktiv nach Serato geschrieben.`
    });

    try {
      const result = await commitNativeSync({
        sourceFormat: playlistSourceScan.format,
        targetFormat: playlistTargetScan.format,
        targetPath: playlistTargetScan.rootPath,
        updateTargetPlaylists: true,
        playlistNames: selectedPlaylistNames,
        tracks: playlistSourceScan.tracks,
        trackCount: selectedTrackCount,
        addCount: selectedTrackCount,
        keepCount: 0,
        removeCandidateCount: 0
      });

      const refreshedTargetScan = await scanNativeLibrary(playlistTargetScan.format, playlistTargetScan.rootPath);
      setPlaylistTargetScan(refreshedTargetScan);
      setPlaylistCommitResult(result);
      ingestImportResult(nativeScanToImportResult(refreshedTargetScan), { nextView: 'playlists' });
      setPlaylistMessage(`${selectedPlaylistNames.length} Playlist(s) nach Serato aktualisiert und Ziel danach neu gelesen.`);
    } catch (error) {
      setPlaylistMessage(getErrorMessage(error));
    } finally {
      setPlaylistCommitBusy(false);
      setBlockingTask(null);
    }
  }

  async function handleFindPathFixes() {
    const missingBefore = tracks.filter((track) => track.status === 'missing-file').length;

    if (!isDesktopApp) {
      setRepairSummary({
        title: 'Path Fix nicht gestartet',
        details: ['Die Desktop Bridge ist nicht aktiv. Djoo kann lokale Dateien nur in der Desktop-App automatisch pruefen.', 'Serato Library wurde nicht geaendert.'],
        wroteToVendorLibrary: false
      });
      return;
    }

    setPathFixBusy(true);
    setBlockingTask({
      title: 'Fehlende Dateien werden gesucht',
      detail: `${missingBefore} Missing Files werden gegen typische Userpfad-Migrationen geprueft.`
    });

    try {
      const suggestions = await suggestNativePathFixes(tracks);
      setPathFixes(suggestions);
      setNativeMessage(`${suggestions.length} Pfadfix-Vorschlaege gefunden.`);
      setRepairSummary({
        title: 'Fix-Suche abgeschlossen',
        details: [
          `${suggestions.length} Vorschlaege fuer ${missingBefore} fehlende Dateien gefunden.`,
          suggestions.length > 0 ? 'Die Vorschlaege sind vorbereitet, aber noch nicht angewendet.' : 'Es wurde kein sicherer Ersatzpfad gefunden.',
          'Serato Library wurde nicht automatisch geaendert.'
        ],
        wroteToVendorLibrary: false
      });
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
      setRepairSummary({
        title: 'Fix-Suche fehlgeschlagen',
        details: [getErrorMessage(error), 'Serato Library wurde nicht geaendert.'],
        wroteToVendorLibrary: false
      });
    } finally {
      setPathFixBusy(false);
      setBlockingTask(null);
    }
  }

  async function handleApplyPathFixes(trackIds?: string[]) {
    const requestedTrackIds = trackIds ? new Set(trackIds) : null;
    const fixesToApply = requestedTrackIds
      ? pathFixes.filter((fix) => requestedTrackIds.has(fix.trackId))
      : pathFixes;

    if (fixesToApply.length === 0) {
      setRepairSummary({
        title: 'Kein Fix angewendet',
        details: ['Es gibt fuer die Auswahl keinen vorbereiteten Pfadfix.', 'Serato Library wurde nicht geaendert.'],
        wroteToVendorLibrary: false
      });
      return;
    }

    const fixedTrackIds = new Set(fixesToApply.map((fix) => fix.trackId));
    const fixedTracks = tracks.filter((track) => fixedTrackIds.has(track.id));

    setPathFixBusy(true);
    setBlockingTask({
      title: 'Relocate-Vorschlag wird angewendet',
      detail: `${fixesToApply.length} Pfade werden in Djoo aktualisiert.`
    });

    await nextPaint();
    applyPathFixesToLibrary(fixesToApply);
    setNativeMessage(`${fixesToApply.length} Pfade in Djoo aktualisiert. Externe Library wurde nicht automatisch geschrieben.`);
    setRepairSummary({
      title: 'Relocate-Vorschlag angewendet',
      details: [
        `${fixesToApply.length} Track-Pfade wurden in Djoo auf vorhandene lokale Dateien gesetzt.`,
        'Status wurde auf Ready gesetzt und die lokale Preview-URL wurde aktualisiert.',
        getVendorWritebackNotice(fixedTracks)
      ],
      wroteToVendorLibrary: false
    });
    setPathFixBusy(false);
    setBlockingTask(null);
  }

  async function handleAutoRelocateMissingTracks() {
    const missingTracks = tracks.filter((track) => track.status === 'missing-file');

    if (!isDesktopApp) {
      setRepairSummary({
        title: 'Auto-Relocate nicht gestartet',
        details: ['Auto-Relocate benoetigt die Desktop Bridge, damit Djoo lokale Ersatzpfade pruefen kann.', 'Externe Libraries wurden nicht geaendert.'],
        wroteToVendorLibrary: false
      });
      return;
    }

    if (missingTracks.length === 0) {
      setRepairSummary({
        title: 'Keine Missing Files',
        details: ['Es gibt aktuell keine fehlenden Dateien zum Relocaten.'],
        wroteToVendorLibrary: false
      });
      return;
    }

    setPathFixBusy(true);
    setBlockingTask({
      title: 'Auto-Relocate laeuft',
      detail: `${missingTracks.length} Missing Files werden gegen sichere Pfad-Migrationen geprueft und direkt in Djoo relocated.`
    });

    try {
      const suggestions = await suggestNativePathFixes(tracks);
      const suggestedTrackIds = new Set(suggestions.map((suggestion) => suggestion.trackId));
      const fixedTracks = tracks.filter((track) => suggestedTrackIds.has(track.id));

      if (suggestions.length > 0) {
        applyPathFixesToLibrary(suggestions);
      }

      const unresolvedCount = Math.max(0, missingTracks.length - suggestions.length);
      setNativeMessage(`${suggestions.length} Missing Files automatisch relocated, ${unresolvedCount} bleiben offen.`);
      setRepairSummary({
        title: 'Auto-Relocate abgeschlossen',
        details: [
          `${suggestions.length} von ${missingTracks.length} Missing Files wurden ueber sichere Pfad-Migrationen relocated.`,
          unresolvedCount > 0 ? `${unresolvedCount} Tracks brauchen noch Relocate per Ordner oder manuelle Dateiauswahl.` : 'Alle erkannten Missing Files sind in Djoo wieder Ready.',
          getVendorWritebackNotice(fixedTracks)
        ],
        wroteToVendorLibrary: false
      });

      if (suggestions.length === 0) {
        setPathFixes([]);
      }
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
      setRepairSummary({
        title: 'Auto-Relocate fehlgeschlagen',
        details: [getErrorMessage(error), 'Externe Libraries wurden nicht geaendert.'],
        wroteToVendorLibrary: false
      });
    } finally {
      setPathFixBusy(false);
      setBlockingTask(null);
    }
  }

  async function handleRelocateTrack(track: Track) {
    if (!isDesktopApp) {
      setRepairSummary({
        title: 'Relocate nicht gestartet',
        details: ['Relocate benoetigt die Desktop Bridge, damit Djoo eine lokale Audiodatei auswaehlen kann.', 'Serato Library wurde nicht geaendert.'],
        wroteToVendorLibrary: false
      });
      return;
    }

    setPathFixBusy(true);
    setBlockingTask({
      title: 'Relocate wird vorbereitet',
      detail: `${track.title} wartet auf eine neue lokale Audiodatei.`
    });

    try {
      const relocation = await relocateNativeTrackFile(track);

      if (!relocation) {
        setRepairSummary({
          title: 'Relocate abgebrochen',
          details: [`${track.title} wurde nicht veraendert.`, 'Serato Library wurde nicht geaendert.'],
          wroteToVendorLibrary: false
        });
        return;
      }

      applyRelocatedTrack(relocation);
      setSelectedTrackId(track.id);
      setNativeMessage(`${track.title} wurde in Djoo relocated. Externe Library wurde nicht automatisch geschrieben.`);
      setRepairSummary({
        title: 'Relocate abgeschlossen',
        details: [
          `${track.title} wurde auf ${relocation.selectedPath} gesetzt.`,
          'Djoo sourcePath, Status und lokale Preview-URL wurden aktualisiert.',
          getVendorWritebackNotice([track])
        ],
        wroteToVendorLibrary: false
      });
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
      setRepairSummary({
        title: 'Relocate fehlgeschlagen',
        details: [getErrorMessage(error), 'Serato Library wurde nicht geaendert.'],
        wroteToVendorLibrary: false
      });
    } finally {
      setPathFixBusy(false);
      setBlockingTask(null);
    }
  }

  async function handleRelocateMissingTracks() {
    const missingTracks = tracks.filter((track) => track.status === 'missing-file');

    if (!isDesktopApp) {
      setRepairSummary({
        title: 'Bulk Relocate nicht gestartet',
        details: ['Bulk Relocate benoetigt die Desktop Bridge, damit Djoo einen lokalen Ueberordner scannen kann.', 'Serato Library wurde nicht geaendert.'],
        wroteToVendorLibrary: false
      });
      return;
    }

    if (missingTracks.length === 0) {
      setRepairSummary({
        title: 'Keine Missing Files',
        details: ['Es gibt aktuell keine fehlenden Dateien zum Relocaten.'],
        wroteToVendorLibrary: false
      });
      return;
    }

    setPathFixBusy(true);
    setBlockingTask({
      title: 'Missing Files werden relocated',
      detail: `${missingTracks.length} fehlende Tracks werden nach Auswahl eines Ueberordners in dessen Unterordnern gesucht.`
    });

    try {
      const result = await relocateNativeMissingTracks(missingTracks);

      if (!result) {
        setRepairSummary({
          title: 'Bulk Relocate abgebrochen',
          details: ['Es wurde kein Ueberordner ausgewaehlt.', 'Serato Library wurde nicht geaendert.'],
          wroteToVendorLibrary: false
        });
        return;
      }

      applyRelocatedTracks(result.relocated);
      setNativeMessage(`${result.relocated.length} Missing Files in Djoo relocated. Externe Library wurde nicht automatisch geschrieben.`);
      setRepairSummary(createBulkRelocateSummary(result, missingTracks));
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
      setRepairSummary({
        title: 'Bulk Relocate fehlgeschlagen',
        details: [getErrorMessage(error), 'Serato Library wurde nicht geaendert.'],
        wroteToVendorLibrary: false
      });
    } finally {
      setPathFixBusy(false);
      setBlockingTask(null);
    }
  }

  function applyRelocatedTrack(relocation: NativeRelocateResult) {
    applyRelocatedTracks([relocation]);
  }

  function applyPathFixesToLibrary(fixesToApply: NativePathFixSuggestion[]) {
    const fixedTrackIds = new Set(fixesToApply.map((fix) => fix.trackId));
    const fixByTrackId = new Map(fixesToApply.map((fix) => [fix.trackId, fix]));

    setTracks((currentTracks) => currentTracks.map((track) => {
      const fix = fixByTrackId.get(track.id);

      if (!fix) {
        return track;
      }

      return {
        ...track,
        originalSourcePath: track.originalSourcePath || track.sourcePath,
        sourcePath: fix.suggestedPath,
        status: 'ready'
      };
    }));
    setPreviewUrls((currentUrls) => {
      const nextUrls = { ...currentUrls };
      fixesToApply.forEach((fix) => {
        nextUrls[fix.trackId] = pathToFileUrl(fix.suggestedPath);
      });
      return nextUrls;
    });
    setPathFixes((currentFixes) => currentFixes.filter((fix) => !fixedTrackIds.has(fix.trackId)));
  }

  function applyRelocatedTracks(relocations: NativeRelocateResult[]) {
    const relocationByTrackId = new Map(relocations.map((relocation) => [relocation.trackId, relocation]));

    setTracks((currentTracks) => currentTracks.map((track) => {
      const relocation = relocationByTrackId.get(track.id);

      if (!relocation) {
        return track;
      }

      return {
        ...track,
        originalSourcePath: track.originalSourcePath || track.sourcePath,
        sourcePath: relocation.selectedPath,
        status: 'ready'
      };
    }));
    setPreviewUrls((currentUrls) => {
      const nextUrls = { ...currentUrls };
      relocations.forEach((relocation) => {
        nextUrls[relocation.trackId] = pathToFileUrl(relocation.selectedPath);
      });
      return nextUrls;
    });
    setPathFixes((currentFixes) => currentFixes.filter((fix) => !relocationByTrackId.has(fix.trackId)));
  }

  function handleRemoveTrack(track: Track) {
    const nextSelectedTrackId = selectedTrackId === track.id
      ? tracks.find((candidate) => candidate.id !== track.id)?.id ?? ''
      : selectedTrackId;

    setTracks((currentTracks) => currentTracks.filter((candidate) => candidate.id !== track.id));
    setPreviewUrls((currentUrls) => {
      const nextUrls = { ...currentUrls };
      delete nextUrls[track.id];
      return nextUrls;
    });
    setPathFixes((currentFixes) => currentFixes.filter((fix) => fix.trackId !== track.id));
    setSelectedTrackId(nextSelectedTrackId);
    setRepairSummary({
      title: 'Track aus Djoo entfernt',
      details: [
        `${track.artist} - ${track.title} wurde nur aus der lokalen Djoo-Library entfernt.`,
        'Die Audiodatei wurde nicht geloescht.',
        getVendorWritebackNotice([track])
      ],
      wroteToVendorLibrary: false
    });
  }

  function handleApplyDuplicateCleanup(candidateIds?: string[]) {
    const requestedCandidateIds = candidateIds ? new Set(candidateIds) : null;
    const suggestionsToApply = requestedCandidateIds
      ? duplicateCleanupSuggestions.filter((suggestion) => requestedCandidateIds.has(suggestion.candidateId))
      : duplicateCleanupSuggestions;
    const removeTrackIds = new Set(suggestionsToApply.map((suggestion) => suggestion.removeTrackId));

    if (removeTrackIds.size === 0) {
      setRepairSummary({
        title: 'Keine sicheren Duplikat-Fixes',
        details: ['Djoo hat fuer die aktuelle Duplikatliste keinen sicheren Auto-Cleanup-Vorschlag gefunden.', 'Nutze Pruefen oder Entfernen fuer die Edge Cases.'],
        wroteToVendorLibrary: false
      });
      return;
    }

    const removedTracks = tracks.filter((track) => removeTrackIds.has(track.id));
    const nextSelectedTrackId = removeTrackIds.has(selectedTrackId)
      ? tracks.find((track) => !removeTrackIds.has(track.id))?.id ?? ''
      : selectedTrackId;

    setTracks((currentTracks) => currentTracks.filter((track) => !removeTrackIds.has(track.id)));
    setPreviewUrls((currentUrls) => {
      const nextUrls = { ...currentUrls };
      removeTrackIds.forEach((trackId) => delete nextUrls[trackId]);
      return nextUrls;
    });
    setPathFixes((currentFixes) => currentFixes.filter((fix) => !removeTrackIds.has(fix.trackId)));
    setSelectedTrackId(nextSelectedTrackId);
    setRepairSummary({
      title: 'Duplikate automatisch bereinigt',
      details: [
        `${removedTracks.length} sichere Duplikat-Eintraege wurden aus Djoo entfernt.`,
        'Erkannt wurden vor allem Stem-Artefakte, fehlende Duplikate und identische Pfade mit schlechterer Metadatenqualitaet.',
        'Audiodateien wurden nicht geloescht und externe Libraries wurden nicht geschrieben.'
      ],
      wroteToVendorLibrary: false
    });
  }

  async function handleCommitSyncPlan() {
    if (!syncPlan) {
      return;
    }

    if (syncPlan.djooCount === 0) {
      setNativeMessage('Keine Tracks fuer den Sync ausgewaehlt. Waehle mindestens eine Playlist oder setze die Auswahl auf Alle.');
      return;
    }

    const replaceTargetLibrary = syncPlan.targetFormat === 'serato';

    if (replaceTargetLibrary) {
      setSyncConfirmState({ plan: syncPlan });
      return;
    }

    await commitSyncPlan(syncPlan, false);
  }

  async function handleConfirmSyncPlan() {
    if (!syncConfirmState) {
      return;
    }

    const plan = syncConfirmState.plan;
    setSyncConfirmState(null);
    await commitSyncPlan(plan, true);
  }

  function handleCancelSyncPlan() {
    setSyncConfirmState(null);
    setNativeMessage('Serato Replace-Sync abgebrochen. Ziel-Library wurde nicht veraendert.');
  }

  async function commitSyncPlan(plan: SyncPlan, confirmedReplaceTarget: boolean) {
    const replaceTargetLibrary = plan.targetFormat === 'serato';
    const selectedTracks = getSyncPlanSelectedTracks(plan);
    const playlistSelectionText = getSyncPlaylistSelectionText(plan);

    setSyncCommitBusy(true);
    setBlockingTask({
      title: plan.targetFormat === 'serato' ? 'Serato Library wird ersetzt' : 'Backup und Manifest werden erstellt',
      detail: plan.targetFormat === 'serato'
        ? `${plan.targetLabel} wird gesichert. Danach ersetzt Djoo die aktive Serato Datenbank und Crates durch ${formatLabels[plan.sourceFormat]}. ${playlistSelectionText}`
        : `${plan.targetLabel} wird gesichert. Vendor-Writeback fuer dieses Ziel bleibt gesperrt, bis der Exportadapter aktiv ist.`
    });

    try {
      const result = await commitNativeSync({
        sourceFormat: plan.sourceFormat,
        targetFormat: plan.targetFormat,
        targetPath: plan.targetPath,
        replaceTargetLibrary,
        confirmedReplaceTarget,
        playlistNames: plan.selectedPlaylistNames,
        tracks: selectedTracks,
        trackCount: plan.djooCount,
        addCount: plan.addCount,
        keepCount: plan.keepCount,
        removeCandidateCount: plan.removeCandidateCount
      });

      if (result.committed && plan.targetFormat === 'serato') {
        setBlockingTask({
          title: 'Neue Serato Library wird importiert',
          detail: `${plan.targetLabel} wird direkt nach dem Replace erneut gelesen, damit Djoo den Zielstand zeigt.`
        });

        const scanResult = await scanNativeLibrary(plan.targetFormat, plan.targetPath);
        const reimportedCueTrackCount = scanResult.tracks.filter((track) => track.cues.length > 0 || track.loops.length > 0).length;
        const resultWithReimport = {
          ...result,
          reimportedTrackCount: scanResult.tracks.length,
          reimportedCueTrackCount
        };

        ingestImportResult(nativeScanToImportResult(scanResult), { nextView: 'sync' });
        setSyncCommitResult(resultWithReimport);
        setNativeMessage(`Serato Library ersetzt und neu importiert: ${scanResult.tracks.length} Tracks, ${reimportedCueTrackCount} mit Cues/Loops.`);
        return;
      }

      setSyncCommitResult(result);
      setNativeMessage(result.committed ? 'Sync-Export wurde geschrieben.' : 'Sync-Backup wurde erstellt. Ziel-Library wurde nicht automatisch geschrieben.');
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setSyncCommitBusy(false);
      setBlockingTask(null);
    }
  }

  function handleShowMissingFiles() {
    setActiveView('library');
    setSourceFilter('all');
    setStatusFilter('missing-file');
    setQuery('');
  }

  function handleReviewDuplicate(candidate: ReturnType<typeof findDuplicateCandidates>[number]) {
    setActiveView('library');
    setSourceFilter(candidate.tracks[0].sourceFormat);
    setStatusFilter('all');
    setQuery(candidate.tracks[0].title);
    setSelectedTrackId(candidate.tracks[0].id);
  }

  function handleOpenImport(format?: ImportableFormat) {
    if (format) {
      setSelectedImportFormat(format);
    }

    setActiveView('import');
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Djoo Navigation">
        <button className="brand-mark" onClick={() => setActiveView('library')} title="Djoo Library">
          <span />
          <span />
          <span />
        </button>

        <nav className="nav-stack">
          {views.map((view) => {
            const Icon = view.icon;
            return (
              <button
                key={view.id}
                className={activeView === view.id ? 'nav-button active' : 'nav-button'}
                onClick={() => setActiveView(view.id)}
                title={view.label}
              >
                <Icon size={22} strokeWidth={2.2} />
              </button>
            );
          })}
        </nav>

        <button className="avatar-button" onClick={() => setActiveView('settings')} title="Profile">
          DJ
        </button>
      </aside>

      <main className="workspace">
        <img src={backgroundFloat} className="float-art" alt="" aria-hidden="true" />
        <section className="content-region">
          <header className="topbar">
            <div>
              <p className="eyebrow">Djoo Alpha</p>
              <h1>{getViewTitle(activeView)}</h1>
            </div>
            <div className="topbar-actions">
              <span className="status-pill"><ShieldCheck size={16} /> Local-first</span>
              <button className="icon-button" onClick={() => setActiveView('sync')} title="Sync vorbereiten">
                <SlidersHorizontal size={20} />
              </button>
            </div>
          </header>

          {activeView === 'library' && (
            <LibraryView
              tracks={filteredTracks}
              allTracksCount={tracks.length}
              query={query}
              setQuery={setQuery}
              sourceFilter={sourceFilter}
              setSourceFilter={setSourceFilter}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              availableFormats={availableLibraryFormats}
              selectedTrack={selectedTrack}
              selectedTrackId={selectedTrackId}
              playingTrackId={playingTrackId}
              previewUrls={previewUrls}
              playerError={playerError}
              coverArtUrl={coverArtUrl}
              missingTrackCount={missingTrackCount}
              pathFixes={pathFixes}
              pathFixBusy={pathFixBusy}
              duplicateTrackIds={duplicateTrackIds}
              repairSummary={repairSummary}
              onSelectTrack={setSelectedTrackId}
              onPlay={handlePlay}
              onImportClick={() => setActiveView('import')}
              onFindPathFixes={handleFindPathFixes}
              onApplyPathFixes={handleApplyPathFixes}
              onAutoRelocateMissingTracks={handleAutoRelocateMissingTracks}
              onRelocateTrack={handleRelocateTrack}
              onRelocateMissingTracks={handleRelocateMissingTracks}
              onRemoveTrack={handleRemoveTrack}
            />
          )}

          {activeView === 'import' && (
            <ImportView
              selectedFormat={selectedImportFormat}
              setSelectedFormat={setSelectedImportFormat}
              reports={reports}
              importBusy={importBusy}
              nativeBusy={nativeBusy}
              nativeMessage={nativeMessage}
              nativeCandidates={nativeCandidates}
              isDesktopApp={isDesktopApp}
              inputRef={fileInputRef}
              onFilesSelected={handleDirectorySelected}
              onNativeDiscover={handleNativeDiscover}
              onNativeFolderPick={handleNativeFolderPick}
              onNativeCandidateScan={handleNativeCandidateScan}
              onSetImportAutoSync={handleSetImportAutoSync}
            />
          )}

          {activeView === 'sync' && (
            <SyncView
              tracks={tracks}
              reports={reports}
              isDesktopApp={isDesktopApp}
              nativeBusy={nativeBusy}
              syncBusy={syncBusy}
              syncCommitBusy={syncCommitBusy}
              syncPlan={syncPlan}
              syncCommitResult={syncCommitResult}
              sourceFormat={syncSourceFormat}
              setSourceFormat={handleSyncSourceFormatChange}
              targetFormat={syncTargetFormat}
              setTargetFormat={handleSyncTargetFormatChange}
              availableFormats={availableLibraryFormats}
              nativeCandidates={nativeCandidates}
              onNativeDiscover={handleNativeDiscover}
              onBuildSyncPlan={handleBuildSyncPlan}
              onIncludeAllTracksChange={handleSyncIncludeAllTracksChange}
              onPlaylistSelectionChange={handleSyncPlaylistSelectionChange}
              onCommitSyncPlan={handleCommitSyncPlan}
            />
          )}

          {activeView === 'playlists' && (
            <PlaylistsView
              sourceFormat={playlistSourceFormat}
              targetFormat={playlistTargetFormat}
              sourceScan={playlistSourceScan}
              targetScan={playlistTargetScan}
              compareBusy={playlistCompareBusy}
              commitBusy={playlistCommitBusy}
              message={playlistMessage}
              commitResult={playlistCommitResult}
              onSourceFormatChange={setPlaylistSourceFormat}
              onTargetFormatChange={setPlaylistTargetFormat}
              onCompare={handleBuildPlaylistCompare}
              onApplyPlaylistUpdate={handleApplyPlaylistUpdate}
            />
          )}

          {activeView === 'fixes' && (
            <FixesView
              tracks={tracks}
              sameLibraryDuplicates={sameLibraryDuplicates}
              duplicateCleanupSuggestions={duplicateCleanupSuggestions}
              metadataGaps={metadataGaps}
              missingTrackCount={missingTrackCount}
              pathFixBusy={pathFixBusy}
              onShowMissingFiles={handleShowMissingFiles}
              onAutoRelocateMissingTracks={handleAutoRelocateMissingTracks}
              onRelocateMissingTracks={handleRelocateMissingTracks}
              onReviewDuplicate={handleReviewDuplicate}
              onApplyDuplicateCleanup={handleApplyDuplicateCleanup}
              onRemoveTrack={handleRemoveTrack}
              onOpenImport={handleOpenImport}
            />
          )}

          {activeView === 'settings' && (
            <SettingsView
              trackCount={tracks.length}
              reportCount={reports.length}
              tracksWithPreview={tracksWithPreview}
              missingTrackCount={missingTrackCount}
              pathFixBusy={pathFixBusy}
              repairSummary={repairSummary}
              reports={reports}
              onReset={resetDemoLibrary}
              onAutoRelocateMissingTracks={handleAutoRelocateMissingTracks}
              onRelocateMissingTracks={handleRelocateMissingTracks}
              onSetImportAutoSync={handleSetImportAutoSync}
            />
          )}
        </section>
      </main>
      {isDesktopApp && !nativeStateReady && <StartupOverlay />}
      {syncConfirmState && <SyncConfirmModal state={syncConfirmState} busy={syncCommitBusy} onCancel={handleCancelSyncPlan} onConfirm={() => void handleConfirmSyncPlan()} />}
      {blockingTask && <BlockingModal task={blockingTask} />}
    </div>
  );
}

function LibraryView(props: {
  tracks: Track[];
  allTracksCount: number;
  query: string;
  setQuery: (value: string) => void;
  sourceFilter: LibraryFormat | 'all';
  setSourceFilter: (value: LibraryFormat | 'all') => void;
  statusFilter: StatusFilter;
  setStatusFilter: (value: StatusFilter) => void;
  availableFormats: LibraryFormat[];
  selectedTrack?: Track;
  selectedTrackId: string;
  playingTrackId: string | null;
  previewUrls: Record<string, string>;
  playerError: string;
  coverArtUrl: string;
  missingTrackCount: number;
  pathFixes: NativePathFixSuggestion[];
  pathFixBusy: boolean;
  duplicateTrackIds: Set<string>;
  repairSummary: RepairSummary | null;
  onSelectTrack: (id: string) => void;
  onPlay: (track: Track) => void;
  onImportClick: () => void;
  onFindPathFixes: () => void;
  onApplyPathFixes: (trackIds?: string[]) => void;
  onAutoRelocateMissingTracks: () => void;
  onRelocateTrack: (track: Track) => void;
  onRelocateMissingTracks: () => void;
  onRemoveTrack: (track: Track) => void;
}) {
  const {
    tracks,
    allTracksCount,
    query,
    setQuery,
    sourceFilter,
    setSourceFilter,
    statusFilter,
    setStatusFilter,
    availableFormats,
    selectedTrack,
    selectedTrackId,
    playingTrackId,
    previewUrls,
    playerError,
    coverArtUrl,
    missingTrackCount,
    pathFixes,
    pathFixBusy,
    duplicateTrackIds,
    repairSummary,
    onSelectTrack,
    onPlay,
    onImportClick,
    onFindPathFixes,
    onApplyPathFixes,
    onAutoRelocateMissingTracks,
    onRelocateTrack,
    onRelocateMissingTracks,
    onRemoveTrack
  } = props;
  const selectedTrackFix = pathFixes.find((fix) => fix.trackId === selectedTrack?.id);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; track: Track } | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener('click', closeContextMenu);
    window.addEventListener('keydown', closeContextMenu);

    return () => {
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('keydown', closeContextMenu);
    };
  }, [contextMenu]);

  return (
    <div className="view-grid library-layout">
      <section className="library-panel">
        <div className="library-toolbar">
          <label className="search-box">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tracks, Artist, Genre, Key" />
          </label>
          <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as LibraryFormat | 'all')}>
            <option value="all">Alle Quellen</option>
            {availableFormats.map((format) => <option value={format} key={format}>{formatLabels[format]}</option>)}
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} title="Status filtern">
            <option value="all">Alle Status</option>
            <option value="missing-file">{statusLabels['missing-file']} ({missingTrackCount})</option>
            <option value="ready">{statusLabels.ready}</option>
            <option value="needs-review">{statusLabels['needs-review']}</option>
          </select>
          <button className="primary-button" onClick={onImportClick}>
            <UploadCloud size={18} /> Import
          </button>
        </div>

        <div className="table-shell">
          <table className="track-table">
            <colgroup>
              <col className="col-title" />
              <col className="col-artist" />
              <col className="col-bpm" />
              <col className="col-genre" />
              <col className="col-key" />
              <col className="col-cues" />
              <col className="col-source" />
              <col className="col-url" />
              <col className="col-preview" />
            </colgroup>
            <thead>
              <tr>
                <th>Trackname</th>
                <th>Artist</th>
                <th>BPM</th>
                <th>Genre</th>
                <th>Tonart</th>
                <th>Cues</th>
                <th>Quelle</th>
                <th>Track URL</th>
                <th>Preview</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track) => {
                const camelotKey = normalizeCamelotKey(track.musicalKey);
                return (
                  <tr
                    key={track.id}
                    className={getTrackRowClass(track, selectedTrackId === track.id, duplicateTrackIds.has(track.id))}
                    onClick={() => onSelectTrack(track.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onSelectTrack(track.id);
                      const hasRelocateSuggestion = pathFixes.some((fix) => fix.trackId === track.id);
                      const menuHeight = getTrackContextMenuHeight(track, hasRelocateSuggestion, duplicateTrackIds.has(track.id));
                      setContextMenu({ ...getSafeContextMenuPosition(event.clientX, event.clientY, 260, menuHeight), track });
                    }}
                  >
                    <td className="title-cell" title={track.title}>
                      <span className="title-cell-content">
                        {track.status === 'missing-file' && <AlertTriangle size={14} className="inline-status-icon" />}
                        <span>{track.title}</span>
                        {duplicateTrackIds.has(track.id) && <span className="mini-status duplicate">Dup</span>}
                      </span>
                    </td>
                    <td className="artist-cell" title={track.artist}>{track.artist}</td>
                    <td>{track.bpm ?? '-'}</td>
                    <td title={track.genre ?? ''}>{track.genre ?? '-'}</td>
                    <td><span className={camelotKey.className} title={camelotKey.original}>{camelotKey.display}</span></td>
                    <td>{track.cues.length}/{track.loops.length}</td>
                    <td>{formatLabels[track.sourceFormat]}</td>
                    <td className="path-cell">
                      <span className={track.status === 'missing-file' ? 'track-url missing-text' : 'track-url'} title={track.sourcePath ?? ''}>{formatTrackPath(track.sourcePath)}</span>
                    </td>
                    <td>
                      <button
                        className={playingTrackId === track.id ? 'play-button active' : 'play-button'}
                        onClick={(event) => {
                          event.stopPropagation();
                          onPlay(track);
                        }}
                        title={previewUrls[track.id] ? 'Preview starten' : 'Audiodatei noch nicht geladen'}
                      >
                        {playingTrackId === track.id ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {contextMenu && (
            <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
              <button onClick={() => {
                onRelocateTrack(contextMenu.track);
                setContextMenu(null);
              }}>
                <FolderInput size={15} /> Relocate Datei
              </button>
              {contextMenu.track.status === 'missing-file' && pathFixes.some((fix) => fix.trackId === contextMenu.track.id) && (
                <button onClick={() => {
                  onApplyPathFixes([contextMenu.track.id]);
                  setContextMenu(null);
                }}>
                  <Wrench size={15} /> Relocate-Vorschlag nutzen
                </button>
              )}
              {duplicateTrackIds.has(contextMenu.track.id) && (
                <button className="danger-menu-item" onClick={() => {
                  onRemoveTrack(contextMenu.track);
                  setContextMenu(null);
                }}>
                  <Trash2 size={15} /> Duplikat aus Djoo entfernen
                </button>
              )}
              <button onClick={() => {
                setStatusFilter('missing-file');
                setContextMenu(null);
              }}>
                <AlertTriangle size={15} /> Missing filtern
              </button>
            </div>
          )}
        </div>

        <footer className="library-footer">
          <span>{allTracksCount} Tracks insgesamt</span>
          <span>{tracks.length} sichtbar</span>
        </footer>
      </section>

      <aside className="detail-panel">
        <div className="detail-heading">
          <AudioLines size={22} />
          <div>
            <p>Preview Deck</p>
            <h2>{selectedTrack?.title ?? 'Kein Track'}</h2>
          </div>
        </div>

        {selectedTrack && (
          <div className="track-detail-list">
            <span><b>Artist</b>{selectedTrack.artist}</span>
            <span><b>BPM</b>{selectedTrack.bpm ?? '-'}</span>
            <span><b>Key</b>{normalizeCamelotKey(selectedTrack.musicalKey).display}</span>
            <span><b>Dauer</b>{formatDuration(selectedTrack.durationSeconds)}</span>
            <span><b>Crate</b>{Array.isArray(selectedTrack.crates) && selectedTrack.crates.length > 0 ? selectedTrack.crates.join(', ') : selectedTrack.crate ?? '-'}</span>
            <span><b>Track URL</b><em title={selectedTrack.sourcePath ?? ''}>{formatTrackPath(selectedTrack.sourcePath)}</em></span>
            <span><b>Status</b>{selectedTrack.status}</span>
          </div>
        )}

        <div className="deck-surface">
          <CoverArtPreview coverArtUrl={coverArtUrl} />
          <p>{selectedTrack && previewUrls[selectedTrack.id] ? 'Audio bereit zum Testhoeren.' : 'Importiere einen Musikordner, um lokale Dateien abzuspielen.'}</p>
          {selectedTrack && (
            <button className="primary-button wide" onClick={() => onPlay(selectedTrack)}>
              {playingTrackId === selectedTrack.id ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              {playingTrackId === selectedTrack.id ? 'Pause' : 'Play'}
            </button>
          )}
          {playerError && <span className="error-text">{playerError}</span>}
        </div>

        {missingTrackCount > 0 && (
          <div className="repair-panel">
            <div>
              <b>{missingTrackCount} fehlende Dateien</b>
              <p>{selectedTrackFix ? selectedTrackFix.reason : 'Djoo kann typische Userpfad-Migrationen erkennen.'}</p>
            </div>
            {selectedTrackFix && <code>{selectedTrackFix.suggestedPath}</code>}
            <button className="ghost-button wide" onClick={() => setStatusFilter('missing-file')}>
              <AlertTriangle size={16} /> Fehlende anzeigen
            </button>
            <button className="primary-button wide" onClick={onAutoRelocateMissingTracks} disabled={pathFixBusy}>
              {pathFixBusy ? <Loader2 size={16} className="spin" /> : <Wrench size={16} />}
              Auto-Relocate alle
            </button>
            <button className="primary-button wide" onClick={onRelocateMissingTracks} disabled={pathFixBusy}>
              {pathFixBusy ? <Loader2 size={16} className="spin" /> : <FolderInput size={16} />}
              Relocate per Ordner
            </button>
          </div>
        )}
        {repairSummary && <RepairSummaryCard summary={repairSummary} />}
      </aside>
    </div>
  );
}

function BlockingModal({ task }: { task: BlockingTask }) {
  return (
    <div className="blocking-overlay" role="status" aria-live="assertive">
      <div className="blocking-modal">
        <Loader2 size={30} className="spin" />
        <div>
          <h2>{task.title}</h2>
          <p>{task.detail}</p>
        </div>
      </div>
    </div>
  );
}

function StartupOverlay() {
  return (
    <div className="blocking-overlay startup-overlay" role="status" aria-live="assertive">
      <div className="blocking-modal startup-modal">
        <Loader2 size={32} className="spin" />
        <div>
          <h2>Djoo Library wird geladen</h2>
          <p>Persistente lokale Library, Preview-Pfade und Desktop Bridge werden vorbereitet.</p>
        </div>
      </div>
    </div>
  );
}

function RepairSummaryCard({ summary }: { summary: RepairSummary }) {
  return (
    <div className="repair-summary">
      <div className="repair-summary-title">
        {summary.wroteToVendorLibrary ? <CheckCircle2 size={18} /> : <ShieldCheck size={18} />}
        <b>{summary.title}</b>
      </div>
      <ul>
        {summary.details.map((detail) => <li key={detail}>{detail}</li>)}
      </ul>
    </div>
  );
}

function CoverArtPreview({ coverArtUrl }: { coverArtUrl: string }) {
  const [failedCoverArtUrl, setFailedCoverArtUrl] = useState('');
  const canShowCover = coverArtUrl && coverArtUrl !== failedCoverArtUrl;

  if (!canShowCover) {
    return <FileAudio size={42} />;
  }

  return (
    <img
      src={coverArtUrl}
      className="cover-art"
      alt="Cover"
      onError={() => setFailedCoverArtUrl(coverArtUrl)}
    />
  );
}

function ImportView(props: {
  selectedFormat: ImportableFormat;
  setSelectedFormat: (format: ImportableFormat) => void;
  reports: ImportReport[];
  importBusy: boolean;
  nativeBusy: boolean;
  nativeMessage: string;
  nativeCandidates: NativeLibraryCandidate[];
  isDesktopApp: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFilesSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  onNativeDiscover: () => void;
  onNativeFolderPick: () => void;
  onNativeCandidateScan: (candidate: NativeLibraryCandidate) => void;
  onSetImportAutoSync: (format: ImportableFormat, enabled: boolean) => void;
}) {
  const {
    selectedFormat,
    setSelectedFormat,
    reports,
    importBusy,
    nativeBusy,
    nativeMessage,
    nativeCandidates,
    isDesktopApp,
    inputRef,
    onFilesSelected,
    onNativeDiscover,
    onNativeFolderPick,
    onNativeCandidateScan,
    onSetImportAutoSync
  } = props;
  const visibleNativeCandidates = nativeCandidates.filter((candidate) => candidate.exists);
  const hasNativeCandidates = visibleNativeCandidates.length > 0;

  return (
    <div className="view-grid two-column">
      <section className="tool-panel">
        <div className="panel-title">
          <Database size={22} />
          <div>
            <p>Library Import</p>
            <h2>Quelle waehlen</h2>
          </div>
        </div>

        <div className="format-segments">
          {importFormats.map((format) => (
            <button
              key={format}
              className={selectedFormat === format ? 'segment active' : 'segment'}
              onClick={() => setSelectedFormat(format)}
            >
              {formatLabels[format]}
            </button>
          ))}
        </div>

        <div className="drop-zone">
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            multiple
            webkitdirectory="true"
            directory="true"
            onChange={onFilesSelected}
          />
          <FolderInput size={42} />
          <h3>{formatLabels[selectedFormat]} Ordner importieren</h3>
          <p>Im Browser-Modus waehlt Djoo einen Ordner manuell aus. Der spaetere Desktop-Adapter kann die typischen Pfade automatisch lesen.</p>
          <button className="primary-button wide" onClick={() => inputRef.current?.click()} disabled={importBusy}>
            {importBusy ? <Loader2 size={18} className="spin" /> : <UploadCloud size={18} />}
            {importBusy ? 'Import laeuft' : 'Ordner auswaehlen'}
          </button>
        </div>

        <div className="desktop-actions">
          <div>
            <b>{isDesktopApp ? 'Desktop Bridge aktiv' : 'Desktop Bridge nicht aktiv'}</b>
            <p>{isDesktopApp ? 'Djoo kann typische lokale Library-Pfade read-only scannen.' : 'Starte die App mit npm run desktop, um Auto-Erkennung und echte lokale Pfade zu nutzen.'}</p>
          </div>
          <div className="desktop-button-row">
            <button className="ghost-button" onClick={onNativeDiscover} disabled={!isDesktopApp || nativeBusy}>
              {nativeBusy ? <Loader2 size={16} className="spin" /> : <Gauge size={16} />}
              Auto-Erkennung
            </button>
            <button className="ghost-button" onClick={onNativeFolderPick} disabled={!isDesktopApp || nativeBusy}>
              <FolderInput size={16} /> Desktop Ordner
            </button>
          </div>
          {nativeMessage && <span className="native-message">{nativeMessage}</span>}
        </div>
      </section>

      <section className="tool-panel">
        <div className="panel-title">
          <Gauge size={22} />
          <div>
            <p>Erkennung</p>
            <h2>Typische Orte</h2>
          </div>
        </div>

        {hasNativeCandidates ? (
          <div className="location-list">
            {visibleNativeCandidates.map((candidate) => (
              <div className={candidate.exists ? 'location-row found' : 'location-row missing'} key={`${candidate.format}-${candidate.path}`}>
                <span className={`source-dot ${candidate.format}`} />
                <div>
                  <b>{candidate.label}</b>
                  <code>{candidate.path}</code>
                  <p>{candidate.exists ? `${candidate.markerFiles} Marker, ${candidate.audioFiles} Tracks` : candidate.warning}</p>
                  {candidate.markers.length > 0 && (
                    <div className="mini-tags">
                      {candidate.markers.map((marker) => <span key={marker}>{marker}</span>)}
                    </div>
                  )}
                </div>
                <button className="ghost-button compact" onClick={() => onNativeCandidateScan(candidate)} disabled={!candidate.exists || nativeBusy}>
                  Import
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="location-list">
            {suggestedLibraryLocations.map((location) => (
              <div className="location-row" key={`${location.format}-${location.label}`}>
                <span className={`source-dot ${location.format}`} />
                <div>
                  <b>{location.label}</b>
                  <code>{location.windowsPath}</code>
                  <p>{location.hint}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="tool-panel span-two">
        <div className="panel-title compact">
          <ListMusic size={20} />
          <h2>Import Historie</h2>
        </div>
        {reports.length === 0 ? (
          <p className="empty-state">Noch kein Import in dieser Djoo-Instanz.</p>
        ) : (
          <div className="report-list">
            {reports.map((report) => (
              <article className="report-row" key={report.id}>
                <div className="report-body">
                  <b>{formatLabels[report.format]} - {report.sourceName}</b>
                  <p>{new Date(report.importedAt).toLocaleString()} - {report.trackCount} Tracks</p>
                  {report.sourceRootPath && <small>{report.sourceRootPath}</small>}
                </div>
                <div className="report-actions">
                  {report.format !== 'djoo' && report.sourceRootPath && (
                    <button className={report.autoSyncOnStart === false ? 'ghost-button compact' : 'primary-button compact'} onClick={() => onSetImportAutoSync(report.format as ImportableFormat, report.autoSyncOnStart === false)} title="Beim Start auf Library-Aenderungen pruefen und nur bei Bedarf neu importieren">
                      {report.autoSyncOnStart === false ? 'Start-Sync aus' : 'Start-Sync an'}
                    </button>
                  )}
                  <div className="report-meta">
                    {report.markers.map((marker) => <span key={marker}>{marker}</span>)}
                    {report.warnings.map((warning) => <span className="warning" key={warning}>{warning}</span>)}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SyncView(props: {
  tracks: Track[];
  reports: ImportReport[];
  isDesktopApp: boolean;
  nativeBusy: boolean;
  syncBusy: boolean;
  syncCommitBusy: boolean;
  syncPlan: SyncPlan | null;
  syncCommitResult: NativeSyncCommitResult | null;
  sourceFormat: LibraryFormat;
  setSourceFormat: (format: LibraryFormat) => void;
  targetFormat: ImportableFormat;
  setTargetFormat: (format: ImportableFormat) => void;
  availableFormats: LibraryFormat[];
  nativeCandidates: NativeLibraryCandidate[];
  onNativeDiscover: () => void;
  onBuildSyncPlan: (candidate: NativeLibraryCandidate) => void;
  onIncludeAllTracksChange: (includeAllTracks: boolean) => void;
  onPlaylistSelectionChange: (playlistNames: string[]) => void;
  onCommitSyncPlan: () => void;
}) {
  const {
    tracks,
    reports,
    isDesktopApp,
    nativeBusy,
    syncBusy,
    syncCommitBusy,
    syncPlan,
    syncCommitResult,
    sourceFormat,
    setSourceFormat,
    targetFormat,
    setTargetFormat,
    availableFormats,
    nativeCandidates,
    onNativeDiscover,
    onBuildSyncPlan,
    onIncludeAllTracksChange,
    onPlaylistSelectionChange,
    onCommitSyncPlan
  } = props;
  const importedFormats = availableFormats.filter((format): format is ImportableFormat => format !== 'djoo');
  const sourceCounts = importedFormats.map((format) => ({
    format,
    count: tracks.filter((track) => track.sourceFormat === format).length
  }));
  const targetCandidates = nativeCandidates.filter((candidate) => candidate.format === targetFormat && candidate.exists);
  const syncPlaylistSummaries = syncPlan ? createPlaylistSummaries(syncPlan.sourceTracks) : [];
  const selectedPlaylistKeys = new Set((syncPlan?.selectedPlaylistNames ?? []).map(normalizePlaylistCompareName));
  const selectedPlaylistCount = syncPlaylistSummaries.filter((summary) => selectedPlaylistKeys.has(normalizePlaylistCompareName(summary.name))).length;
  const allPlaylistNames = syncPlaylistSummaries.map((summary) => summary.name);

  function toggleSyncPlaylist(playlistName: string, checked: boolean) {
    const playlistKey = normalizePlaylistCompareName(playlistName);
    const nextNames = syncPlaylistSummaries
      .filter((summary) => {
        const summaryKey = normalizePlaylistCompareName(summary.name);
        return checked ? selectedPlaylistKeys.has(summaryKey) || summaryKey === playlistKey : selectedPlaylistKeys.has(summaryKey) && summaryKey !== playlistKey;
      })
      .map((summary) => summary.name);

    onPlaylistSelectionChange(nextNames);
  }

  return (
    <div className="view-grid two-column">
      <section className="tool-panel span-two">
        <div className="panel-title">
          <HardDriveDownload size={22} />
          <div>
            <p>Sync Engine</p>
            <h2>Writeback vorbereiten</h2>
          </div>
        </div>
        <div className="sync-steps">
          <span><CheckCircle2 size={18} /> Djoo Library: {tracks.length} Tracks</span>
          <span><CheckCircle2 size={18} /> Letzter Import: {reports[0] ? formatLabels[reports[0].format] : 'Noch keiner'}</span>
          <span><CheckCircle2 size={18} /> Serato Replace-Sync: aktiv</span>
          <span><XCircle size={18} /> Direkter Cue/Loop Tag-Writeback bleibt bis Markerwriter-Validierung gesperrt</span>
        </div>
        <div className="sync-target-row three">
          <select value={sourceFormat} onChange={(event) => setSourceFormat(event.target.value as LibraryFormat)}>
            {availableFormats.map((format) => <option value={format} key={format}>{formatLabels[format]}</option>)}
          </select>
          <select value={targetFormat} onChange={(event) => setTargetFormat(event.target.value as ImportableFormat)}>
            {importedFormats.map((format) => <option value={format} key={format}>{formatLabels[format]}</option>)}
          </select>
          <button className="ghost-button" onClick={onNativeDiscover} disabled={!isDesktopApp || nativeBusy}>
            {nativeBusy ? <Loader2 size={16} className="spin" /> : <Gauge size={16} />}
            Ziele finden
          </button>
        </div>
        <p className="sync-note">Sync liest Quelle und Ziel, erstellt ein Diff und erzeugt ein Backup. Fuer Serato ersetzt Djoo nach Nachfrage die aktive Ziel-Library komplett durch die Quelle und importiert sie danach wieder; direkte Marker2-Tag-Aenderungen bleiben noch gesperrt.</p>
      </section>

      <section className="tool-panel span-two">
        <div className="panel-title compact">
          <HardDriveDownload size={20} />
          <h2>Sync Preview</h2>
        </div>
        {targetCandidates.length === 0 ? (
          <p className="empty-state">Keine {formatLabels[targetFormat]} Ziel-Library erkannt. Starte die Auto-Erkennung im Sync- oder Import-Screen.</p>
        ) : (
          <div className="sync-target-list">
            {targetCandidates.map((candidate) => (
              <article className="sync-target-card" key={`${candidate.format}-${candidate.path}`}>
                <div>
                  <b>{candidate.label}</b>
                  <code>{candidate.path}</code>
                  <p>{candidate.markerFiles} Marker, {candidate.audioFiles} Tracks beim Schnellscan</p>
                </div>
                <button className="primary-button" onClick={() => onBuildSyncPlan(candidate)} disabled={syncBusy}>
                  {syncBusy ? <Loader2 size={16} className="spin" /> : <SlidersHorizontal size={16} />}
                  Diff erstellen
                </button>
              </article>
            ))}
          </div>
        )}

        {syncPlan && (
          <>
            <div className="sync-plan-grid">
              <span><b>{syncPlan.djooCount}</b>{formatLabels[syncPlan.sourceFormat]} Quelle</span>
              <span><b>{syncPlan.targetCount}</b>{syncPlan.targetFormat === 'serato' ? 'Aktuell im Ziel' : 'Ziel Tracks'}</span>
              <span><b>{syncPlan.targetFormat === 'serato' ? syncPlan.djooCount : syncPlan.addCount}</b>{syncPlan.targetFormat === 'serato' ? 'Nach Replace' : 'Neu zu schreiben'}</span>
              <span><b>{syncPlan.keepCount}</b>{syncPlan.targetFormat === 'serato' ? 'Schon identisch' : 'Schon vorhanden'}</span>
              <span><b>{syncPlan.removeCandidateCount}</b>{syncPlan.targetFormat === 'serato' ? 'Fallen aus Ziel raus' : 'Nur im Ziel'}</span>
            </div>
            {syncPlan.targetFormat === 'serato' && (
              <p className="sync-note">`Aktuell im Ziel` ist der heutige Serato-Bestand vor dem Replace. `Nach Replace` ist der erwartete Zielstand direkt nach dem Commit.</p>
            )}
            {syncPlaylistSummaries.length > 0 && (
              <div className="sync-playlist-panel">
                <div className="sync-playlist-header">
                  <div>
                    <b>Playlist-Auswahl</b>
                    <p>{syncPlan.includeAllTracks ? 'Alle Tracks aktiv' : 'Nur Playlist-Tracks aktiv'} - {selectedPlaylistCount} von {syncPlaylistSummaries.length} Playlists, {syncPlan.djooCount} Tracks im Sync-Set</p>
                  </div>
                  <div className="sync-playlist-actions">
                    <button className="ghost-button compact" onClick={() => onPlaylistSelectionChange(allPlaylistNames)}>
                      <CheckCircle2 size={14} /> Alle
                    </button>
                    <button className="ghost-button compact" onClick={() => onPlaylistSelectionChange([])}>
                      <XCircle size={14} /> Keine
                    </button>
                  </div>
                </div>
                <label className="sync-toggle-row">
                  <input
                    type="checkbox"
                    checked={syncPlan.includeAllTracks}
                    onChange={(event) => onIncludeAllTracksChange(event.target.checked)}
                  />
                  <span>
                    <b>Alle Tracks aus der Quelle uebernehmen</b>
                    <small>Wenn aktiv, schreibt Djoo alle Tracks in die Ziel-Library und legt die ausgewaehlten Playlists zusaetzlich als Crates an.</small>
                  </span>
                </label>
                <div className="sync-playlist-list">
                  {syncPlaylistSummaries.map((summary) => {
                    const checked = selectedPlaylistKeys.has(normalizePlaylistCompareName(summary.name));
                    return (
                      <label className="sync-playlist-option" key={summary.name}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => toggleSyncPlaylist(summary.name, event.target.checked)}
                        />
                        <span>
                          <b>{summary.name}</b>
                          <small>{summary.trackCount} Tracks</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="sync-commit-row">
              <div>
                <b>Backup vor Commit</b>
                <p>{syncPlan.targetFormat === 'serato' ? 'Djoo sichert das Ziel, fragt vor dem Replace nach, ersetzt danach Serato database V2 und Crates komplett durch das aktuelle Sync-Set und importiert das Ergebnis direkt wieder.' : 'Djoo legt im Zielsystem eine Backup Library und ein Sync-Manifest an. Dieses Ziel wird noch nicht automatisch veraendert.'}</p>
              </div>
              <button className="primary-button" onClick={onCommitSyncPlan} disabled={syncCommitBusy || syncPlan.djooCount === 0}>
                {syncCommitBusy ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}
                {syncPlan.targetFormat === 'serato' ? 'Backup + Serato ersetzen' : 'Backup + Manifest erstellen'}
              </button>
            </div>
            {syncCommitResult && (
              <div className="sync-result">
                <CheckCircle2 size={18} />
                <span>
                  <b>Backup erstellt: <code>{syncCommitResult.backupPath}</code></b>
                  <small>Manifest: <code>{syncCommitResult.manifestPath}</code></small>
                  <small>{syncCommitResult.committed ? `${formatLabels[syncPlan.targetFormat]} Library wurde ersetzt.` : `${formatLabels[syncPlan.targetFormat]} Library wurde nicht automatisch geaendert.`}</small>
                  {syncCommitResult.exportedFiles && syncCommitResult.exportedFiles.length > 0 && <small>{syncCommitResult.exportedFiles.length} Exportdateien erstellt.</small>}
                  {typeof syncCommitResult.reimportedTrackCount === 'number' && <small>{syncCommitResult.reimportedTrackCount} Tracks danach neu importiert.</small>}
                </span>
              </div>
            )}
          </>
        )}
      </section>

      <section className="tool-panel span-two">
        <div className="panel-title compact">
          <SlidersHorizontal size={20} />
          <h2>Format Status</h2>
        </div>
        <div className="source-grid">
          {sourceCounts.map((source) => (
            <div className="source-card" key={source.format}>
              <span className={`source-dot ${source.format}`} />
              <b>{formatLabels[source.format]}</b>
              <strong>{source.count}</strong>
              <p>{source.count > 0 ? 'Importdaten vorhanden' : 'Noch kein Import'}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PlaylistsView(props: {
  sourceFormat: ImportableFormat;
  targetFormat: ImportableFormat;
  sourceScan: NativeScanResult | null;
  targetScan: NativeScanResult | null;
  compareBusy: boolean;
  commitBusy: boolean;
  message: string;
  commitResult: NativeSyncCommitResult | null;
  onSourceFormatChange: (format: ImportableFormat) => void;
  onTargetFormatChange: (format: ImportableFormat) => void;
  onCompare: () => void;
  onApplyPlaylistUpdate: (playlistNames: string[]) => void;
}) {
  const {
    sourceFormat,
    targetFormat,
    sourceScan,
    targetScan,
    compareBusy,
    commitBusy,
    message,
    commitResult,
    onSourceFormatChange,
    onTargetFormatChange,
    onCompare,
    onApplyPlaylistUpdate
  } = props;
  const [playlistFilter, setPlaylistFilter] = useState<PlaylistStatusFilter>('all');
  const [playlistQuery, setPlaylistQuery] = useState('');
  const rows = useMemo(() => createPlaylistCompareRows(sourceScan?.tracks ?? [], targetScan?.tracks ?? []), [sourceScan, targetScan]);
  const updateRows = rows.filter((row) => row.status !== 'same');
  const normalizedPlaylistQuery = playlistQuery.toLowerCase().trim();
  const visibleRows = rows.filter((row) => {
    const matchesStatus = playlistFilter === 'all'
      || (playlistFilter === 'updates' ? row.status !== 'same' : row.status === playlistFilter);
    const haystack = [row.name, row.targetName, row.status === 'same' ? 'gleich' : row.status === 'missing' ? 'fehlt' : 'abweichend']
      .join(' ')
      .toLowerCase();

    return matchesStatus && (!normalizedPlaylistQuery || haystack.includes(normalizedPlaylistQuery));
  });
  const sourcePlaylistCount = sourceScan ? createPlaylistSummaries(sourceScan.tracks).length : 0;
  const targetPlaylistCount = targetScan ? createPlaylistSummaries(targetScan.tracks).length : 0;

  return (
    <div className="view-grid playlists-layout">
      <section className="tool-panel span-two">
        <div className="panel-title">
          <ArrowRightLeft size={22} />
          <div>
            <p>Playlist Sync</p>
            <h2>Librarys vergleichen</h2>
          </div>
        </div>
        <div className="playlist-compare-controls">
          <label>
            <span>Quelle</span>
            <select value={sourceFormat} onChange={(event) => onSourceFormatChange(event.target.value as ImportableFormat)}>
              {importFormats.map((format) => <option value={format} key={format}>{formatLabels[format]}</option>)}
            </select>
          </label>
          <ArrowRight className="playlist-flow-icon" size={22} />
          <label>
            <span>Ziel</span>
            <select value={targetFormat} onChange={(event) => onTargetFormatChange(event.target.value as ImportableFormat)}>
              {importFormats.map((format) => <option value={format} key={format}>{formatLabels[format]}</option>)}
            </select>
          </label>
          <button className="primary-button" onClick={onCompare} disabled={compareBusy || sourceFormat === targetFormat}>
            {compareBusy ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            Vergleich laden
          </button>
        </div>
        <div className="playlist-metrics">
          <span><b>{sourcePlaylistCount}</b>{formatLabels[sourceFormat]} Playlists</span>
          <span><b>{targetPlaylistCount}</b>{formatLabels[targetFormat]} Playlists</span>
          <span><b>{updateRows.length}</b>fehlend/abweichend</span>
        </div>
        <p className="sync-note">Fuer aktive Serato-Updates sollte Serato geschlossen sein. Djoo erstellt vor jedem Schreibvorgang ein Backup.</p>
        {message && <p className="native-message">{message}</p>}
      </section>

      <section className="tool-panel span-two full-height">
        <div className="panel-title compact playlist-table-title">
          <ListMusic size={20} />
          <h2>Playlists</h2>
          <button className="primary-button compact" onClick={() => onApplyPlaylistUpdate(updateRows.map((row) => row.name))} disabled={commitBusy || updateRows.length === 0 || targetFormat !== 'serato'} title="Schreibt alle fehlenden oder abweichenden Playlists aus der Quelle aktiv ins Serato-Ziel. Djoo erstellt vorher ein Backup.">
            {commitBusy ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}
            Alle Updates
          </button>
        </div>

        {rows.length > 0 && (
          <div className="playlist-table-toolbar">
            <div className="search-box playlist-search">
              <Search size={16} />
              <input value={playlistQuery} onChange={(event) => setPlaylistQuery(event.target.value)} placeholder="Playlist suchen" />
            </div>
            <select value={playlistFilter} onChange={(event) => setPlaylistFilter(event.target.value as PlaylistStatusFilter)} title="Playlist-Status filtern">
              <option value="all">Alle Status</option>
              <option value="updates">Alle Updates</option>
              <option value="missing">Fehlt</option>
              <option value="different">Abweichend</option>
              <option value="same">Gleich</option>
            </select>
            <span>{visibleRows.length} angezeigt</span>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="empty-state">Lade den Vergleich, um Playlists mit Trackanzahl gegenueberzustellen.</p>
        ) : visibleRows.length === 0 ? (
          <p className="empty-state">Keine Playlists fuer diesen Filter.</p>
        ) : (
          <div className="playlist-compare-table">
            <div className="playlist-compare-head">
              <span>{formatLabels[sourceFormat]}</span>
              <span />
              <span>{formatLabels[targetFormat]}</span>
              <span>Status</span>
            </div>
            {visibleRows.map((row) => (
              <div className={`playlist-compare-row ${row.status}`} key={row.name}>
                <div>
                  <b>{row.name}</b>
                  <small>{row.sourceCount} Tracks</small>
                </div>
                <button className="ghost-button compact" onClick={() => onApplyPlaylistUpdate([row.name])} disabled={commitBusy || targetFormat !== 'serato'} title="Diese Playlist aktiv ins Serato-Ziel schreiben">
                  {commitBusy ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />}
                </button>
                <div>
                  <b>{row.targetName || '-'}</b>
                  <small>{row.targetCount > 0 ? `${row.targetCount} Tracks` : 'fehlt im Ziel'}</small>
                </div>
                <span className={`playlist-status ${row.status}`}>
                  {row.status === 'same' ? 'gleich' : row.status === 'missing' ? 'fehlt' : 'abweichend'}
                </span>
              </div>
            ))}
          </div>
        )}

        {commitResult && (
          <div className="sync-result-card">
            <ShieldCheck size={18} />
            <span>
              <b>Backup erstellt: <code>{commitResult.backupPath}</code></b>
              <small>Manifest: <code>{commitResult.manifestPath}</code></small>
              {commitResult.exportedFiles && <small>{commitResult.exportedFiles.length} Dateien aktualisiert.</small>}
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

function FixesView(props: {
  tracks: Track[];
  sameLibraryDuplicates: ReturnType<typeof findDuplicateCandidates>;
  duplicateCleanupSuggestions: DuplicateCleanupSuggestion[];
  metadataGaps: MetadataGapSummary[];
  missingTrackCount: number;
  pathFixBusy: boolean;
  onShowMissingFiles: () => void;
  onAutoRelocateMissingTracks: () => void;
  onRelocateMissingTracks: () => void;
  onReviewDuplicate: (candidate: ReturnType<typeof findDuplicateCandidates>[number]) => void;
  onApplyDuplicateCleanup: (candidateIds?: string[]) => void;
  onRemoveTrack: (track: Track) => void;
  onOpenImport: (format?: ImportableFormat) => void;
}) {
  const {
    tracks,
    sameLibraryDuplicates,
    duplicateCleanupSuggestions,
    metadataGaps,
    missingTrackCount,
    pathFixBusy,
    onShowMissingFiles,
    onAutoRelocateMissingTracks,
    onRelocateMissingTracks,
    onReviewDuplicate,
    onApplyDuplicateCleanup,
    onRemoveTrack,
    onOpenImport
  } = props;
  const [expandedPanels, setExpandedPanels] = useState({ missing: false, cleanup: false });
  const missingBpmTotal = metadataGaps.reduce((total, summary) => total + summary.missingBpm, 0);
  const missingKeyTotal = metadataGaps.reduce((total, summary) => total + summary.missingKey, 0);
  const missingCueTotal = metadataGaps.reduce((total, summary) => total + summary.missingCues, 0);
  const needsReviewTotal = metadataGaps.reduce((total, summary) => total + summary.needsReview, 0);
  const missingTracks = tracks.filter((track) => track.status === 'missing-file');
  const missingPreview = missingTracks.slice(0, 8);
  const duplicatePreview = sameLibraryDuplicates.slice(0, 8);
  const cleanupSuggestionByCandidateId = new Map(duplicateCleanupSuggestions.map((suggestion) => [suggestion.candidateId, suggestion]));
  const duplicateCleanupTrackIds = new Set(duplicateCleanupSuggestions.map((suggestion) => suggestion.removeTrackId));
  const hasFormatData = metadataGaps.length > 0;

  return (
    <div className="view-grid fixes-layout">
      <section className="tool-panel span-two">
        <div className="panel-title">
          <Wrench size={22} />
          <div>
            <p>Library Fixes</p>
            <h2>Uebersicht</h2>
          </div>
        </div>
        <div className="fix-overview-grid">
          <div className="fix-card">
            <span><AlertTriangle size={18} /> Missing Files</span>
            <b>{missingTrackCount}</b>
            <p>{missingTrackCount > 0 ? 'Auto-Relocate oder Ordner-Scan noetig.' : 'Keine offenen Missing Files.'}</p>
          </div>
          <div className="fix-card">
            <span><Shuffle size={18} /> Duplikate</span>
            <b>{sameLibraryDuplicates.length}</b>
            <p>{duplicateCleanupSuggestions.length} automatisch loesbar.</p>
          </div>
          <div className="fix-card">
            <span><Gauge size={18} /> BPM / Key</span>
            <b>{missingBpmTotal + missingKeyTotal}</b>
            <p>Tracks mit fehlenden Analysewerten.</p>
          </div>
          <div className="fix-card">
            <span><AudioLines size={18} /> Hotcues</span>
            <b>{missingCueTotal}</b>
            <p>Tracks ohne erkannte Cuepunkte.</p>
          </div>
        </div>
      </section>

      <section className="fix-collapse-panel span-two">
        <button className="fix-collapse-header" onClick={() => setExpandedPanels((current) => ({ ...current, missing: !current.missing }))}>
          <span className="fix-collapse-icon"><AlertTriangle size={20} /></span>
          <span>
            <b>Missing Files</b>
            <small>{missingTrackCount} offen. Auto-Relocate versuchen, danach Ordner scannen oder Einzelfaelle pruefen.</small>
          </span>
          {expandedPanels.missing ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
        </button>
        {expandedPanels.missing && (
          <div className="fix-collapse-body">
            <div className="fix-action-row">
              <button className="ghost-button" onClick={onShowMissingFiles} disabled={missingTrackCount === 0}>
                Anzeigen
              </button>
              <button className="primary-button" onClick={onAutoRelocateMissingTracks} disabled={pathFixBusy || missingTrackCount === 0}>
                {pathFixBusy ? <Loader2 size={16} className="spin" /> : <Wrench size={16} />}
                Auto-Relocate alle
              </button>
              <button className="ghost-button" onClick={onRelocateMissingTracks} disabled={pathFixBusy || missingTrackCount === 0}>
                <FolderInput size={16} /> Ordner scannen
              </button>
            </div>
            {missingPreview.length === 0 ? (
              <p className="empty-state">Keine offenen Missing Files.</p>
            ) : (
              <div className="fix-case-list">
                {missingPreview.map((track) => (
                  <div className="fix-case-row" key={track.id}>
                    <AlertTriangle size={16} />
                    <div>
                      <b>{track.artist} - {track.title}</b>
                      <p>{formatTrackPath(track.sourcePath)}</p>
                    </div>
                  </div>
                ))}
                {missingTracks.length > missingPreview.length && <p className="sync-note">{missingTracks.length - missingPreview.length} weitere Missing Files.</p>}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="fix-collapse-panel span-two">
        <button className="fix-collapse-header" onClick={() => setExpandedPanels((current) => ({ ...current, cleanup: !current.cleanup }))}>
          <span className="fix-collapse-icon"><Shuffle size={20} /></span>
          <span>
            <b>Cleanup</b>
            <small>{sameLibraryDuplicates.length} Duplikate, {duplicateCleanupSuggestions.length} sichere Auto-Vorschlaege. Stem-Artefakte und fehlende Duplikate kann Djoo selbst entfernen.</small>
          </span>
          {expandedPanels.cleanup ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
        </button>
        {expandedPanels.cleanup && (
          <div className="fix-collapse-body">
            <div className="fix-action-row">
              <button className="primary-button" onClick={() => onApplyDuplicateCleanup()} disabled={duplicateCleanupSuggestions.length === 0}>
                <Trash2 size={16} /> {duplicateCleanupSuggestions.length} Auto-Cleanup anwenden
              </button>
            </div>
            {sameLibraryDuplicates.length === 0 ? (
              <p className="empty-state">Keine Duplikate innerhalb einzelner Libraries erkannt.</p>
            ) : (
              <div className="duplicate-list">
                {duplicatePreview.map((candidate) => {
                  const cleanupSuggestion = cleanupSuggestionByCandidateId.get(candidate.id);
                  return (
                    <article className={cleanupSuggestion ? 'duplicate-row auto-cleanup' : 'duplicate-row'} key={candidate.id}>
                      <div className="confidence-ring">{candidate.confidence}%</div>
                      <div>
                        <b>{candidate.tracks[0].artist} - {candidate.tracks[0].title}</b>
                        <p>{cleanupSuggestion ? cleanupSuggestion.reason : candidate.reason}</p>
                        <div className="duplicate-path-list">
                          {candidate.tracks.map((track, trackIndex) => (
                            <span className={duplicateCleanupTrackIds.has(track.id) ? 'cleanup-remove-target' : ''} key={track.id}>
                              <small>{trackIndex + 1}</small>
                              {formatLabels[track.sourceFormat]} - {formatTrackPath(track.sourcePath)}
                              <button className="ghost-button compact danger" onClick={() => onRemoveTrack(track)}>
                                <Trash2 size={14} /> Entfernen
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="duplicate-action-stack">
                        {cleanupSuggestion && (
                          <button className="primary-button" onClick={() => onApplyDuplicateCleanup([candidate.id])}>
                            <Trash2 size={16} /> Auto loesen
                          </button>
                        )}
                        <button className="ghost-button" onClick={() => onReviewDuplicate(candidate)}><Search size={16} /> Pruefen</button>
                      </div>
                    </article>
                  );
                })}
                {sameLibraryDuplicates.length > duplicatePreview.length && (
                  <p className="sync-note">{sameLibraryDuplicates.length - duplicatePreview.length} weitere Kandidaten. Auto-Cleanup entfernt nur sichere Faelle; der Rest bleibt zur Pruefung.</p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="tool-panel span-two">
        <div className="panel-title compact">
          <Gauge size={20} />
          <h2>Metadaten</h2>
        </div>
        {hasFormatData ? (
          <div className="fix-list compact-list">
            {metadataGaps.map((summary) => (
              <div className="fix-row" key={summary.format}>
                <span className={`source-dot ${summary.format}`} />
                <div>
                  <b>{formatLabels[summary.format]}</b>
                  <p>{summary.total} Tracks, {summary.missingBpm} ohne BPM, {summary.missingKey} ohne Key, {summary.missingCues} ohne Cues</p>
                </div>
                {summary.format !== 'djoo' && (
                  <button className="ghost-button compact" onClick={() => onOpenImport(summary.format as ImportableFormat)}>
                    Import
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-state">Noch keine importierten Library-Daten vorhanden.</p>
        )}
      </section>

      <section className="tool-panel span-two">
        <div className="panel-title compact">
          <ListMusic size={20} />
          <h2>Library Health</h2>
        </div>
        <div className="source-grid">
          {metadataGaps.map((summary) => (
            <div className="source-card" key={summary.format}>
              <span className={`source-dot ${summary.format}`} />
              <b>{formatLabels[summary.format]}</b>
              <strong>{summary.total}</strong>
              <p>{summary.ready} ready, {summary.missingFiles} missing, {summary.needsReview} review</p>
            </div>
          ))}
          {!hasFormatData && (
            <div className="source-card">
              <span className="source-dot djoo" />
              <b>Keine Daten</b>
              <strong>{tracks.length}</strong>
              <p>Importiere zuerst eine DJ-Library.</p>
            </div>
          )}
        </div>
        {needsReviewTotal > 0 && <p className="sync-note">{needsReviewTotal} Tracks sind als Needs Review markiert.</p>}
      </section>
    </div>
  );
}

function DuplicatesView({ duplicates }: { duplicates: ReturnType<typeof findDuplicateCandidates> }) {
  return (
    <section className="tool-panel full-height">
      <div className="panel-title">
        <Shuffle size={22} />
        <div>
          <p>Cleanup</p>
          <h2>Duplikaterkennung</h2>
        </div>
      </div>

      {duplicates.length === 0 ? (
        <p className="empty-state">Keine Duplikate erkannt. Importiere weitere Tracks, um Kandidaten zu vergleichen.</p>
      ) : (
        <div className="duplicate-list">
          {duplicates.map((candidate) => (
            <article className="duplicate-row" key={candidate.id}>
              <div className="confidence-ring">{candidate.confidence}%</div>
              <div>
                <b>{candidate.tracks[0].artist} - {candidate.tracks[0].title}</b>
                <p>{candidate.reason}</p>
                <span>{formatLabels[candidate.tracks[0].sourceFormat]} / {formatLabels[candidate.tracks[1].sourceFormat]}</span>
              </div>
              <button className="ghost-button"><Trash2 size={16} /> Pruefen</button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function SettingsView(props: {
  trackCount: number;
  reportCount: number;
  tracksWithPreview: number;
  missingTrackCount: number;
  pathFixBusy: boolean;
  repairSummary: RepairSummary | null;
  reports: ImportReport[];
  onReset: () => void;
  onAutoRelocateMissingTracks: () => void;
  onRelocateMissingTracks: () => void;
  onSetImportAutoSync: (format: ImportableFormat, enabled: boolean) => void;
}) {
  const { trackCount, reportCount, tracksWithPreview, missingTrackCount, pathFixBusy, repairSummary, reports, onReset, onAutoRelocateMissingTracks, onRelocateMissingTracks, onSetImportAutoSync } = props;
  const watchedReports = getLatestNativeImportReports(reports);

  return (
    <div className="view-grid two-column">
      <section className="tool-panel">
        <div className="panel-title">
          <Settings size={22} />
          <div>
            <p>Djoo Local</p>
            <h2>Projektstatus</h2>
          </div>
        </div>
        <div className="metric-grid">
          <span><b>{trackCount}</b>Tracks</span>
          <span><b>{reportCount}</b>Importe</span>
          <span><b>{tracksWithPreview}</b>Preview Dateien</span>
          <span><b>{missingTrackCount}</b>Missing Files</span>
        </div>
      </section>

      <section className="tool-panel">
        <div className="panel-title">
          <Wrench size={22} />
          <div>
            <p>Path Repair</p>
            <h2>Routing Fix</h2>
          </div>
        </div>
        <p className="sync-note">Erkennt verschobene Userpfade, etwa `Huber` zu `Nikolas`, und aktualisiert die Pfade in Djoo.</p>
        <button className="primary-button wide" onClick={onAutoRelocateMissingTracks} disabled={pathFixBusy || missingTrackCount === 0}>
          {pathFixBusy ? <Loader2 size={16} className="spin" /> : <Wrench size={16} />}
          Auto-Relocate alle
        </button>
        <button className="ghost-button wide" onClick={onRelocateMissingTracks} disabled={pathFixBusy || missingTrackCount === 0}>
          <FolderInput size={16} /> Relocate per Ordner
        </button>
        {repairSummary && <RepairSummaryCard summary={repairSummary} />}
      </section>

      <section className="tool-panel">
        <div className="panel-title">
          <ShieldCheck size={22} />
          <div>
            <p>Import Sync</p>
            <h2>Startverhalten</h2>
          </div>
        </div>
        {watchedReports.length === 0 ? (
          <p className="empty-state">Noch keine native Library mit Watch-Pfad importiert.</p>
        ) : (
          <div className="sync-setting-list">
            {watchedReports.map((report) => (
              <div className="sync-setting-row" key={`${report.format}-${report.sourceRootPath}`}>
                <div>
                  <b>{formatLabels[report.format]}</b>
                  <p>{report.sourceRootPath}</p>
                </div>
                <button className={report.autoSyncOnStart === false ? 'ghost-button compact' : 'primary-button compact'} onClick={() => onSetImportAutoSync(report.format as ImportableFormat, report.autoSyncOnStart === false)}>
                  {report.autoSyncOnStart === false ? 'Aus' : 'An'}
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="sync-note">Djoo prueft beim Start nur die Signatur der importierten Library. Nur bei erkannter Aenderung wird neu importiert; Engine DJ nutzt dabei einen Delta-Import fuer unveraenderte Tracks.</p>
      </section>

      <section className="tool-panel">
        <div className="panel-title">
          <ShieldCheck size={22} />
          <div>
            <p>Reset</p>
            <h2>Demo Daten</h2>
          </div>
        </div>
        <p className="sync-note">Setzt die lokale Browser-Library auf die zwei Mockup-Tracks zurueck. Originaldateien werden nicht beruehrt.</p>
        <button className="ghost-button danger" onClick={onReset}><Trash2 size={16} /> Demo zuruecksetzen</button>
      </section>
    </div>
  );
}

function getViewTitle(viewId: ViewId) {
  switch (viewId) {
    case 'import':
      return 'IMPORT';
    case 'sync':
      return 'SYNC';
    case 'playlists':
      return 'PLAYLISTS';
    case 'fixes':
      return 'FIXES';
    case 'settings':
      return 'SETTINGS';
    default:
      return 'LIBRARY';
  }
}

function getKeyClass(key?: string) {
  if (!key) {
    return 'key-badge neutral';
  }

  return key.toLowerCase().endsWith('b') ? 'key-badge magenta' : 'key-badge green';
}

function formatDuration(seconds?: number) {
  if (!seconds) {
    return '--:--';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function formatTrackPath(sourcePath?: string) {
  if (!sourcePath) {
    return '-';
  }

  return sourcePath;
}

function getNativeCandidateForFormat(candidates: NativeLibraryCandidate[], format: ImportableFormat) {
  return candidates.find((candidate) => candidate.exists && candidate.format === format);
}

function createPlaylistSummaries(tracks: Track[]) {
  const summaries = new Map<string, { name: string; trackKeys: Set<string> }>();

  for (const track of tracks) {
    const trackKey = normalizeComparablePath(track.sourcePath || track.id);
    const playlistNames = getTrackPlaylistNames(track);

    for (const playlistName of playlistNames) {
      const cleanName = cleanPlaylistName(playlistName);

      if (!cleanName || /^serato library$/i.test(cleanName)) {
        continue;
      }

      const key = normalizePlaylistCompareName(cleanName);
      const summary = summaries.get(key) || { name: cleanName, trackKeys: new Set<string>() };
      summary.trackKeys.add(trackKey);
      summaries.set(key, summary);
    }
  }

  return Array.from(summaries.values())
    .map((summary) => ({ name: summary.name, trackCount: summary.trackKeys.size }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

function createPlaylistCompareRows(sourceTracks: Track[], targetTracks: Track[]): PlaylistCompareRow[] {
  const sourceSummaries = createPlaylistSummaries(sourceTracks);
  const targetSummaries = createPlaylistSummaries(targetTracks);
  const targetByName = new Map<string, { name: string; trackCount: number }>();

  for (const summary of targetSummaries) {
    targetByName.set(normalizePlaylistCompareName(summary.name), summary);
  }

  return sourceSummaries.map((sourceSummary) => {
    const targetSummary = targetByName.get(normalizePlaylistCompareName(sourceSummary.name))
      || targetByName.get(normalizePlaylistCompareName(formatSeratoPlaylistName(sourceSummary.name)));
    const targetCount = targetSummary?.trackCount ?? 0;
    const status: PlaylistCompareRow['status'] = !targetSummary
      ? 'missing'
      : targetCount === sourceSummary.trackCount
        ? 'same'
        : 'different';

    return {
      name: sourceSummary.name,
      targetName: targetSummary?.name ?? formatSeratoPlaylistName(sourceSummary.name),
      sourceCount: sourceSummary.trackCount,
      targetCount,
      status
    };
  });
}

function countTracksInPlaylists(tracks: Track[], playlistNames: string[]) {
  const selectedKeys = new Set(playlistNames.map(normalizePlaylistCompareName));
  const trackKeys = new Set<string>();

  for (const track of tracks) {
    const playlistKeys = getTrackPlaylistNames(track).map(normalizePlaylistCompareName);

    if (playlistKeys.some((playlistKey) => selectedKeys.has(playlistKey))) {
      trackKeys.add(normalizeComparablePath(track.sourcePath || track.id));
    }
  }

  return trackKeys.size;
}

function getTrackPlaylistNames(track: Track) {
  if (Array.isArray(track.crates)) {
    return track.crates;
  }

  return String(track.crate || '')
    .split(',')
    .map((crateName) => crateName.trim())
    .filter(Boolean);
}

function formatSeratoPlaylistName(value: string) {
  return cleanPlaylistName(value)
    .replace(/[\\/]+/g, ' - ')
    .replace(/[<>:"|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePlaylistCompareName(value: string) {
  return formatSeratoPlaylistName(value).toLowerCase();
}

function cleanPlaylistName(value: string) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getTrackRowClass(track: Track, selected: boolean, duplicate: boolean) {
  return [
    selected ? 'selected-row' : '',
    track.status === 'missing-file' ? 'missing-row' : '',
    duplicate ? 'duplicate-track-row' : ''
  ].filter(Boolean).join(' ');
}

function getTrackContextMenuHeight(track: Track, hasRelocateSuggestion: boolean, duplicate: boolean) {
  let itemCount = 2;

  if (track.status === 'missing-file' && hasRelocateSuggestion) {
    itemCount += 1;
  }

  if (duplicate) {
    itemCount += 1;
  }

  return 12 + itemCount * 38;
}

function getSafeContextMenuPosition(x: number, y: number, width: number, height: number) {
  const margin = 10;
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);

  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY)
  };
}

function getSyncSourceTracks(tracks: Track[], sourceFormat: LibraryFormat) {
  const sourceTracks = sourceFormat === 'djoo'
    ? tracks
    : tracks.filter((track) => track.sourceFormat === sourceFormat);

  return sourceTracks.filter((track) => track.status !== 'missing-file');
}

function getSyncSelectionKey(sourceFormat: LibraryFormat, targetFormat: ImportableFormat) {
  return `${sourceFormat}->${targetFormat}`;
}

function getInitialSyncPlaylistSelection(sourceTracks: Track[], sourceFormat: LibraryFormat, targetFormat: ImportableFormat, storedSelections: Record<string, string[]>) {
  const summaries = createPlaylistSummaries(sourceTracks);

  if (summaries.length === 0) {
    return undefined;
  }

  const storedSelection = storedSelections[getSyncSelectionKey(sourceFormat, targetFormat)];

  if (!Array.isArray(storedSelection)) {
    return summaries.map((summary) => summary.name);
  }

  if (storedSelection.length === 0) {
    return [];
  }

  const restoredSelection = sanitizeSyncPlaylistSelection(sourceTracks, storedSelection);
  return restoredSelection && restoredSelection.length > 0 ? restoredSelection : summaries.map((summary) => summary.name);
}

function getInitialSyncIncludeAllTracks(sourceFormat: LibraryFormat, targetFormat: ImportableFormat, storedSelections: Record<string, boolean>) {
  const storedValue = storedSelections[getSyncSelectionKey(sourceFormat, targetFormat)];
  return typeof storedValue === 'boolean' ? storedValue : true;
}

function sanitizeSyncPlaylistSelection(sourceTracks: Track[], playlistNames: string[]) {
  const summaries = createPlaylistSummaries(sourceTracks);

  if (summaries.length === 0) {
    return undefined;
  }

  const availableByKey = new Map(summaries.map((summary) => [normalizePlaylistCompareName(summary.name), summary.name]));
  const selectedNames: string[] = [];
  const selectedKeys = new Set<string>();

  for (const playlistName of playlistNames) {
    const playlistKey = normalizePlaylistCompareName(playlistName);
    const availableName = availableByKey.get(playlistKey);

    if (!availableName || selectedKeys.has(playlistKey)) {
      continue;
    }

    selectedKeys.add(playlistKey);
    selectedNames.push(availableName);
  }

  return selectedNames;
}

function getSyncPlanSelectedTracks(plan: SyncPlan) {
  if (plan.includeAllTracks) {
    return plan.sourceTracks;
  }

  return getSyncSelectedTracks(plan.sourceTracks, plan.selectedPlaylistNames);
}

function getSyncSelectedTracks(sourceTracks: Track[], selectedPlaylistNames?: string[]) {
  const summaries = createPlaylistSummaries(sourceTracks);

  if (summaries.length === 0 || !selectedPlaylistNames) {
    return sourceTracks;
  }

  if (selectedPlaylistNames.length === 0) {
    return [];
  }

  const availableKeys = new Set(summaries.map((summary) => normalizePlaylistCompareName(summary.name)));
  const selectedKeys = new Set(selectedPlaylistNames.map(normalizePlaylistCompareName));
  const allPlaylistsSelected = Array.from(availableKeys).every((playlistKey) => selectedKeys.has(playlistKey));

  if (allPlaylistsSelected) {
    return sourceTracks;
  }

  return sourceTracks.filter((track) => getTrackPlaylistNames(track)
    .map(normalizePlaylistCompareName)
    .some((playlistKey) => selectedKeys.has(playlistKey)));
}

function applySyncPlaylistSelection(plan: SyncPlan, playlistNames: string[]) {
  const selectedPlaylistNames = sanitizeSyncPlaylistSelection(plan.sourceTracks, playlistNames);
  const selectedTracks = plan.includeAllTracks ? plan.sourceTracks : getSyncSelectedTracks(plan.sourceTracks, selectedPlaylistNames);
  const stats = createSyncPlanStats(selectedTracks, plan.targetTrackKeys);

  return {
    ...plan,
    ...stats,
    selectedPlaylistNames
  };
}

function applySyncIncludeAllTracks(plan: SyncPlan, includeAllTracks: boolean) {
  const selectedTracks = includeAllTracks ? plan.sourceTracks : getSyncSelectedTracks(plan.sourceTracks, plan.selectedPlaylistNames);
  const stats = createSyncPlanStats(selectedTracks, plan.targetTrackKeys);

  return {
    ...plan,
    ...stats,
    includeAllTracks
  };
}

function createSyncPlanStats(sourceTracks: Track[], targetTrackKeys: string[]) {
  const localKeys = new Set(sourceTracks.map((track) => normalizeComparablePath(track.sourcePath || '')).filter(Boolean));
  const targetKeys = new Set(targetTrackKeys.filter(Boolean));
  const keepCount = Array.from(localKeys).filter((key) => targetKeys.has(key)).length;
  const addCount = Array.from(localKeys).filter((key) => !targetKeys.has(key)).length;
  const removeCandidateCount = Array.from(targetKeys).filter((key) => !localKeys.has(key)).length;

  return {
    djooCount: localKeys.size,
    targetCount: targetKeys.size,
    keepCount,
    addCount,
    removeCandidateCount
  };
}

function getSyncPlaylistSelectionText(plan: SyncPlan) {
  const summaries = createPlaylistSummaries(plan.sourceTracks);

  if (plan.includeAllTracks && (!plan.selectedPlaylistNames || plan.selectedPlaylistNames.length === 0)) {
    return 'Alle Tracks sind ausgewaehlt; es wird nur die All-Tracks-Ansicht neu aufgebaut.';
  }

  if (summaries.length === 0 || !plan.selectedPlaylistNames) {
    return 'Keine Playlist-Auswahl aktiv; alle Tracks werden verwendet.';
  }

  if (plan.selectedPlaylistNames.length === 0) {
    return plan.includeAllTracks ? 'Alle Tracks sind aktiv, aber keine zusaetzliche Playlist ist ausgewaehlt.' : 'Keine Playlist ist ausgewaehlt.';
  }

  if (plan.includeAllTracks && plan.selectedPlaylistNames.length < summaries.length) {
    return `${plan.selectedPlaylistNames.length} Playlist(s) sind fuer Crates ausgewaehlt; alle ${plan.djooCount} Tracks bleiben trotzdem im Replace enthalten.`;
  }

  if (plan.selectedPlaylistNames.length >= summaries.length) {
    return 'Alle Playlists sind ausgewaehlt; einzelne Tracks ohne Playlist bleiben enthalten.';
  }

  return `${plan.selectedPlaylistNames.length} Playlist(s) sind ausgewaehlt; der Sync wird auf ${plan.djooCount} Tracks aus dieser Auswahl begrenzt.`;
}

function createDuplicateCleanupSuggestions(candidates: ReturnType<typeof findDuplicateCandidates>) {
  const suggestions: DuplicateCleanupSuggestion[] = [];
  const removeTrackIds = new Set<string>();

  candidates.forEach((candidate) => {
    const suggestion = createDuplicateCleanupSuggestion(candidate);

    if (!suggestion || removeTrackIds.has(suggestion.removeTrackId)) {
      return;
    }

    removeTrackIds.add(suggestion.removeTrackId);
    suggestions.push(suggestion);
  });

  return suggestions;
}

function createDuplicateCleanupSuggestion(candidate: ReturnType<typeof findDuplicateCandidates>[number]): DuplicateCleanupSuggestion | null {
  const [firstTrack, secondTrack] = candidate.tracks;
  const firstIsStem = isStemArtifactTrack(firstTrack);
  const secondIsStem = isStemArtifactTrack(secondTrack);

  if (firstIsStem !== secondIsStem) {
    const removeTrack = firstIsStem ? firstTrack : secondTrack;
    const keepTrack = firstIsStem ? secondTrack : firstTrack;
    return {
      candidateId: candidate.id,
      removeTrackId: removeTrack.id,
      keepTrackId: keepTrack.id,
      reason: 'Serato Stem-Artefakt erkannt. Djoo behaelt den normalen Track und entfernt den Stem-Eintrag aus der lokalen Library.'
    };
  }

  if (firstTrack.status !== secondTrack.status) {
    const removeTrack = firstTrack.status === 'missing-file' ? firstTrack : secondTrack.status === 'missing-file' ? secondTrack : null;
    const keepTrack = removeTrack?.id === firstTrack.id ? secondTrack : firstTrack;

    if (removeTrack && keepTrack.status === 'ready') {
      return {
        candidateId: candidate.id,
        removeTrackId: removeTrack.id,
        keepTrackId: keepTrack.id,
        reason: 'Ready/Missing-Duplikat erkannt. Djoo behaelt den vorhandenen Track und entfernt den fehlenden lokalen Eintrag.'
      };
    }
  }

  const firstPath = normalizeComparablePath(firstTrack.sourcePath || '');
  const secondPath = normalizeComparablePath(secondTrack.sourcePath || '');

  if (firstPath && firstPath === secondPath) {
    const firstScore = getTrackQualityScore(firstTrack);
    const secondScore = getTrackQualityScore(secondTrack);
    const removeTrack = firstScore <= secondScore ? firstTrack : secondTrack;
    const keepTrack = removeTrack.id === firstTrack.id ? secondTrack : firstTrack;

    return {
      candidateId: candidate.id,
      removeTrackId: removeTrack.id,
      keepTrackId: keepTrack.id,
      reason: 'Identischer Dateipfad erkannt. Djoo behaelt den Eintrag mit mehr Metadaten, Cues und Ready-Status.'
    };
  }

  return null;
}

function isStemArtifactTrack(track: Track) {
  const normalizedPath = normalizeComparablePath(track.sourcePath || '');
  return normalizedPath.includes('/_stems/stems/') || /\.stem\.(m4a|mp4|wav|aif|aiff|flac)$/i.test(normalizedPath);
}

function getTrackQualityScore(track: Track) {
  return (track.status === 'ready' ? 20 : 0)
    + (typeof track.bpm === 'number' ? 3 : 0)
    + (track.musicalKey ? 3 : 0)
    + Math.min(track.cues.length, 8)
    + Math.min(track.loops.length, 4)
    - (isStemArtifactTrack(track) ? 10 : 0);
}

function formatScanMessage(scanResult: NativeScanResult) {
  const cueTracks = scanResult.tracks.filter((track) => track.cues.length > 0).length;
  const cueCount = scanResult.tracks.reduce((total, track) => total + track.cues.length, 0);
  const loopTracks = scanResult.tracks.filter((track) => track.loops.length > 0).length;
  const loopCount = scanResult.tracks.reduce((total, track) => total + track.loops.length, 0);
  const missingBpm = scanResult.tracks.filter((track) => typeof track.bpm !== 'number').length;
  const missingKey = scanResult.tracks.filter((track) => !track.musicalKey?.trim()).length;
  const missingFiles = scanResult.tracks.filter((track) => track.status === 'missing-file').length;
  const parts = [
    `${formatLabels[scanResult.format]} Import abgeschlossen: ${scanResult.tracks.length} Tracks`,
    `${scanResult.markerFiles} Marker/DB-Dateien`,
    `${cueTracks} Tracks mit ${cueCount} Cues`,
    `${loopTracks} Tracks mit ${loopCount} Loops`
  ];

  if (missingBpm > 0 || missingKey > 0) {
    parts.push(`${missingBpm} ohne BPM, ${missingKey} ohne Key`);
  }

  if (missingFiles > 0) {
    parts.push(`${missingFiles} Missing Files`);
  }

  if (scanResult.warnings.length > 0) {
    parts.push(`${scanResult.warnings.length} Hinweise`);
  }

  return `${parts.join(', ')}. Vorhandene Djoo-Daten fuer ${formatLabels[scanResult.format]} wurden ersetzt; externe Libraries wurden nicht geschrieben.`;
}

function createMetadataGapSummary(tracks: Track[]) {
  const summaries = new Map<LibraryFormat, MetadataGapSummary>();

  for (const format of ['djoo', ...importFormats] as LibraryFormat[]) {
    summaries.set(format, {
      format,
      total: 0,
      ready: 0,
      missingFiles: 0,
      needsReview: 0,
      missingBpm: 0,
      missingKey: 0,
      missingCues: 0
    });
  }

  tracks.forEach((track) => {
    const summary = summaries.get(track.sourceFormat);

    if (!summary) {
      return;
    }

    summary.total += 1;
    summary.ready += track.status === 'ready' ? 1 : 0;
    summary.missingFiles += track.status === 'missing-file' ? 1 : 0;
    summary.needsReview += track.status === 'needs-review' ? 1 : 0;
    summary.missingBpm += typeof track.bpm === 'number' ? 0 : 1;
    summary.missingKey += track.musicalKey?.trim() ? 0 : 1;
    summary.missingCues += track.cues.length > 0 ? 0 : 1;
  });

  return Array.from(summaries.values()).filter((summary) => summary.total > 0);
}

function mergeImportedTracks(currentTracks: Track[], importedTracks: Track[], importedFormat: LibraryFormat) {
  const importedKeys = new Set(importedTracks.map(getTrackIdentity));
  const remainingTracks = currentTracks.filter((track) => {
    if (track.sourceFormat === importedFormat && importedFormat !== 'djoo') {
      return false;
    }

    return !importedKeys.has(getTrackIdentity(track));
  });
  return [...importedTracks, ...remainingTracks];
}

function getTrackIdentity(track: Track) {
  return `${track.sourceFormat}:${normalizeComparablePath(track.sourcePath || track.id)}`;
}

function normalizeComparablePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^file:\/\//i, '').toLowerCase();
}

function createSyncPlan(localTracks: Track[], targetScan: { format: ImportableFormat; rootPath: string; tracks: Track[]; warnings: string[] }, targetLabel: string, sourceFormat: LibraryFormat, sourceTracksOverride?: Track[], storedSelections: Record<string, string[]> = {}, storedIncludeAllTracks: Record<string, boolean> = {}): SyncPlan {
  const sourceTracks = sourceTracksOverride ?? getSyncSourceTracks(localTracks, sourceFormat);
  const targetTrackKeys = targetScan.tracks.map((track) => normalizeComparablePath(track.sourcePath || '')).filter(Boolean);
  const selectedPlaylistNames = getInitialSyncPlaylistSelection(sourceTracks, sourceFormat, targetScan.format, storedSelections);
  const includeAllTracks = getInitialSyncIncludeAllTracks(sourceFormat, targetScan.format, storedIncludeAllTracks);
  const stats = createSyncPlanStats(includeAllTracks ? sourceTracks : getSyncSelectedTracks(sourceTracks, selectedPlaylistNames), targetTrackKeys);

  return {
    sourceFormat,
    targetLabel,
    targetFormat: targetScan.format,
    targetPath: targetScan.rootPath,
    sourceTracks,
    targetTrackKeys,
    includeAllTracks,
    selectedPlaylistNames,
    ...stats,
    warnings: targetScan.warnings
  };
}

function pathToFileUrl(filePath: string) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const prefixedPath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
  return encodeURI(`file://${prefixedPath}`);
}

function getVendorWritebackNotice(tracks: Track[]) {
  const externalFormats = Array.from(new Set(tracks
    .map((track) => track.sourceFormat)
    .filter((format): format is ImportableFormat => format !== 'djoo')));

  if (externalFormats.length === 0) {
    return 'Es wurde keine externe DJ-Library automatisch geschrieben.';
  }

  const labels = externalFormats.map((format) => formatLabels[format]).join(', ');
  return `${labels} Library wurde nicht automatisch geschrieben; Djoo hat nur die lokale Library aktualisiert.`;
}

function createBulkRelocateSummary(result: NativeBulkRelocateResult, missingTracks: Track[]): RepairSummary {
  const details = [
    `${result.relocated.length} von ${missingTracks.length} fehlenden Dateien wurden unter ${result.rootPath} gefunden.`,
    `${result.audioFiles ?? 0} Audiodateien wurden geprueft${result.scannedFiles ? ` (${result.scannedFiles} Dateien gescannt)` : ''}.`,
    'Djoo sourcePath, Status und lokale Preview-URLs wurden fuer gefundene Tracks aktualisiert.',
    getVendorWritebackNotice(missingTracks)
  ];

  if (result.truncated) {
    details.push('Der Ordner-Scan wurde aus Performance-Gruenden begrenzt. Waehle in dem Fall einen naeheren Musik-Ueberordner.');
  }

  if (result.unmatched.length > 0) {
    details.push(`${result.unmatched.length} Dateien wurden nicht eindeutig gefunden und bleiben Missing Files.`);
  }

  return {
    title: 'Bulk Relocate abgeschlossen',
    details,
    wroteToVendorLibrary: false
  };
}

function applyImportResultToLibraryState(currentState: { tracks: Track[]; reports: ImportReport[]; previewUrls: Record<string, string> }, result: ImportResult) {
  const nextReport = result.report.format === 'djoo' || !result.report.sourceRootPath
    ? result.report
    : {
        ...result.report,
        autoSyncOnStart: resolveImportAutoSyncSetting(currentState.reports, result.report.format as ImportableFormat)
      };

  return {
    tracks: mergeImportedTracks(currentState.tracks, result.tracks, result.report.format),
    reports: [nextReport, ...currentState.reports].slice(0, 8),
    previewUrls: { ...currentState.previewUrls, ...result.previewUrls }
  };
}

function getStartupImportSyncReports(reports: ImportReport[]) {
  const latestByFormat = new Map<ImportableFormat, ImportReport>();

  for (const report of reports) {
    if (report.format === 'djoo' || report.autoSyncOnStart === false || !report.sourceRootPath) {
      continue;
    }

    const currentReport = latestByFormat.get(report.format as ImportableFormat);

    if (!currentReport || new Date(report.importedAt).getTime() > new Date(currentReport.importedAt).getTime()) {
      latestByFormat.set(report.format as ImportableFormat, report);
    }
  }

  return Array.from(latestByFormat.values());
}

function getLatestNativeImportReports(reports: ImportReport[]) {
  const latestByFormat = new Map<ImportableFormat, ImportReport>();

  for (const report of reports) {
    if (report.format === 'djoo' || !report.sourceRootPath) {
      continue;
    }

    const currentReport = latestByFormat.get(report.format as ImportableFormat);

    if (!currentReport || new Date(report.importedAt).getTime() > new Date(currentReport.importedAt).getTime()) {
      latestByFormat.set(report.format as ImportableFormat, report);
    }
  }

  return Array.from(latestByFormat.values());
}

function updateImportAutoSyncReports(reports: ImportReport[], format: ImportableFormat, enabled: boolean) {
  return reports.map((report) => report.format === format
    ? { ...report, autoSyncOnStart: enabled }
    : report);
}

function resolveImportAutoSyncSetting(reports: ImportReport[], format: ImportableFormat) {
  return reports.find((report) => report.format === format && typeof report.autoSyncOnStart === 'boolean')?.autoSyncOnStart ?? true;
}

function createStartupImportSyncMessage(trackCount: number, updatedFormats: string[], warnings: string[]) {
  const baseMessage = `Persistente Library geladen: ${trackCount} Tracks.`;

  if (updatedFormats.length === 0 && warnings.length === 0) {
    return `${baseMessage} Import-Sync: keine Aenderungen erkannt.`;
  }

  if (updatedFormats.length > 0 && warnings.length === 0) {
    return `${baseMessage} Automatisch aktualisiert: ${updatedFormats.join(', ')}.`;
  }

  if (updatedFormats.length === 0) {
    return `${baseMessage} ${warnings.join(' | ')}`;
  }

  return `${baseMessage} Automatisch aktualisiert: ${updatedFormats.join(', ')}. ${warnings.join(' | ')}`;
}

function nextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unbekannter Fehler beim lokalen Library-Zugriff.';
}
