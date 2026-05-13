import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  AlertTriangle,
  CheckCircle2,
  Database,
  FileAudio,
  FolderInput,
  Gauge,
  HardDriveDownload,
  ListMusic,
  Loader2,
  Pause,
  Play,
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
import type { NativeLibraryCandidate, NativePathFixSuggestion, NativeRelocateResult, NativeSyncCommitResult } from './services/desktopBridge';
import {
  chooseNativeLibraryFolder,
  commitNativeSync,
  discoverNativeLibraries,
  getNativeCoverArt,
  hasDesktopBridge,
  loadNativeLibraryState,
  nativeScanToImportResult,
  relocateNativeTrackFile,
  saveNativeLibraryState,
  scanNativeLibrary,
  suggestNativePathFixes
} from './services/desktopBridge';
import { findDuplicateCandidates } from './services/duplicates';
import { importFilesFromDirectory } from './services/importAdapters';
import { desktopBridgeChecklist, suggestedLibraryLocations } from './services/libraryDiscovery';

type ViewId = 'library' | 'import' | 'sync' | 'duplicates' | 'settings';
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

interface SyncPlan {
  sourceFormat: LibraryFormat;
  targetLabel: string;
  targetFormat: ImportableFormat;
  targetPath: string;
  djooCount: number;
  targetCount: number;
  keepCount: number;
  addCount: number;
  removeCandidateCount: number;
  warnings: string[];
}

const views: Array<{ id: ViewId; label: string; icon: typeof ListMusic }> = [
  { id: 'library', label: 'Library', icon: ListMusic },
  { id: 'import', label: 'Import', icon: FolderInput },
  { id: 'sync', label: 'Sync', icon: HardDriveDownload },
  { id: 'duplicates', label: 'Duplikate', icon: Shuffle },
  { id: 'settings', label: 'Settings', icon: Settings }
];

const importFormats: ImportableFormat[] = ['serato', 'engine', 'traktor'];

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
  const [pathFixes, setPathFixes] = useState<NativePathFixSuggestion[]>([]);
  const [pathFixBusy, setPathFixBusy] = useState(false);
  const [blockingTask, setBlockingTask] = useState<BlockingTask | null>(null);
  const [repairSummary, setRepairSummary] = useState<RepairSummary | null>(null);
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
      const haystack = [track.title, track.artist, track.genre, track.musicalKey, track.crate, track.sourcePath]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return matchesSource && matchesStatus && (!normalizedQuery || haystack.includes(normalizedQuery));
    });
  }, [query, sourceFilter, statusFilter, tracks]);

  const duplicates = useMemo(() => findDuplicateCandidates(tracks), [tracks]);
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
  }, [availableLibraryFormats, sourceFilter, syncSourceFormat, syncTargetFormat]);

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
      .then((state) => {
        if (cancelled || !state) {
          return;
        }

        setTracks(state.tracks.length > 0 ? state.tracks : seedTracks);
        setReports(state.reports ?? []);
        setPreviewUrls(state.previewUrls ?? {});
        setSelectedTrackId(state.tracks[0]?.id ?? seedTracks[0].id);
        setNativeMessage(`Persistente Library geladen: ${state.tracks.length} Tracks.`);
      })
      .catch((error) => setNativeMessage(getErrorMessage(error)))
      .finally(() => {
        if (!cancelled) {
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

    setImportBusy(true);
    setPlayerError('');

    try {
      const result = await importFilesFromDirectory(event.currentTarget.files, selectedImportFormat);
      ingestImportResult(result);
    } finally {
      setImportBusy(false);
      event.currentTarget.value = '';
    }
  }

  function ingestImportResult(result: ImportResult) {
    setTracks((currentTracks) => mergeImportedTracks(currentTracks, result.tracks));
    setReports((currentReports) => [result.report, ...currentReports].slice(0, 8));
    setPreviewUrls((currentUrls) => ({ ...currentUrls, ...result.previewUrls }));
    setSelectedTrackId(result.tracks[0]?.id ?? selectedTrackId);
    setActiveView('library');
  }

  async function handleNativeDiscover() {
    setNativeBusy(true);
    setNativeMessage('');

    try {
      const candidates = await discoverNativeLibraries();
      const foundCount = candidates.filter((candidate) => candidate.exists).length;
      setNativeCandidates(candidates);
      setNativeMessage(`${foundCount} typische Library-Orte gefunden.`);
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setNativeBusy(false);
    }
  }

  async function handleNativeCandidateScan(candidate: NativeLibraryCandidate) {
    setNativeBusy(true);
    setNativeMessage(`Scanne ${candidate.label}...`);

    try {
      const scanResult = await scanNativeLibrary(candidate.format, candidate.path);
      ingestImportResult(nativeScanToImportResult(scanResult));
      setNativeMessage(`${scanResult.audioFiles} Tracks und ${scanResult.markerFiles} Library-Marker gelesen.`);
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setNativeBusy(false);
    }
  }

  async function handleNativeFolderPick() {
    setNativeBusy(true);
    setNativeMessage('');

    try {
      const scanResult = await chooseNativeLibraryFolder(selectedImportFormat);

      if (!scanResult) {
        setNativeMessage('Ordnerauswahl abgebrochen.');
        return;
      }

      ingestImportResult(nativeScanToImportResult(scanResult));
      setNativeMessage(`${scanResult.audioFiles} Tracks und ${scanResult.markerFiles} Library-Marker gelesen.`);
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setNativeBusy(false);
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

  async function handleBuildSyncPlan(candidate: NativeLibraryCandidate) {
    setSyncBusy(true);
    setSyncPlan(null);
    setSyncCommitResult(null);
    setBlockingTask({
      title: 'Sync-Diff wird erstellt',
      detail: `${candidate.label} wird read-only gescannt und mit Djoo verglichen.`
    });

    try {
      const targetScan = await scanNativeLibrary(candidate.format, candidate.path);
      setSyncPlan(createSyncPlan(tracks, targetScan, candidate.label, syncSourceFormat));
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setSyncBusy(false);
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
      title: 'Path Fix wird angewendet',
      detail: `${fixesToApply.length} Pfade werden in Djoo aktualisiert.`
    });

    await nextPaint();

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
    setNativeMessage(`${fixesToApply.length} Pfade in Djoo aktualisiert. Externe Library wurde nicht automatisch geschrieben.`);
    setRepairSummary({
      title: 'Path Fix angewendet',
      details: [
        `${fixesToApply.length} Track-Pfade wurden in Djoo auf vorhandene lokale Dateien gesetzt.`,
        'Status wurde auf Ready gesetzt und die lokale Preview-URL wurde aktualisiert.',
        getVendorWritebackNotice(fixedTracks)
      ],
      wroteToVendorLibrary: false
    });
    setPathFixes((currentFixes) => currentFixes.filter((fix) => !fixedTrackIds.has(fix.trackId)));
    setPathFixBusy(false);
    setBlockingTask(null);
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

  function applyRelocatedTrack(relocation: NativeRelocateResult) {
    setTracks((currentTracks) => currentTracks.map((track) => {
      if (track.id !== relocation.trackId) {
        return track;
      }

      return {
        ...track,
        originalSourcePath: track.originalSourcePath || track.sourcePath,
        sourcePath: relocation.selectedPath,
        status: 'ready'
      };
    }));
    setPreviewUrls((currentUrls) => ({ ...currentUrls, [relocation.trackId]: pathToFileUrl(relocation.selectedPath) }));
    setPathFixes((currentFixes) => currentFixes.filter((fix) => fix.trackId !== relocation.trackId));
  }

  async function handleCommitSyncPlan() {
    if (!syncPlan) {
      return;
    }

    setSyncCommitBusy(true);
    setBlockingTask({
      title: 'Backup und Manifest werden erstellt',
      detail: `${syncPlan.targetLabel} wird gesichert. Vendor-Writeback bleibt gesperrt, bis ein Exportadapter aktiv ist.`
    });

    try {
      const result = await commitNativeSync({
        sourceFormat: syncPlan.sourceFormat,
        targetFormat: syncPlan.targetFormat,
        targetPath: syncPlan.targetPath,
        trackCount: syncPlan.djooCount,
        addCount: syncPlan.addCount,
        keepCount: syncPlan.keepCount,
        removeCandidateCount: syncPlan.removeCandidateCount
      });
      setSyncCommitResult(result);
      setNativeMessage(result.committed ? 'Sync wurde geschrieben.' : 'Sync-Backup wurde erstellt. Serato Library wurde nicht automatisch geschrieben.');
    } catch (error) {
      setNativeMessage(getErrorMessage(error));
    } finally {
      setSyncCommitBusy(false);
      setBlockingTask(null);
    }
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
              repairSummary={repairSummary}
              onSelectTrack={setSelectedTrackId}
              onPlay={handlePlay}
              onImportClick={() => setActiveView('import')}
              onFindPathFixes={handleFindPathFixes}
              onApplyPathFixes={handleApplyPathFixes}
              onRelocateTrack={handleRelocateTrack}
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
              setSourceFormat={setSyncSourceFormat}
              targetFormat={syncTargetFormat}
              setTargetFormat={setSyncTargetFormat}
              availableFormats={availableLibraryFormats}
              nativeCandidates={nativeCandidates}
              onNativeDiscover={handleNativeDiscover}
              onBuildSyncPlan={handleBuildSyncPlan}
              onCommitSyncPlan={handleCommitSyncPlan}
            />
          )}

          {activeView === 'duplicates' && <DuplicatesView duplicates={duplicates} />}

          {activeView === 'settings' && (
            <SettingsView
              trackCount={tracks.length}
              reportCount={reports.length}
              tracksWithPreview={tracksWithPreview}
              missingTrackCount={missingTrackCount}
              pathFixes={pathFixes}
              pathFixBusy={pathFixBusy}
              repairSummary={repairSummary}
              onReset={resetDemoLibrary}
              onFindPathFixes={handleFindPathFixes}
              onApplyPathFixes={handleApplyPathFixes}
            />
          )}
        </section>
      </main>
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
  repairSummary: RepairSummary | null;
  onSelectTrack: (id: string) => void;
  onPlay: (track: Track) => void;
  onImportClick: () => void;
  onFindPathFixes: () => void;
  onApplyPathFixes: (trackIds?: string[]) => void;
  onRelocateTrack: (track: Track) => void;
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
    repairSummary,
    onSelectTrack,
    onPlay,
    onImportClick,
    onFindPathFixes,
    onApplyPathFixes,
    onRelocateTrack
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
                    className={selectedTrackId === track.id ? 'selected-row' : ''}
                    onClick={() => onSelectTrack(track.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onSelectTrack(track.id);
                      setContextMenu({ x: event.clientX, y: event.clientY, track });
                    }}
                  >
                    <td className="title-cell" title={track.title}>{track.title}</td>
                    <td className="artist-cell" title={track.artist}>{track.artist}</td>
                    <td>{track.bpm ?? '-'}</td>
                    <td title={track.genre ?? ''}>{track.genre ?? '-'}</td>
                    <td><span className={camelotKey.className} title={camelotKey.original}>{camelotKey.display}</span></td>
                    <td>{track.cues.length}/{track.loops.length}</td>
                    <td>{formatLabels[track.sourceFormat]}</td>
                    <td className="path-cell">
                      <span className="track-url" title={track.sourcePath ?? ''}>{formatTrackPath(track.sourcePath)}</span>
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
                  <Wrench size={15} /> Vorschlag anwenden
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
            <span><b>Crate</b>{selectedTrack.crate ?? '-'}</span>
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
            <div className="repair-actions">
              <button className="ghost-button" onClick={onFindPathFixes} disabled={pathFixBusy}>
                {pathFixBusy ? <Loader2 size={16} className="spin" /> : <Wrench size={16} />}
                Fix suchen
              </button>
              <button className="primary-button" onClick={() => onApplyPathFixes()} disabled={pathFixes.length === 0}>
                Anwenden
              </button>
            </div>
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
    onNativeCandidateScan
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
                <div>
                  <b>{formatLabels[report.format]} - {report.sourceName}</b>
                  <p>{new Date(report.importedAt).toLocaleString()} - {report.trackCount} Tracks</p>
                </div>
                <div className="report-meta">
                  {report.markers.map((marker) => <span key={marker}>{marker}</span>)}
                  {report.warnings.map((warning) => <span className="warning" key={warning}>{warning}</span>)}
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
    onCommitSyncPlan
  } = props;
  const importedFormats = availableFormats.filter((format): format is ImportableFormat => format !== 'djoo');
  const sourceCounts = importedFormats.map((format) => ({
    format,
    count: tracks.filter((track) => track.sourceFormat === format).length
  }));
  const targetCandidates = nativeCandidates.filter((candidate) => candidate.format === targetFormat && candidate.exists);

  return (
    <div className="view-grid two-column">
      <section className="tool-panel">
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
          <span><XCircle size={18} /> Writeback bleibt bis Backup/Diff gesperrt</span>
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
        <p className="sync-note">Sync liest Quelle und Ziel, erstellt ein Diff und erzeugt ein Backup mit Manifest. Vendor-Writeback bleibt gesperrt, bis der Exportadapter aktiv ist.</p>
      </section>

      <section className="tool-panel">
        <div className="panel-title">
          <ShieldCheck size={22} />
          <div>
            <p>Sicherheit</p>
            <h2>Pflicht vor Writeback</h2>
          </div>
        </div>
        <div className="check-list">
          {desktopBridgeChecklist.map((item) => <span key={item}><CheckCircle2 size={17} /> {item}</span>)}
        </div>
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
              <span><b>{syncPlan.djooCount}</b>{formatLabels[syncPlan.sourceFormat]} Tracks</span>
              <span><b>{syncPlan.targetCount}</b>Ziel Tracks</span>
              <span><b>{syncPlan.keepCount}</b>Schon vorhanden</span>
              <span><b>{syncPlan.addCount}</b>Neu zu schreiben</span>
              <span><b>{syncPlan.removeCandidateCount}</b>Nur im Ziel</span>
            </div>
            <div className="sync-commit-row">
              <div>
                <b>Backup vor Commit</b>
                <p>Djoo legt im Zielsystem eine Backup Library und ein Sync-Manifest an. Die Serato/Engine Library wird dabei nicht automatisch veraendert.</p>
              </div>
              <button className="primary-button" onClick={onCommitSyncPlan} disabled={syncCommitBusy}>
                {syncCommitBusy ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}
                Backup + Manifest erstellen
              </button>
            </div>
            {syncCommitResult && (
              <div className="sync-result">
                <CheckCircle2 size={18} />
                <span>
                  <b>Backup erstellt: <code>{syncCommitResult.backupPath}</code></b>
                  <small>Manifest: <code>{syncCommitResult.manifestPath}</code></small>
                  <small>{syncCommitResult.committed ? `${formatLabels[syncPlan.targetFormat]} Library wurde geschrieben.` : `${formatLabels[syncPlan.targetFormat]} Library wurde nicht automatisch geaendert.`}</small>
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
  pathFixes: NativePathFixSuggestion[];
  pathFixBusy: boolean;
  repairSummary: RepairSummary | null;
  onReset: () => void;
  onFindPathFixes: () => void;
  onApplyPathFixes: (trackIds?: string[]) => void;
}) {
  const { trackCount, reportCount, tracksWithPreview, missingTrackCount, pathFixes, pathFixBusy, repairSummary, onReset, onFindPathFixes, onApplyPathFixes } = props;

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
        <div className="desktop-button-row">
          <button className="ghost-button" onClick={onFindPathFixes} disabled={pathFixBusy || missingTrackCount === 0}>
            {pathFixBusy ? <Loader2 size={16} className="spin" /> : <Wrench size={16} />}
            Vorschlaege suchen
          </button>
          <button className="primary-button" onClick={() => onApplyPathFixes()} disabled={pathFixes.length === 0}>
            {pathFixes.length} anwenden
          </button>
        </div>
        {repairSummary && <RepairSummaryCard summary={repairSummary} />}
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
    case 'duplicates':
      return 'DUPLICATES';
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

function mergeImportedTracks(currentTracks: Track[], importedTracks: Track[]) {
  const importedKeys = new Set(importedTracks.map(getTrackIdentity));
  const remainingTracks = currentTracks.filter((track) => !importedKeys.has(getTrackIdentity(track)));
  return [...importedTracks, ...remainingTracks];
}

function getTrackIdentity(track: Track) {
  return `${track.sourceFormat}:${normalizeComparablePath(track.sourcePath || track.id)}`;
}

function normalizeComparablePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^file:\/\//i, '').toLowerCase();
}

function createSyncPlan(localTracks: Track[], targetScan: { format: ImportableFormat; rootPath: string; tracks: Track[]; warnings: string[] }, targetLabel: string, sourceFormat: LibraryFormat): SyncPlan {
  const sourceTracks = sourceFormat === 'djoo'
    ? localTracks
    : localTracks.filter((track) => track.sourceFormat === sourceFormat);
  const localKeys = new Set(sourceTracks.map((track) => normalizeComparablePath(track.sourcePath || '')).filter(Boolean));
  const targetKeys = new Set(targetScan.tracks.map((track) => normalizeComparablePath(track.sourcePath || '')).filter(Boolean));
  const keepCount = Array.from(localKeys).filter((key) => targetKeys.has(key)).length;
  const addCount = Array.from(localKeys).filter((key) => !targetKeys.has(key)).length;
  const removeCandidateCount = Array.from(targetKeys).filter((key) => !localKeys.has(key)).length;

  return {
    sourceFormat,
    targetLabel,
    targetFormat: targetScan.format,
    targetPath: targetScan.rootPath,
    djooCount: localKeys.size,
    targetCount: targetKeys.size,
    keepCount,
    addCount,
    removeCandidateCount,
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
