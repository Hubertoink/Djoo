import type { LibraryFormat, PlaylistKind, PlaylistReference, Track } from './domain/library';
import { formatLabels } from './domain/library';
import type { NativeLibraryCandidate } from './services/desktopBridge';

type ViewId = 'library' | 'tags' | 'import' | 'sync' | 'playlists' | 'fixes' | 'settings';
type ImportableFormat = Exclude<LibraryFormat, 'djoo'>;
type TagGapFilter = 'all' | 'mp3-only' | 'missing-genre' | 'missing-album' | 'missing-artist' | 'missing-title';
type TagSortKey = 'title' | 'artist' | 'album' | 'genre' | 'bpm' | 'dateAdded';

interface TagEditDraft {
  title: string;
  artist: string;
  album: string;
  genre: string;
  bpm: string;
  musicalKey: string;
}

interface PlaylistCompareRow {
  name: string;
  targetName: string;
  sourceCount: number;
  targetCount: number;
  sourceKind: PlaylistKind;
  targetKind?: PlaylistKind;
  status: 'same' | 'missing' | 'different';
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
  selectionUpgradeNeeded?: boolean;
}

const importFormats: ImportableFormat[] = ['serato', 'engine', 'traktor'];
const syncPlaylistSelectionSchemaVersion = 2;

export function getViewTitle(viewId: ViewId) {
  switch (viewId) {
    case 'tags':
      return 'TAGS';
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

export function getKeyClass(key?: string) {
  if (!key) {
    return 'key-badge neutral';
  }

  return key.toLowerCase().endsWith('b') ? 'key-badge magenta' : 'key-badge green';
}

export function formatDuration(seconds?: number) {
  if (!seconds) {
    return '--:--';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

export function formatTrackPath(sourcePath?: string) {
  if (!sourcePath) {
    return '-';
  }

  return sourcePath;
}

export function isMp3Track(track: Track) {
  return Boolean(track.sourcePath && /\.mp3$/i.test(track.sourcePath));
}

export function createEmptyTagEditDraft(): TagEditDraft {
  return {
    title: '',
    artist: '',
    album: '',
    genre: '',
    bpm: '',
    musicalKey: ''
  };
}

export function createTagEditDraft(track: Track): TagEditDraft {
  return {
    title: track.title || '',
    artist: track.artist || '',
    album: track.album || '',
    genre: track.genre || '',
    bpm: Number.isFinite(track.bpm) ? String(track.bpm) : '',
    musicalKey: track.musicalKey || ''
  };
}

export function createTagUpdateChanges(draft: TagEditDraft) {
  const changes: {
    title?: string;
    artist?: string;
    album?: string;
    genre?: string;
    bpm?: number;
    musicalKey?: string;
  } = {};

  if (draft.title.trim()) {
    changes.title = draft.title.trim();
  }

  if (draft.artist.trim()) {
    changes.artist = draft.artist.trim();
  }

  if (draft.album.trim()) {
    changes.album = draft.album.trim();
  }

  if (draft.genre.trim()) {
    changes.genre = draft.genre.trim();
  }

  if (draft.musicalKey.trim()) {
    changes.musicalKey = draft.musicalKey.trim();
  }

  const bpm = Number(draft.bpm);

  if (draft.bpm.trim() && Number.isFinite(bpm)) {
    changes.bpm = bpm;
  }

  return changes;
}

export function createFilteredTagTracks(tracks: Track[], options: {
  query: string;
  sourceFilter: LibraryFormat | 'all';
  gapFilter: TagGapFilter;
  sortKey: TagSortKey;
  sortDirection: 'asc' | 'desc';
}) {
  const normalizedQuery = options.query.trim().toLowerCase();
  const filteredTracks = tracks.filter((track) => {
    const matchesSource = options.sourceFilter === 'all' || track.sourceFormat === options.sourceFilter;
    const matchesGap = matchesTagGapFilter(track, options.gapFilter);
    const haystack = [track.title, track.artist, track.album, track.genre, track.musicalKey, track.sourcePath]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return matchesSource && matchesGap && (!normalizedQuery || haystack.includes(normalizedQuery));
  });

  return filteredTracks.sort((first, second) => {
    const comparison = compareTagTrackValues(first, second, options.sortKey);
    return options.sortDirection === 'asc' ? comparison : comparison * -1;
  });
}

function matchesTagGapFilter(track: Track, gapFilter: TagGapFilter) {
  switch (gapFilter) {
    case 'mp3-only':
      return isMp3Track(track);
    case 'missing-genre':
      return !track.genre?.trim();
    case 'missing-album':
      return !track.album?.trim();
    case 'missing-artist':
      return !track.artist?.trim();
    case 'missing-title':
      return !track.title?.trim();
    default:
      return true;
  }
}

function compareTagTrackValues(first: Track, second: Track, sortKey: TagSortKey) {
  if (sortKey === 'bpm') {
    return (first.bpm || 0) - (second.bpm || 0);
  }

  if (sortKey === 'dateAdded') {
    return String(first.dateAdded || '').localeCompare(String(second.dateAdded || ''));
  }

  const firstValue = getTagTrackSortValue(first, sortKey);
  const secondValue = getTagTrackSortValue(second, sortKey);
  return firstValue.localeCompare(secondValue, undefined, { sensitivity: 'base' });
}

function getTagTrackSortValue(track: Track, sortKey: Exclude<TagSortKey, 'bpm' | 'dateAdded'>) {
  switch (sortKey) {
    case 'artist':
      return track.artist || '';
    case 'album':
      return track.album || '';
    case 'genre':
      return track.genre || '';
    default:
      return track.title || '';
  }
}

export function createTagUpdateMessage(updatedCount: number, skippedCount: number, warnings: string[]) {
  const parts = [];

  if (updatedCount > 0) {
    parts.push(`${updatedCount} Track(s) geschrieben.`);
  }

  if (skippedCount > 0) {
    parts.push(`${skippedCount} Track(s) uebersprungen.`);
  }

  if (warnings.length > 0) {
    parts.push(warnings[0]);
  }

  return parts.join(' ');
}

export function getNativeCandidateForFormat(candidates: NativeLibraryCandidate[], format: ImportableFormat) {
  return candidates.find((candidate) => candidate.exists && candidate.format === format);
}

export function createPlaylistSummaries(tracks: Track[]) {
  const summaries = new Map<string, { name: string; kind: PlaylistKind; trackKeys: Set<string> }>();

  for (const track of tracks) {
    const trackKey = normalizeComparablePath(track.sourcePath || track.id);
    const playlistReferences = getTrackPlaylistReferences(track);

    for (const playlistReference of playlistReferences) {
      const cleanName = cleanPlaylistName(playlistReference.name);

      if (!cleanName || /^serato library$/i.test(cleanName)) {
        continue;
      }

      const key = normalizePlaylistCompareName(cleanName);
      const summary = summaries.get(key) || { name: cleanName, kind: playlistReference.kind, trackKeys: new Set<string>() };
      summary.kind = summary.kind === 'smart' || playlistReference.kind === 'smart' ? 'smart' : 'crate';
      summary.trackKeys.add(trackKey);
      summaries.set(key, summary);
    }
  }

  return Array.from(summaries.values())
    .map((summary) => ({ name: summary.name, kind: summary.kind, trackCount: summary.trackKeys.size }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

export function createPlaylistCompareRows(sourceTracks: Track[], targetTracks: Track[]): PlaylistCompareRow[] {
  const sourceSummaries = createPlaylistSummaries(sourceTracks);
  const targetSummaries = createPlaylistSummaries(targetTracks);
  const targetByName = new Map<string, { name: string; kind: PlaylistKind; trackCount: number }>();

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
      sourceKind: sourceSummary.kind,
      targetKind: targetSummary?.kind,
      status
    };
  });
}

export function countTracksInPlaylists(tracks: Track[], playlistNames: string[]) {
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

export function getTrackPlaylistReferences(track: Track): PlaylistReference[] {
  if (Array.isArray(track.playlists) && track.playlists.length > 0) {
    const playlistReferences = new Map<string, PlaylistReference>();

    for (const playlist of track.playlists) {
      const cleanName = cleanPlaylistName(playlist?.name || '');

      if (!cleanName) {
        continue;
      }

      const key = normalizePlaylistCompareName(cleanName);
      const existing = playlistReferences.get(key);
      const nextReference: PlaylistReference = {
        name: cleanName,
        kind: playlist.kind === 'smart' ? 'smart' : 'crate',
        match: playlist.match === 'any' ? 'any' : 'all',
        rules: Array.isArray(playlist.rules)
          ? playlist.rules
            .map((rule) => ({
              field: cleanPlaylistName(rule.field || ''),
              operator: cleanPlaylistName(rule.operator || ''),
              value: cleanPlaylistName(rule.value || '')
            }))
            .filter((rule) => rule.field && rule.operator && rule.value)
          : undefined
      };

      if (!existing || (existing.kind === 'crate' && nextReference.kind === 'smart')) {
        playlistReferences.set(key, nextReference);
      }
    }

    if (playlistReferences.size > 0) {
      return Array.from(playlistReferences.values());
    }
  }

  return getTrackPlaylistNames(track).map((name) => ({ name, kind: 'crate' }));
}

export function getTrackPlaylistNames(track: Track) {
  if (Array.isArray(track.crates)) {
    return track.crates;
  }

  return String(track.crate || '')
    .split(',')
    .map((crateName) => crateName.trim())
    .filter(Boolean);
}

export function getSelectedPlaylistReferences(tracks: Track[], selectedPlaylistNames?: string[]) {
  if (!selectedPlaylistNames || selectedPlaylistNames.length === 0) {
    return [];
  }

  const selectedKeys = new Set(selectedPlaylistNames.map(normalizePlaylistCompareName));
  const references = new Map<string, PlaylistReference>();

  for (const track of tracks) {
    for (const playlist of getTrackPlaylistReferences(track)) {
      const cleanName = cleanPlaylistName(playlist.name);
      const key = normalizePlaylistCompareName(cleanName);

      if (!selectedKeys.has(key)) {
        continue;
      }

      const existing = references.get(key);

      if (!existing || (existing.kind === 'crate' && playlist.kind === 'smart')) {
        references.set(key, playlist);
      }
    }
  }

  return selectedPlaylistNames
    .map((playlistName) => references.get(normalizePlaylistCompareName(playlistName)))
    .filter((playlist): playlist is PlaylistReference => Boolean(playlist));
}

function formatSeratoPlaylistName(value: string) {
  return cleanPlaylistName(value)
    .replace(/[\\/]+/g, ' - ')
    .replace(/[<>:"|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizePlaylistCompareName(value: string) {
  return formatSeratoPlaylistName(value).toLowerCase();
}

function cleanPlaylistName(value: string) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function getTrackRowClass(track: Track, selected: boolean, duplicate: boolean) {
  return [
    selected ? 'selected-row' : '',
    track.status === 'missing-file' ? 'missing-row' : '',
    duplicate ? 'duplicate-track-row' : ''
  ].filter(Boolean).join(' ');
}

export function getTrackContextMenuHeight(track: Track, hasRelocateSuggestion: boolean, duplicate: boolean) {
  let itemCount = 2;

  if (track.status === 'missing-file' && hasRelocateSuggestion) {
    itemCount += 1;
  }

  if (duplicate) {
    itemCount += 1;
  }

  return 12 + itemCount * 38;
}

export function getSafeContextMenuPosition(x: number, y: number, width: number, height: number) {
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

export function getSyncSelectionKey(sourceFormat: LibraryFormat, targetFormat: ImportableFormat) {
  return `${sourceFormat}->${targetFormat}`;
}

function getInitialSyncPlaylistSelection(sourceTracks: Track[], sourceFormat: LibraryFormat, targetFormat: ImportableFormat, storedSelections: Record<string, string[]>, storedSelectionVersions: Record<string, number> = {}) {
  const summaries = createPlaylistSummaries(sourceTracks);
  const selectionKey = getSyncSelectionKey(sourceFormat, targetFormat);

  if (summaries.length === 0) {
    return { selectedPlaylistNames: undefined, selectionUpgradeNeeded: false };
  }

  const storedSelection = storedSelections[selectionKey];
  const storedVersion = storedSelectionVersions[selectionKey] ?? 0;
  const smartPlaylistNames = summaries
    .filter((summary) => summary.kind === 'smart')
    .map((summary) => summary.name);

  if (!Array.isArray(storedSelection)) {
    return {
      selectedPlaylistNames: summaries.map((summary) => summary.name),
      selectionUpgradeNeeded: false
    };
  }

  if (storedSelection.length === 0) {
    return { selectedPlaylistNames: [], selectionUpgradeNeeded: false };
  }

  const restoredSelection = sanitizeSyncPlaylistSelection(sourceTracks, storedSelection);
  const fallbackSelection = summaries.map((summary) => summary.name);
  const baseSelection = restoredSelection && restoredSelection.length > 0 ? restoredSelection : fallbackSelection;

  if (storedVersion >= syncPlaylistSelectionSchemaVersion || smartPlaylistNames.length === 0 || baseSelection.length === 0) {
    return {
      selectedPlaylistNames: baseSelection,
      selectionUpgradeNeeded: false
    };
  }

  const selectedKeys = new Set(baseSelection.map(normalizePlaylistCompareName));
  const missingSmartPlaylistNames = smartPlaylistNames.filter((playlistName) => !selectedKeys.has(normalizePlaylistCompareName(playlistName)));

  if (missingSmartPlaylistNames.length === 0) {
    return {
      selectedPlaylistNames: baseSelection,
      selectionUpgradeNeeded: false
    };
  }

  return {
    selectedPlaylistNames: [...baseSelection, ...missingSmartPlaylistNames],
    selectionUpgradeNeeded: true
  };
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

export function getSyncPlanSelectedTracks(plan: SyncPlan) {
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

export function applySyncPlaylistSelection(plan: SyncPlan, playlistNames: string[]) {
  const selectedPlaylistNames = sanitizeSyncPlaylistSelection(plan.sourceTracks, playlistNames);
  const selectedTracks = plan.includeAllTracks ? plan.sourceTracks : getSyncSelectedTracks(plan.sourceTracks, selectedPlaylistNames);
  const stats = createSyncPlanStats(selectedTracks, plan.targetTrackKeys);

  return {
    ...plan,
    ...stats,
    selectedPlaylistNames
  };
}

export function applySyncIncludeAllTracks(plan: SyncPlan, includeAllTracks: boolean) {
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

export function getSyncPlaylistSelectionText(plan: SyncPlan) {
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
    return `${plan.selectedPlaylistNames.length} Playlist(s) sind fuer Crates ausgewaehlt; alle ${plan.djooCount} Tracks bleiben trotzdem im Sync-Set enthalten.`;
  }

  if (plan.selectedPlaylistNames.length >= summaries.length) {
    return 'Alle Playlists sind ausgewaehlt; einzelne Tracks ohne Playlist bleiben enthalten.';
  }

  return `${plan.selectedPlaylistNames.length} Playlist(s) sind ausgewaehlt; der Sync wird auf ${plan.djooCount} Tracks aus dieser Auswahl begrenzt.`;
}

export function normalizeComparablePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^file:\/\//i, '').toLowerCase();
}

export function createSyncPlan(localTracks: Track[], targetScan: { format: ImportableFormat; rootPath: string; tracks: Track[]; warnings: string[] }, targetLabel: string, sourceFormat: LibraryFormat, sourceTracksOverride?: Track[], storedSelections: Record<string, string[]> = {}, storedIncludeAllTracks: Record<string, boolean> = {}, storedSelectionVersions: Record<string, number> = {}): SyncPlan {
  const sourceTracks = sourceTracksOverride ?? getSyncSourceTracks(localTracks, sourceFormat);
  const targetTrackKeys = targetScan.tracks.map((track) => normalizeComparablePath(track.sourcePath || '')).filter(Boolean);
  const selectionState = getInitialSyncPlaylistSelection(sourceTracks, sourceFormat, targetScan.format, storedSelections, storedSelectionVersions);
  const selectedPlaylistNames = selectionState.selectedPlaylistNames;
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
    warnings: targetScan.warnings,
    selectionUpgradeNeeded: selectionState.selectionUpgradeNeeded
  };
}

export function pathToFileUrl(filePath: string) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const prefixedPath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
  return encodeURI(`file://${prefixedPath}`);
}
