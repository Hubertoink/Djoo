const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');
const NodeID3 = require('node-id3');
const initSqlJs = require('sql.js');
const {
  readEngineCratesByTrackId,
  readEngineSmartlists,
  matchEngineSmartlists
} = require('./library/engine.cjs');
const {
  createSyncCrateGroups,
  patchSerato4ContainerHierarchy
} = require('./library/serato.cjs');

const importFormats = new Set(['serato', 'engine', 'traktor']);
const audioExtensions = new Set(['.mp3', '.wav', '.aiff', '.aif', '.flac', '.m4a', '.ogg']);
const maxScanFiles = 18000;
const maxRelocateScanFiles = 75000;
const maxScanDepth = 12;
const maxRelocateScanDepth = 16;
const maxId3ReadBytes = 8 * 1024 * 1024;
const engineCueSampleRate = 44100;
const seratoDatabaseVersion = '2.0/Serato Scratch LIVE Database';
const seratoCrateVersion = '1.0/Serato ScratchLive Crate';
const NodeID3Promise = NodeID3.Promise;
let sqlModulePromise;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f4f5f8',
    title: 'Djoo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devServerUrl = process.env.DJOO_DEV_SERVER_URL;

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function registerIpcHandlers() {
  ipcMain.handle('djoo:discover-libraries', async () => {
    const candidates = getSuggestedLocations();
    return Promise.all(candidates.map((candidate) => inspectCandidate(candidate)));
  });

  ipcMain.handle('djoo:scan-library', async (_event, request) => {
    validateScanRequest(request);
    return scanLibrary(request.format, request.rootPath, {
      incremental: Boolean(request.incremental),
      previousTracks: Array.isArray(request.previousTracks) ? request.previousTracks : []
    });
  });

  ipcMain.handle('djoo:get-library-sync-status', async (_event, request) => {
    validateScanRequest(request);
    return getLibrarySyncStatus(request);
  });

  ipcMain.handle('djoo:choose-library-folder', async (_event, format) => {
    if (!importFormats.has(format)) {
      throw new Error('Unsupported library format.');
    }

    const result = await dialog.showOpenDialog({
      title: `${getFormatLabel(format)} Library waehlen`,
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return scanLibrary(format, result.filePaths[0]);
  });

  ipcMain.handle('djoo:load-library-state', async () => loadLibraryState());

  ipcMain.handle('djoo:save-library-state', async (_event, state) => saveLibraryState(state));

  ipcMain.handle('djoo:get-cover-art', async (_event, filePath) => readCoverArt(filePath));

  ipcMain.handle('djoo:suggest-path-fixes', async (_event, tracks) => suggestPathFixes(tracks));

  ipcMain.handle('djoo:relocate-track-file', async (_event, track) => relocateTrackFile(track));

  ipcMain.handle('djoo:relocate-missing-tracks', async (_event, tracks) => relocateMissingTracks(tracks));

  ipcMain.handle('djoo:update-track-tags', async (_event, request) => updateTrackTags(request));

  ipcMain.handle('djoo:commit-sync', async (_event, request) => commitSync(request));
}

function validateScanRequest(request) {
  if (!request || !importFormats.has(request.format) || typeof request.rootPath !== 'string') {
    throw new Error('Invalid scan request.');
  }
}

function getSuggestedLocations() {
  const home = os.homedir();
  const candidates = [
    {
      format: 'serato',
      label: 'Serato Musik Library',
      path: path.join(home, 'Music', '_Serato_')
    },
    {
      format: 'engine',
      label: 'Engine DJ Library',
      path: path.join(home, 'Music', 'Engine Library')
    },
    {
      format: 'traktor',
      label: 'Traktor Collection Root',
      path: path.join(home, 'Documents', 'Native Instruments')
    }
  ];

  if (process.platform === 'win32') {
    for (const driveLetter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const driveRoot = `${driveLetter}:\\`;

      if (safeExists(driveRoot)) {
        candidates.push(
          { format: 'serato', label: `Serato Laufwerk ${driveLetter}:`, path: path.join(driveRoot, '_Serato_') },
          { format: 'engine', label: `Engine Laufwerk ${driveLetter}:`, path: path.join(driveRoot, 'Engine Library') }
        );
      }
    }
  }

  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.format}:${candidate.path.toLowerCase()}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function inspectCandidate(candidate) {
  const exists = await pathExists(candidate.path);

  if (!exists) {
    return {
      ...candidate,
      exists: false,
      markerFiles: 0,
      audioFiles: 0,
      markers: [],
      warning: 'Nicht gefunden'
    };
  }

  const collected = await collectFiles(candidate.path, candidate.format, { includeStats: false });
  const trackReferenceCount = candidate.format === 'serato'
    ? (await readSeratoLibraryEntries(candidate.path, collected)).length
    : collected.audioFiles.length;

  return {
    ...candidate,
    exists: true,
    markerFiles: collected.markerFiles.length,
    audioFiles: trackReferenceCount,
    markers: Array.from(collected.markers).slice(0, 6),
    warning: collected.truncated ? `Scan auf ${maxScanFiles} Dateien begrenzt.` : ''
  };
}

async function scanLibrary(format, rootPath, options = {}) {
  const exists = await pathExists(rootPath);

  if (!exists) {
    throw new Error(`Library path not found: ${rootPath}`);
  }

  const importedAt = new Date().toISOString();
  const libraryFingerprint = await computeLibraryFingerprint(format, rootPath);
  const collected = await collectFiles(rootPath, format, { includeStats: true });
  const sourceName = path.basename(rootPath) || rootPath;
  const warnings = [...collected.warnings];
  const references = await readLibraryReferences(format, rootPath, collected, sourceName, warnings);
  const previousTracksByPath = createPreviousTrackIndex(Array.isArray(options.previousTracks) ? options.previousTracks : [], format);

  if (format === 'serato' && references.length > collected.audioFiles.length) {
    warnings.push(`Serato database V2/Crates lieferten ${references.length} Trackreferenzen. Der Ordner selbst enthaelt ${collected.audioFiles.length} Audiodateien.`);
  }

  if (format === 'engine' && references.some((reference) => reference.sourceDatabase)) {
    warnings.push('Engine DJ Track-, BPM-, Key- und Hotcue-Daten wurden aus Database2 gelesen.');
  }

  if (references.length === 0) {
    warnings.push('Keine Tracks gefunden. Fuer dieses Format fehlt eventuell noch der vollstaendige Datenbankparser.');
  }

  if (collected.truncated) {
    warnings.push(`Scan wurde nach ${maxScanFiles} Dateien begrenzt.`);
  }

  const tracks = [];
  let reusedTrackCount = 0;
  let rebuiltTrackCount = 0;

  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const previousTrack = previousTracksByPath.get(normalizeComparablePath(reference.path || ''));

    if (format === 'engine' && options.incremental && canReuseIncrementalTrack(previousTrack, reference)) {
      tracks.push(createReusedTrackDraft(previousTrack));
      reusedTrackCount += 1;
      continue;
    }

    tracks.push(await buildTrackFromReference(reference, format, sourceName, importedAt, index));
    rebuiltTrackCount += 1;
  }

  if (format === 'engine' && options.incremental) {
    warnings.push(`Engine Delta-Import: ${reusedTrackCount} Tracks unveraendert uebernommen, ${rebuiltTrackCount} Tracks neu gelesen.`);
  }

  return {
    format,
    rootPath,
    sourceName,
    importedAt,
    libraryFingerprint,
    tracks,
    markers: Array.from(collected.markers),
    warnings,
    scannedFiles: collected.scannedFiles,
    markerFiles: collected.markerFiles.length,
    audioFiles: tracks.length
  };
}

async function getLibrarySyncStatus(request) {
  const previousFingerprint = typeof request?.previousFingerprint === 'string' ? request.previousFingerprint : '';
  const exists = await pathExists(request.rootPath);

  if (!exists) {
    return {
      format: request.format,
      rootPath: request.rootPath,
      exists: false,
      fingerprint: 'missing',
      changed: previousFingerprint !== 'missing',
      reason: 'Library-Pfad nicht gefunden.'
    };
  }

  const fingerprint = await computeLibraryFingerprint(request.format, request.rootPath);
  const changed = !previousFingerprint || fingerprint !== previousFingerprint;

  return {
    format: request.format,
    rootPath: request.rootPath,
    exists: true,
    fingerprint,
    changed,
    reason: !previousFingerprint
      ? 'Noch keine gespeicherte Signatur vorhanden.'
      : changed
        ? 'Aenderungen an der Library erkannt.'
        : 'Keine Aenderungen erkannt.'
  };
}

async function readLibraryReferences(format, rootPath, collected, sourceName, warnings) {
  if (format === 'serato') {
    return readSeratoLibraryEntries(rootPath, collected);
  }

  if (format === 'engine') {
    const engineEntries = await readEngineLibraryEntries(rootPath, collected, warnings);

    if (engineEntries.length > 0) {
      return engineEntries;
    }
  }

  return collected.audioFiles.map((file) => ({ path: file.path, crate: sourceName }));
}

async function readSeratoLibraryEntries(rootPath, collected) {
  const entries = new Map();
  const databasePath = path.join(rootPath, 'database V2');
  const cueManifestByPath = await readLatestSeratoSyncCueManifest(rootPath);

  if (await pathExists(databasePath)) {
    const databaseBuffer = await fs.readFile(databasePath);
    const databaseEntries = parseSeratoTrackBuffer(databaseBuffer, 'Serato Library');
    databaseEntries.forEach((entry) => mergeSeratoEntry(entries, entry));
  }

  const cratePaths = collected.markerFiles.filter((filePath) => filePath.toLowerCase().endsWith('.crate'));

  for (const cratePath of cratePaths) {
    const crateBuffer = await fs.readFile(cratePath);
    const crateName = path.basename(cratePath, path.extname(cratePath));
    const crateEntries = parseSeratoTrackBuffer(crateBuffer, crateName).map((entry) => ({ ...entry, crate: crateName }));
    crateEntries.forEach((entry) => mergeSeratoEntry(entries, entry));
  }

  return Array.from(entries.values()).map((entry) => {
    const crates = Array.from(entry.crates);
    const manifestTrack = cueManifestByPath.get(normalizeComparablePath(entry.path));
    return {
      path: entry.path,
      originalPath: entry.originalPath,
      title: entry.title,
      artist: entry.artist,
      genre: entry.genre,
      bpm: entry.bpm,
      musicalKey: entry.musicalKey,
      durationSeconds: entry.durationSeconds,
      cues: Array.isArray(manifestTrack?.cues) ? manifestTrack.cues : undefined,
      loops: Array.isArray(manifestTrack?.loops) ? manifestTrack.loops : undefined,
      crates,
      crate: crates.length > 0 ? crates.join(', ') : 'Serato Library'
    };
  });
}

async function readLatestSeratoSyncCueManifest(rootPath) {
  const manifestFolder = path.join(rootPath, 'Djoo Sync');
  const tracksByPath = new Map();
  let entries;

  try {
    entries = await fs.readdir(manifestFolder, { withFileTypes: true });
  } catch {
    return tracksByPath;
  }

  const manifestNames = entries
    .filter((entry) => entry.isFile() && /^djoo-cues-loops-.*\.json$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const manifestName of manifestNames) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(manifestFolder, manifestName), 'utf8'));

      if (!Array.isArray(manifest.tracks)) {
        continue;
      }

      for (const track of manifest.tracks) {
        if (typeof track.sourcePath === 'string' && track.sourcePath.trim()) {
          tracksByPath.set(normalizeComparablePath(track.sourcePath), track);
        }
      }

      return tracksByPath;
    } catch {
      tracksByPath.clear();
    }
  }

  return tracksByPath;
}

async function readEngineLibraryEntries(rootPath, collected, warnings) {
  const engineDatabasePaths = getEngineDatabasePaths(rootPath, collected);

  if (engineDatabasePaths.length === 0) {
    return [];
  }

  const entries = new Map();
  const audioByFileName = createAudioFileNameIndex(collected.audioFiles);
  const SQL = await getSqlModule();

  for (const databasePath of engineDatabasePaths) {
    let database;

    try {
      database = new SQL.Database(await fs.readFile(databasePath));
      const trackRows = executeSqlRows(database, `
        SELECT
          Track.id,
          Track.title,
          Track.artist,
          Track.album,
          Track.genre,
          Track.bpm,
          Track.bpmAnalyzed,
          Track.key,
          Track.length,
          Track.path,
          Track.filename,
          Track.dateAdded,
          PerformanceData.quickCues,
          PerformanceData.loops
        FROM Track
        LEFT JOIN PerformanceData ON Track.id = PerformanceData.trackId
      `);
      const cratesByTrackId = readEngineCratesByTrackId(database, { executeSqlRows, cleanText });
      const smartlists = readEngineSmartlists(database, { executeSqlRows, cleanText });

      if (smartlists.length > 0) {
        warnings.push(`Engine Smartlists gelesen: ${smartlists.length}. Djoo markiert sie im Sync jetzt separat und exportiert sie fuer Serato 4 als Smart Crates.`);
      }

      for (const row of trackRows) {
        const filePath = await resolveEngineTrackPath(row.path, row.filename, rootPath, audioByFileName);

        if (!filePath) {
          continue;
        }

        const key = normalizeComparablePath(filePath);
        const currentEntry = entries.get(key) || {};
        const cues = parseEngineQuickCues(row.quickCues);
        const loops = parseEngineLoops(row.loops);
        const crateNames = cratesByTrackId.get(row.id) || [];
        const matchingSmartlists = matchEngineSmartlists(row, smartlists);
        const smartlistNames = matchingSmartlists.map((smartlist) => smartlist.path);
        const mergedCrateNames = mergeUniqueValues(currentEntry.crates || [], [...crateNames, ...smartlistNames]);
        const playlistReferences = mergePlaylistReferences(currentEntry.playlists || [], [
          ...crateNames.map((crateName) => ({ name: crateName, kind: 'crate' })),
          ...matchingSmartlists.map((smartlist) => ({
            name: smartlist.path,
            kind: 'smart',
            match: smartlist.match,
            rules: Array.isArray(smartlist.rules)
              ? smartlist.rules
                .map((rule) => ({
                  field: cleanText(rule.field || rule.column || ''),
                  operator: cleanText(rule.operator || rule.condition || ''),
                  value: cleanText(rule.value || rule.param || '')
                }))
                .filter((rule) => rule.field && rule.operator && rule.value)
              : []
          }))
        ]);
        const sourceSignature = createEngineTrackSourceSignature({
          filePath,
          row,
          cues,
          loops,
          crates: mergedCrateNames,
          playlists: playlistReferences
        });

        entries.set(key, {
          ...currentEntry,
          path: filePath,
          title: row.title || currentEntry.title,
          artist: row.artist || currentEntry.artist,
          album: row.album || currentEntry.album,
          genre: row.genre || currentEntry.genre,
          bpm: parseNumber(row.bpmAnalyzed) || parseNumber(row.bpm) || currentEntry.bpm,
          musicalKey: normalizeEngineKey(row.key) || currentEntry.musicalKey,
          durationSeconds: parseNumber(row.length) || currentEntry.durationSeconds,
          crates: mergedCrateNames,
          crate: mergedCrateNames.length > 0 ? mergedCrateNames.join(', ') : currentEntry.crate,
          dateAdded: row.dateAdded || currentEntry.dateAdded,
          cues: cues.length > 0 ? cues : currentEntry.cues,
          loops: loops.length > 0 ? loops : currentEntry.loops,
          playlists: playlistReferences.length > 0 ? playlistReferences : currentEntry.playlists,
          sourceSignature,
          sourceDatabase: databasePath
        });
      }
    } catch (error) {
      warnings.push(`Engine Datenbank nicht lesbar: ${databasePath}`);
    } finally {
      if (database) {
        database.close();
      }
    }
  }

  return Array.from(entries.values());
}

function getEngineDatabasePaths(rootPath, collected) {
  const markerPaths = collected.markerFiles
    .filter((filePath) => path.basename(filePath).toLowerCase() === 'm.db')
    .sort((first, second) => getEngineDatabasePriority(first, rootPath) - getEngineDatabasePriority(second, rootPath));

  if (markerPaths.length > 0) {
    return dedupePaths(markerPaths);
  }

  const fallbackPath = path.join(rootPath, 'Database2', 'm.db');

  if (safeExists(fallbackPath)) {
    return [fallbackPath];
  }

  return dedupePaths(collected.markerFiles.filter((filePath) => path.extname(filePath).toLowerCase() === '.db'));
}

function getEngineDatabasePriority(databasePath, rootPath) {
  const normalized = databasePath.toLowerCase().replace(/\\/g, '/');
  const preferred = path.join(rootPath, 'Database2', 'm.db').toLowerCase().replace(/\\/g, '/');
  return normalized === preferred ? 0 : 1;
}

function dedupePaths(filePaths) {
  const seen = new Set();
  return filePaths.filter((filePath) => {
    const key = filePath.toLowerCase();

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function executeSqlRows(database, query, params = []) {
  const result = Array.isArray(params) && params.length > 0
    ? database.exec(query, params)
    : database.exec(query);

  if (!result[0]) {
    return [];
  }

  const columns = result[0].columns;
  return result[0].values.map((values) => Object.fromEntries(values.map((value, index) => [columns[index], value])));
}

function createAudioFileNameIndex(audioFiles) {
  const index = new Map();

  for (const file of audioFiles) {
    const fileName = path.basename(file.path).toLowerCase();
    const matches = index.get(fileName) || [];
    matches.push(file.path);
    index.set(fileName, matches);
  }

  return index;
}

async function resolveEngineTrackPath(rawPath, fileName, rootPath, audioByFileName) {
  const candidates = [];

  if (typeof rawPath === 'string' && rawPath.trim()) {
    const cleanPath = rawPath.replace(/^file:\/\//i, '').replace(/\//g, path.sep);

    if (/^[A-Za-z]:[\\/]/.test(cleanPath)) {
      candidates.push(path.normalize(cleanPath));
    } else {
      candidates.push(path.resolve(rootPath, cleanPath));
      candidates.push(path.resolve(path.dirname(rootPath), cleanPath));
    }
  }

  if (fileName) {
    const indexedMatches = audioByFileName.get(String(fileName).toLowerCase()) || [];
    candidates.push(...indexedMatches);
  }

  for (const candidate of dedupePaths(candidates)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || '';
}

function parseEngineQuickCues(blob) {
  const inflated = inflateEngineBlob(blob);

  if (!inflated || inflated.length < 9) {
    return [];
  }

  const cues = [];
  let offset = 8;

  while (offset < inflated.length && cues.length < 8) {
    const labelLength = inflated[offset];
    const entryLength = 1 + labelLength + 8 + 4;

    if (labelLength <= 0 || offset + entryLength > inflated.length) {
      break;
    }

    const label = cleanText(inflated.subarray(offset + 1, offset + 1 + labelLength).toString('utf8')) || `Cue ${cues.length + 1}`;
    const positionSamples = inflated.readDoubleBE(offset + 1 + labelLength);
    const colorOffset = offset + 1 + labelLength + 8;
    const color = `#${inflated[colorOffset + 1].toString(16).padStart(2, '0')}${inflated[colorOffset + 2].toString(16).padStart(2, '0')}${inflated[colorOffset + 3].toString(16).padStart(2, '0')}`;
    const positionMs = samplesToMilliseconds(positionSamples);

    if (Number.isFinite(positionMs) && positionMs >= 0) {
      cues.push({
        id: `engine-cue-${cues.length}-${positionMs}`,
        label,
        positionMs,
        color
      });
    }

    offset += entryLength;
  }

  return cues;
}

function parseEngineLoops(blob) {
  if (!blob) {
    return [];
  }

  const buffer = Buffer.from(blob);
  const loops = [];
  const slotCount = Math.min(buffer[0] || 0, 8);

  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const offset = 8 + slotIndex * 24;

    if (offset + 16 > buffer.length) {
      break;
    }

    const startSamples = buffer.readDoubleLE(offset);
    const endSamples = buffer.readDoubleLE(offset + 8);

    if (!Number.isFinite(startSamples) || !Number.isFinite(endSamples) || startSamples < 0 || endSamples <= startSamples) {
      continue;
    }

    loops.push({
      id: `engine-loop-${slotIndex}-${samplesToMilliseconds(startSamples)}`,
      label: `Loop ${slotIndex + 1}`,
      startMs: samplesToMilliseconds(startSamples),
      endMs: samplesToMilliseconds(endSamples)
    });
  }

  return loops;
}

function inflateEngineBlob(blob) {
  if (!blob) {
    return null;
  }

  const buffer = Buffer.from(blob);

  if (buffer.length <= 4) {
    return null;
  }

  try {
    return zlib.inflateSync(buffer.subarray(4));
  } catch {
    return null;
  }
}

function samplesToMilliseconds(samples) {
  return Math.max(0, Math.round((samples / engineCueSampleRate) * 1000));
}

function normalizeEngineKey(value) {
  const numericKey = Number(value);

  if (!Number.isInteger(numericKey) || numericKey <= 0) {
    return undefined;
  }

  if (numericKey % 2 === 1) {
    return `${(numericKey + 1) / 2}m`;
  }

  return `${(numericKey / 2) + 1}d`;
}

function getSqlModule() {
  if (!sqlModulePromise) {
    sqlModulePromise = initSqlJs({
      locateFile: (fileName) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', fileName)
    });
  }

  return sqlModulePromise;
}

function mergeSeratoEntry(entries, rawEntry) {
  if (!rawEntry.path) {
    return;
  }

  const normalizedPath = normalizeSeratoPath(rawEntry.path);
  const key = normalizedPath.toLowerCase();
  const existing = entries.get(key) || { path: normalizedPath, crates: new Set() };

  existing.originalPath ||= rawEntry.path !== normalizedPath ? rawEntry.path : undefined;
  existing.title ||= rawEntry.title;
  existing.artist ||= rawEntry.artist;
  existing.genre ||= rawEntry.genre;
  existing.bpm ||= rawEntry.bpm;
  existing.musicalKey ||= rawEntry.musicalKey;
  existing.durationSeconds ||= rawEntry.durationSeconds;

  if (rawEntry.crate) {
    existing.crates.add(rawEntry.crate);
  }

  entries.set(key, existing);
}

function parseSeratoTrackBuffer(buffer, crateName) {
  const entries = [];
  const trackTag = Buffer.from('otrk');
  let offset = 0;

  while (offset <= buffer.length - 8) {
    const trackOffset = buffer.indexOf(trackTag, offset);

    if (trackOffset === -1 || trackOffset > buffer.length - 8) {
      break;
    }

    const payloadLength = buffer.readUInt32BE(trackOffset + 4);
    const payloadStart = trackOffset + 8;
    const payloadEnd = payloadStart + payloadLength;

    if (payloadLength <= 0 || payloadEnd > buffer.length) {
      offset = trackOffset + 4;
      continue;
    }

    const fields = parseSeratoTrackFields(buffer, payloadStart, payloadEnd);

    if (fields.path) {
      entries.push({ ...fields, crate: crateName });
    }

    offset = payloadEnd;
  }

  return entries;
}

function parseSeratoTrackFields(buffer, start, end) {
  const fields = {};
  let offset = start;

  while (offset <= end - 8) {
    const tag = buffer.toString('ascii', offset, offset + 4);
    const payloadLength = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + payloadLength;

    if (payloadLength < 0 || payloadEnd > end) {
      break;
    }

    const payload = buffer.subarray(payloadStart, payloadEnd);

    if (tag === 'pfil' || tag === 'ptrk') fields.path = decodeUtf16Be(payload);
    if (tag === 'tsng') fields.title = decodeUtf16Be(payload);
    if (tag === 'tart') fields.artist = decodeUtf16Be(payload);
    if (tag === 'tgen') fields.genre = decodeUtf16Be(payload);
    if (tag === 'tbpm') fields.bpm = parseNumber(decodeUtf16Be(payload));
    if (tag === 'tkey') fields.musicalKey = decodeUtf16Be(payload);
    if (tag === 'tlen') fields.durationSeconds = parseSeratoDuration(decodeUtf16Be(payload));

    offset = payloadEnd;
  }

  return fields;
}

async function buildTrackFromReference(reference, format, sourceName, importedAt, index) {
  const filePath = reference.path;
  const parsed = parseTrackName(path.basename(filePath));
  const exists = await pathExists(filePath);
  const id3 = exists ? await readBasicAudioMetadata(filePath) : {};
  const title = reference.title || id3.title || parsed.title;
  const artist = reference.artist || id3.artist || parsed.artist;
  const bpm = parseNumber(reference.bpm ?? id3.bpm);
  const durationSeconds = reference.durationSeconds || id3.durationSeconds;
  const cues = Array.isArray(reference.cues) && reference.cues.length > 0 ? reference.cues : id3.cues || [];
  const loops = Array.isArray(reference.loops) && reference.loops.length > 0 ? reference.loops : id3.loops || [];

  return {
    id: createId(`${format}-${filePath}`),
    title,
    artist,
    album: reference.album || id3.album,
    bpm,
    genre: reference.genre || id3.genre || parsed.genre,
    musicalKey: reference.musicalKey || id3.musicalKey,
    durationSeconds,
    sourceFormat: format,
    sourcePath: filePath,
    originalSourcePath: reference.originalPath,
    sourceSignature: reference.sourceSignature,
    crates: Array.isArray(reference.crates) ? reference.crates : undefined,
    playlists: Array.isArray(reference.playlists) && reference.playlists.length > 0 ? reference.playlists : undefined,
    crate: reference.crate || sourceName,
    dateAdded: importedAt,
    cues,
    loops,
    status: exists ? 'ready' : 'missing-file',
    previewUrl: exists ? pathToFileURL(filePath).toString() : ''
  };
}

function createPreviousTrackIndex(previousTracks, format) {
  if (!Array.isArray(previousTracks) || previousTracks.length === 0) {
    return new Map();
  }

  return new Map(previousTracks
    .filter((track) => track?.sourceFormat === format && typeof track?.sourcePath === 'string')
    .map((track) => [normalizeComparablePath(track.sourcePath || ''), track]));
}

function canReuseIncrementalTrack(previousTrack, reference) {
  if (!previousTrack || !reference || !reference.sourceSignature) {
    return false;
  }

  return previousTrack.sourceSignature === reference.sourceSignature
    && normalizeComparablePath(previousTrack.sourcePath || '') === normalizeComparablePath(reference.path || '');
}

function createReusedTrackDraft(previousTrack) {
  const previewUrl = previousTrack.status === 'ready' && previousTrack.sourcePath
    ? pathToFileURL(previousTrack.sourcePath).toString()
    : '';

  return {
    ...previousTrack,
    previewUrl
  };
}

function createEngineTrackSourceSignature({ filePath, row, cues, loops, crates, playlists }) {
  const hash = createHash('sha1');
  hash.update(normalizeComparablePath(filePath || ''));
  hash.update('\n');
  hash.update(String(row.title || ''));
  hash.update('\n');
  hash.update(String(row.artist || ''));
  hash.update('\n');
  hash.update(String(row.album || ''));
  hash.update('\n');
  hash.update(String(row.genre || ''));
  hash.update('\n');
  hash.update(String(row.bpmAnalyzed ?? row.bpm ?? ''));
  hash.update('\n');
  hash.update(String(row.key || ''));
  hash.update('\n');
  hash.update(String(row.length || ''));
  hash.update('\n');
  hash.update(JSON.stringify(cues || []));
  hash.update('\n');
  hash.update(JSON.stringify(loops || []));
  hash.update('\n');
  hash.update(JSON.stringify(crates || []));
  hash.update('\n');
  hash.update(JSON.stringify(playlists || []));
  return hash.digest('hex');
}

function mergeUniqueValues(firstValues, secondValues) {
  const values = [];
  const seen = new Set();

  for (const value of [...firstValues, ...secondValues]) {
    const cleanValue = cleanText(value);
    const key = cleanValue.toLowerCase();

    if (!cleanValue || seen.has(key)) {
      continue;
    }

    seen.add(key);
    values.push(cleanValue);
  }

  return values;
}

function mergePlaylistReferences(firstValues, secondValues) {
  const values = new Map();

  for (const value of [...firstValues, ...secondValues]) {
    const cleanName = cleanText(value?.name || '');

    if (!cleanName) {
      continue;
    }

    const key = cleanName.toLowerCase();
    const existing = values.get(key);
    const nextValue = {
      name: cleanName,
      kind: value?.kind === 'smart' ? 'smart' : 'crate',
      match: value?.match === 'any' ? 'any' : 'all',
      rules: Array.isArray(value?.rules)
        ? value.rules
          .map((rule) => ({
            field: cleanText(rule?.field || ''),
            operator: cleanText(rule?.operator || ''),
            value: cleanText(rule?.value || '')
          }))
          .filter((rule) => rule.field && rule.operator && rule.value)
        : undefined
    };

    if (!existing || (existing.kind === 'crate' && nextValue.kind === 'smart')) {
      values.set(key, nextValue);
    }
  }

  return Array.from(values.values());
}

async function readBasicAudioMetadata(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.mp3') {
    return {};
  }

  let handle;

  try {
    handle = await fs.open(filePath, 'r');
    const header = Buffer.alloc(10);
    const headerRead = await handle.read(header, 0, 10, 0);

    if (headerRead.bytesRead < 10 || header.toString('ascii', 0, 3) !== 'ID3') {
      return {};
    }

    const version = header[3];
    const tagSize = readSyncSafeInteger(header, 6);
    const readSize = Math.min(tagSize, maxId3ReadBytes);
    const payload = Buffer.alloc(readSize);
    await handle.read(payload, 0, readSize, 10);
    return parseId3Frames(payload, version);
  } catch {
    return {};
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

function parseId3Frames(payload, version) {
  const metadata = {};
  let offset = 0;

  while (offset <= payload.length - 10) {
    const frameId = payload.toString('ascii', offset, offset + 4);

    if (!/^[A-Z0-9]{4}$/.test(frameId)) {
      break;
    }

    const frameSize = version === 4 ? readSyncSafeInteger(payload, offset + 4) : payload.readUInt32BE(offset + 4);

    if (frameSize <= 0 || offset + 10 + frameSize > payload.length) {
      break;
    }

    const framePayload = payload.subarray(offset + 10, offset + 10 + frameSize);
    const text = decodeId3TextFrame(framePayload);

    if (frameId === 'TIT2') metadata.title = text;
    if (frameId === 'TPE1') metadata.artist = text;
    if (frameId === 'TALB') metadata.album = text;
    if (frameId === 'TBPM') metadata.bpm = parseNumber(text);
    if (frameId === 'TCON') metadata.genre = text;
    if (frameId === 'TKEY') metadata.musicalKey = text;
    if (frameId === 'GEOB') {
      const geob = parseGeobFrame(framePayload);

      if (geob.description === 'Serato Markers2') {
        metadata.cues = parseSeratoMarkers2(geob.data);
      }
    }

    offset += 10 + frameSize;
  }

  return metadata;
}

async function updateTrackTags(request) {
  if (!request || !Array.isArray(request.tracks) || request.tracks.length === 0 || !request.changes || typeof request.changes !== 'object') {
    throw new Error('Invalid tag update request.');
  }

  const sanitizedChanges = sanitizeTrackTagChanges(request.changes);

  if (Object.keys(sanitizedChanges).length === 0) {
    throw new Error('Keine Tag-Aenderungen uebergeben.');
  }

  const updated = [];
  const skipped = [];
  const warnings = [];

  for (const track of request.tracks) {
    const filePath = typeof track?.sourcePath === 'string' ? track.sourcePath : '';

    if (!filePath) {
      skipped.push({ trackId: String(track?.id || ''), reason: 'Kein lokaler Dateipfad vorhanden.' });
      continue;
    }

    if (path.extname(filePath).toLowerCase() !== '.mp3') {
      skipped.push({ trackId: String(track?.id || ''), reason: 'Nur MP3-Dateien werden aktuell direkt geschrieben.' });
      continue;
    }

    if (!(await pathExists(filePath))) {
      skipped.push({ trackId: String(track?.id || ''), reason: 'Datei nicht gefunden.' });
      continue;
    }

    const nextTrack = applyTrackTagChanges(track, sanitizedChanges);
    const tags = buildNodeId3Tags(nextTrack, sanitizedChanges);

    if (Object.keys(tags).length === 0) {
      skipped.push({ trackId: String(track?.id || ''), reason: 'Keine unterstuetzten ID3-Felder fuer diesen Track.' });
      continue;
    }

    try {
      await NodeID3Promise.update(tags, filePath);
      updated.push({
        trackId: String(track.id || ''),
        title: nextTrack.title,
        artist: nextTrack.artist,
        album: nextTrack.album,
        genre: nextTrack.genre,
        bpm: nextTrack.bpm,
        musicalKey: nextTrack.musicalKey
      });
    } catch (error) {
      skipped.push({ trackId: String(track?.id || ''), reason: error instanceof Error ? error.message : 'Tag-Schreiben fehlgeschlagen.' });
    }
  }

  if (updated.length > 0) {
    warnings.push('MP3-ID3-Tags wurden direkt in die Audiodateien geschrieben. Externe Library-Datenbanken werden dabei nicht automatisch mitgeschrieben.');
  }

  return { updated, skipped, warnings };
}

function sanitizeTrackTagChanges(changes) {
  const nextChanges = {};

  if (typeof changes.title === 'string' && changes.title.trim()) {
    nextChanges.title = cleanText(changes.title);
  }

  if (typeof changes.artist === 'string' && changes.artist.trim()) {
    nextChanges.artist = cleanText(changes.artist);
  }

  if (typeof changes.album === 'string' && changes.album.trim()) {
    nextChanges.album = cleanText(changes.album);
  }

  if (typeof changes.genre === 'string' && changes.genre.trim()) {
    nextChanges.genre = cleanText(changes.genre);
  }

  if (typeof changes.musicalKey === 'string' && changes.musicalKey.trim()) {
    nextChanges.musicalKey = cleanText(changes.musicalKey);
  }

  if (Number.isFinite(changes.bpm)) {
    nextChanges.bpm = Math.max(0, Math.round(Number(changes.bpm)));
  }

  return nextChanges;
}

function applyTrackTagChanges(track, changes) {
  return {
    ...track,
    title: changes.title ?? track.title,
    artist: changes.artist ?? track.artist,
    album: changes.album ?? track.album,
    genre: changes.genre ?? track.genre,
    bpm: changes.bpm ?? track.bpm,
    musicalKey: changes.musicalKey ?? track.musicalKey
  };
}

function buildNodeId3Tags(track, changes) {
  const tags = {};

  if (Object.prototype.hasOwnProperty.call(changes, 'title')) {
    tags.title = track.title || '';
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'artist')) {
    tags.artist = track.artist || '';
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'album')) {
    tags.album = track.album || '';
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'genre')) {
    tags.genre = track.genre || '';
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'bpm')) {
    tags.bpm = Number.isFinite(track.bpm) ? String(Math.round(track.bpm)) : '';
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'musicalKey')) {
    tags.initialKey = track.musicalKey || '';
  }

  return tags;
}

async function readCoverArt(filePath) {
  if (typeof filePath !== 'string' || !(await pathExists(filePath))) {
    return '';
  }

  let handle;

  try {
    handle = await fs.open(filePath, 'r');
    const header = Buffer.alloc(10);
    const headerRead = await handle.read(header, 0, 10, 0);

    if (headerRead.bytesRead < 10 || header.toString('ascii', 0, 3) !== 'ID3') {
      return '';
    }

    const version = header[3];
    const tagSize = readSyncSafeInteger(header, 6);
    const readSize = Math.min(tagSize, maxId3ReadBytes);
    const payload = Buffer.alloc(readSize);
    await handle.read(payload, 0, readSize, 10);
    return readCoverArtFromId3(payload, version);
  } catch {
    return '';
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

function readCoverArtFromId3(payload, version) {
  if (version === 2) {
    return readCoverArtFromId3v22(payload);
  }

  let offset = 0;

  while (offset <= payload.length - 10) {
    const frameId = payload.toString('ascii', offset, offset + 4);

    if (!/^[A-Z0-9]{4}$/.test(frameId)) {
      break;
    }

    const frameSize = version === 4 ? readSyncSafeInteger(payload, offset + 4) : payload.readUInt32BE(offset + 4);

    if (frameSize <= 0 || offset + 10 + frameSize > payload.length) {
      break;
    }

    if (frameId === 'APIC') {
      return parseApicFrame(payload.subarray(offset + 10, offset + 10 + frameSize));
    }

    offset += 10 + frameSize;
  }

  return '';
}

function readCoverArtFromId3v22(payload) {
  let offset = 0;

  while (offset <= payload.length - 6) {
    const frameId = payload.toString('ascii', offset, offset + 3);

    if (!/^[A-Z0-9]{3}$/.test(frameId)) {
      break;
    }

    const frameSize = payload.readUIntBE(offset + 3, 3);

    if (frameSize <= 0 || offset + 6 + frameSize > payload.length) {
      break;
    }

    if (frameId === 'PIC') {
      return parsePicFrame(payload.subarray(offset + 6, offset + 6 + frameSize));
    }

    offset += 6 + frameSize;
  }

  return '';
}

function parseApicFrame(payload) {
  if (payload.length < 5) {
    return '';
  }

  const encoding = payload[0];
  let offset = 1;
  const mimeEnd = payload.indexOf(0, offset);

  if (mimeEnd === -1) {
    return '';
  }

  const mimeType = normalizeImageMimeType(payload.toString('latin1', offset, mimeEnd));
  offset = mimeEnd + 1;

  if (offset >= payload.length) {
    return '';
  }

  return createPictureDataUrl(payload, offset + 1, encoding, mimeType);
}

function parsePicFrame(payload) {
  if (payload.length < 6) {
    return '';
  }

  const encoding = payload[0];
  const imageFormat = payload.toString('latin1', 1, 4).toLowerCase();
  const mimeType = normalizeImageMimeType(imageFormat === 'jpg' ? 'jpeg' : imageFormat);

  return createPictureDataUrl(payload, 5, encoding, mimeType);
}

function createPictureDataUrl(payload, descriptionStart, encoding, declaredMimeType) {
  const terminatorLength = getId3TerminatorLength(encoding);
  const descriptionEnd = findId3StringTerminator(payload, descriptionStart, encoding);
  let imageStart = descriptionEnd === -1
    ? findImageSignature(payload, descriptionStart)
    : descriptionEnd + terminatorLength;

  if (imageStart === -1 || imageStart >= payload.length) {
    return '';
  }

  const nearbySignatureStart = findImageSignature(payload, imageStart);

  if (nearbySignatureStart !== -1 && nearbySignatureStart - imageStart <= 4) {
    imageStart = nearbySignatureStart;
  }

  const imageData = payload.subarray(imageStart);
  const mimeType = detectImageMimeType(imageData) || declaredMimeType;

  if (!mimeType || !detectImageMimeType(imageData)) {
    return '';
  }

  return `data:${mimeType};base64,${imageData.toString('base64')}`;
}

function getId3TerminatorLength(encoding) {
  return encoding === 1 || encoding === 2 ? 2 : 1;
}

function findId3StringTerminator(buffer, start, encoding) {
  if (getId3TerminatorLength(encoding) === 1) {
    return buffer.indexOf(0, start);
  }

  for (let index = start; index < buffer.length - 1; index += 1) {
    if (buffer[index] === 0 && buffer[index + 1] === 0) {
      return index;
    }
  }

  return -1;
}

function findImageSignature(buffer, start) {
  for (let index = Math.max(0, start); index < buffer.length - 11; index += 1) {
    if (detectImageMimeType(buffer.subarray(index, index + 12))) {
      return index;
    }
  }

  return -1;
}

function detectImageMimeType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return 'image/png';
  }

  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }

  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  return '';
}

function normalizeImageMimeType(value) {
  const normalized = cleanText(value).toLowerCase();

  if (!normalized || normalized === 'jpeg' || normalized === 'jpg' || normalized === 'image/jpg') {
    return 'image/jpeg';
  }

  if (normalized === 'png') return 'image/png';
  if (normalized === 'gif') return 'image/gif';
  if (normalized === 'webp') return 'image/webp';

  return normalized.startsWith('image/') ? normalized : '';
}

function parseGeobFrame(payload) {
  if (payload.length === 0) {
    return { description: '', data: Buffer.alloc(0) };
  }

  let offset = 1;
  const readLatinString = () => {
    const start = offset;

    while (offset < payload.length && payload[offset] !== 0) {
      offset += 1;
    }

    const value = payload.toString('latin1', start, offset);
    offset += 1;
    return value;
  };

  readLatinString();
  readLatinString();
  const description = readLatinString();

  return { description, data: payload.subarray(offset) };
}

function parseSeratoMarkers2(data) {
  const base64Payload = data
    .subarray(data[0] === 1 && data[1] === 1 ? 2 : 0)
    .toString('ascii')
    .replace(/[^A-Za-z0-9+/=]/g, '');

  if (!base64Payload) {
    return [];
  }

  let decoded;

  try {
    decoded = Buffer.from(base64Payload, 'base64');
  } catch {
    return [];
  }

  const cues = [];
  let offset = 0;

  while (offset < decoded.length) {
    const cueOffset = decoded.indexOf(Buffer.from('CUE\0'), offset);

    if (cueOffset === -1 || cueOffset + 8 > decoded.length) {
      break;
    }

    const payloadLength = decoded.readUInt32BE(cueOffset + 4);
    const payloadStart = cueOffset + 8;
    const payloadEnd = payloadStart + payloadLength;

    if (payloadLength <= 0 || payloadEnd > decoded.length) {
      offset = cueOffset + 4;
      continue;
    }

    const payload = decoded.subarray(payloadStart, payloadEnd);
    const positionMs = payload.length >= 6 ? payload.readUInt32BE(2) : 0;
    const cueIndex = payload.length >= 2 ? payload[1] : cues.length;
    const label = cleanText(payload.length > 12 ? payload.subarray(12).toString('utf8') : '') || `Cue ${cueIndex + 1}`;
    const color = payload.length >= 9
      ? `#${payload[6].toString(16).padStart(2, '0')}${payload[7].toString(16).padStart(2, '0')}${payload[8].toString(16).padStart(2, '0')}`
      : '#4a72ff';

    cues.push({
      id: `serato-cue-${cueIndex}-${positionMs}`,
      label,
      positionMs,
      color
    });

    offset = payloadEnd;
  }

  return cues;
}

function decodeId3TextFrame(payload) {
  if (payload.length === 0) {
    return '';
  }

  const encoding = payload[0];
  const value = payload.subarray(1);

  if (encoding === 0) return cleanText(value.toString('latin1'));
  if (encoding === 2) return cleanText(decodeUtf16Be(value));
  if (encoding === 3) return cleanText(value.toString('utf8'));

  if (value[0] === 0xfe && value[1] === 0xff) return cleanText(decodeUtf16Be(value.subarray(2)));
  if (value[0] === 0xff && value[1] === 0xfe) return cleanText(value.subarray(2).toString('utf16le'));

  return cleanText(value.toString('utf16le'));
}

async function collectFiles(rootPath, format, options) {
  const audioFiles = [];
  const markerFiles = [];
  const markers = new Set();
  const warnings = [];
  let scannedFiles = 0;
  let truncated = false;

  async function walk(currentPath, depth) {
    if (truncated || depth > maxScanDepth) {
      truncated = true;
      return;
    }

    let entries;

    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Ordner nicht lesbar: ${currentPath}`);
      return;
    }

    for (const entry of entries) {
      if (scannedFiles >= maxScanFiles) {
        truncated = true;
        return;
      }

      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          await walk(fullPath, depth + 1);
        }

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      scannedFiles += 1;

      const markerLabels = getMarkerLabels(fullPath, format);

      if (markerLabels.length > 0) {
        markerFiles.push(fullPath);
        markerLabels.forEach((label) => markers.add(label));
      }

      if (!isAudioFile(fullPath)) {
        continue;
      }

      if (!options.includeStats) {
        audioFiles.push({ path: fullPath });
        continue;
      }

      try {
        const stats = await fs.stat(fullPath);
        audioFiles.push({
          path: fullPath,
          size: stats.size,
          modifiedAt: stats.mtimeMs
        });
      } catch {
        warnings.push(`Audiodatei nicht lesbar: ${fullPath}`);
      }
    }
  }

  await walk(rootPath, 0);

  return {
    audioFiles,
    markerFiles,
    markers,
    warnings,
    scannedFiles,
    truncated
  };
}

function shouldSkipDirectory(directoryName) {
  const lower = directoryName.toLowerCase();
  return lower === 'node_modules' || lower === '$recycle.bin' || lower === 'system volume information' || lower === 'djoo backups';
}

function getMarkerLabels(filePath, format) {
  const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
  const basename = path.basename(filePath).toLowerCase();
  const labels = [];

  if (format === 'serato') {
    if (basename === 'database' || basename === 'database v2') labels.push('Serato database');
    if (basename.endsWith('.crate')) labels.push('Serato crate');
  }

  if (format === 'engine') {
    if (normalizedPath.includes('engine library')) labels.push('Engine Library folder');
    if (basename.endsWith('.db') || basename.endsWith('.m.db')) labels.push('Engine database');
    if (normalizedPath.includes('database2')) labels.push('Engine export data');
  }

  if (format === 'traktor') {
    if (basename.endsWith('.nml')) labels.push('Traktor NML collection');
    if (normalizedPath.includes('native instruments/traktor')) labels.push('Traktor settings folder');
  }

  return labels;
}

function isAudioFile(filePath) {
  return audioExtensions.has(path.extname(filePath).toLowerCase());
}

function normalizeSeratoPath(seratoPath) {
  const cleanPath = cleanText(seratoPath).replace(/\//g, path.sep);

  if (process.platform === 'win32') {
    if (/^[A-Za-z]:[\\/]/.test(cleanPath)) {
      return path.normalize(cleanPath);
    }

    if (/^Users[\\/]/i.test(cleanPath)) {
      const driveRoot = path.parse(os.homedir()).root || 'C:\\';
      return path.normalize(path.join(driveRoot, cleanPath));
    }
  }

  return path.normalize(cleanPath);
}

function normalizeComparablePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^file:\/\//i, '').toLowerCase();
}

function decodeUtf16Be(buffer) {
  const swapped = Buffer.alloc(buffer.length);

  for (let index = 0; index < buffer.length - 1; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }

  return cleanText(swapped.toString('utf16le'));
}

function cleanText(value) {
  return String(value || '').replace(/\0/g, '').trim();
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSeratoDuration(value) {
  const cleanValue = cleanText(value);
  const parts = cleanValue.split(':').map((part) => Number(part));

  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) {
    return undefined;
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return parts[0] * 60 + parts[1];
}

function readSyncSafeInteger(buffer, offset) {
  return ((buffer[offset] & 0x7f) << 21)
    | ((buffer[offset + 1] & 0x7f) << 14)
    | ((buffer[offset + 2] & 0x7f) << 7)
    | (buffer[offset + 3] & 0x7f);
}

function parseTrackName(fileName) {
  const cleanName = fileName.replace(/\.[^/.]+$/, '').replace(/_/g, ' ').trim();
  const parts = cleanName.split(' - ').map((part) => part.trim()).filter(Boolean);

  if (parts.length >= 2) {
    return {
      artist: parts[0],
      title: parts.slice(1).join(' - '),
      genre: undefined
    };
  }

  return {
    artist: 'Unknown Artist',
    title: cleanName || fileName,
    genre: undefined
  };
}

function createId(seed) {
  const hash = Array.from(seed).reduce((accumulator, character) => {
    return Math.imul(31, accumulator) + character.charCodeAt(0) | 0;
  }, 0);

  return `native-${Math.abs(hash).toString(36)}`;
}

function getFormatLabel(format) {
  if (format === 'serato') return 'Serato';
  if (format === 'engine') return 'Engine DJ';
  return 'Traktor';
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function computeLibraryFingerprint(format, rootPath) {
  const hash = createHash('sha1');
  hash.update(String(format || 'unknown'));
  hash.update('\n');
  hash.update(String(rootPath || ''));
  hash.update('\n');

  if (format === 'engine') {
    await appendFileFingerprint(hash, path.join(rootPath, 'Database2', 'm.db'));
    return hash.digest('hex');
  }

  if (format === 'serato') {
    await appendFileFingerprint(hash, path.join(rootPath, 'database V2'));
    await appendFileFingerprint(hash, path.join(rootPath, 'neworder.pref'));
    await appendDirectoryFingerprint(hash, path.join(rootPath, 'Subcrates'), new Set(['.crate']));
    await appendDirectoryFingerprint(hash, path.join(rootPath, 'SmartCrates'), new Set(['.crate', '.scrate']));
    return hash.digest('hex');
  }

  if (format === 'traktor') {
    const collectionPath = await findTraktorCollectionPath(rootPath);

    if (collectionPath) {
      await appendFileFingerprint(hash, collectionPath);
    } else {
      await appendFileFingerprint(hash, rootPath);
    }

    return hash.digest('hex');
  }

  await appendFileFingerprint(hash, rootPath);
  return hash.digest('hex');
}

async function appendFileFingerprint(hash, filePath) {
  try {
    const stats = await fs.stat(filePath);
    hash.update(filePath.toLowerCase());
    hash.update(`:${stats.isDirectory() ? 'dir' : 'file'}:${stats.size}:${Math.round(stats.mtimeMs)}`);
    hash.update('\n');
  } catch {
    hash.update(filePath.toLowerCase());
    hash.update(':missing\n');
  }
}

async function appendDirectoryFingerprint(hash, directoryPath, allowedExtensions, depth = 0) {
  if (depth > 8) {
    return;
  }

  let entries;

  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    hash.update(`${directoryPath.toLowerCase()}:missing\n`);
    return;
  }

  const sortedEntries = [...entries].sort((first, second) => first.name.localeCompare(second.name));

  for (const entry of sortedEntries) {
    const fullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      await appendDirectoryFingerprint(hash, fullPath, allowedExtensions, depth + 1);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (allowedExtensions && allowedExtensions.size > 0 && !allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }

    await appendFileFingerprint(hash, fullPath);
  }
}

async function findTraktorCollectionPath(rootPath) {
  const directCandidates = [
    path.join(rootPath, 'collection.nml'),
    path.join(rootPath, 'Traktor 3', 'collection.nml'),
    path.join(rootPath, 'Traktor Pro 3', 'collection.nml')
  ];

  for (const candidate of directCandidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return findFileByName(rootPath, 'collection.nml', 3);
}

async function findFileByName(rootPath, fileName, maxDepth, depth = 0) {
  if (depth > maxDepth) {
    return '';
  }

  let entries;

  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch {
    return '';
  }

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);

    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return fullPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) {
      continue;
    }

    const match = await findFileByName(path.join(rootPath, entry.name), fileName, maxDepth, depth + 1);

    if (match) {
      return match;
    }
  }

  return '';
}

async function loadLibraryState() {
  try {
    const raw = await fs.readFile(getLibraryStatePath(), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function saveLibraryState(state) {
  const targetPath = getLibraryStatePath();
  const tempPath = `${targetPath}.tmp`;
  const safeState = {
    version: 1,
    savedAt: new Date().toISOString(),
    tracks: Array.isArray(state?.tracks) ? state.tracks : [],
    reports: Array.isArray(state?.reports) ? state.reports : [],
    previewUrls: state?.previewUrls && typeof state.previewUrls === 'object' ? state.previewUrls : {}
  };

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(safeState, null, 2), 'utf8');
  await fs.rename(tempPath, targetPath);
  return { savedAt: safeState.savedAt, path: targetPath };
}

async function suggestPathFixes(tracks) {
  if (!Array.isArray(tracks)) {
    return [];
  }

  const suggestions = [];
  const currentUser = os.userInfo().username;

  for (const track of tracks) {
    const currentPath = typeof track?.sourcePath === 'string' ? track.sourcePath : '';

    if (!currentPath || await pathExists(currentPath)) {
      continue;
    }

    const candidates = buildPathFixCandidates(currentPath, currentUser);

    for (const candidate of candidates) {
      if (await pathExists(candidate.path)) {
        suggestions.push({
          trackId: track.id,
          title: track.title || path.basename(currentPath),
          artist: track.artist || 'Unknown Artist',
          currentPath,
          suggestedPath: candidate.path,
          reason: candidate.reason,
          confidence: candidate.confidence
        });
        break;
      }
    }
  }

  return suggestions.sort((first, second) => second.confidence - first.confidence);
}

async function relocateTrackFile(track) {
  if (!track || typeof track.id !== 'string') {
    throw new Error('Invalid track for relocate.');
  }

  const previousPath = typeof track.sourcePath === 'string' ? track.sourcePath : '';
  const defaultPath = getRelocateDefaultPath(previousPath);
  const result = await dialog.showOpenDialog({
    title: 'Audiodatei relocaten',
    defaultPath,
    properties: ['openFile'],
    filters: [
      { name: 'Audiodateien', extensions: Array.from(audioExtensions).map((extension) => extension.slice(1)) },
      { name: 'Alle Dateien', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0];

  if (!(await pathExists(selectedPath))) {
    throw new Error(`Ausgewaehlte Datei nicht gefunden: ${selectedPath}`);
  }

  if (!isAudioFile(selectedPath)) {
    throw new Error('Die ausgewaehlte Datei ist keine unterstuetzte Audiodatei.');
  }

  return {
    trackId: track.id,
    title: track.title || path.basename(selectedPath),
    artist: track.artist || 'Unknown Artist',
    previousPath,
    selectedPath
  };
}

async function relocateMissingTracks(tracks) {
  if (!Array.isArray(tracks)) {
    throw new Error('Invalid track list for bulk relocate.');
  }

  const missingTracks = tracks.filter((track) => track?.status === 'missing-file' && typeof track.sourcePath === 'string');

  if (missingTracks.length === 0) {
    return { rootPath: '', relocated: [], unmatched: [] };
  }

  const result = await dialog.showOpenDialog({
    title: 'Ueberordner fuer Missing Files waehlen',
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const rootPath = result.filePaths[0];
  const relocateScan = await collectAudioFilesForRelocate(rootPath);
  const audioFiles = relocateScan.audioFiles;
  const audioByFileName = createAudioPathIndex(audioFiles);
  const relocated = [];
  const unmatched = [];

  for (const track of missingTracks) {
    const candidates = getRelocateCandidates(track, audioByFileName);
    const selectedPath = chooseBestRelocateCandidate(track, candidates);

    if (!selectedPath) {
      unmatched.push({
        trackId: track.id,
        title: track.title || path.basename(track.sourcePath),
        artist: track.artist || 'Unknown Artist',
        previousPath: track.sourcePath
      });
      continue;
    }

    relocated.push({
      trackId: track.id,
      title: track.title || path.basename(selectedPath),
      artist: track.artist || 'Unknown Artist',
      previousPath: track.sourcePath,
      selectedPath
    });
  }

  return {
    rootPath,
    scannedFiles: relocateScan.scannedFiles,
    audioFiles: audioFiles.length,
    truncated: relocateScan.truncated,
    relocated,
    unmatched
  };
}

async function collectAudioFilesForRelocate(rootPath) {
  const audioFiles = [];
  let scannedFiles = 0;
  let truncated = false;

  async function walk(currentPath, depth) {
    if (depth > maxRelocateScanDepth || scannedFiles >= maxRelocateScanFiles) {
      truncated = true;
      return;
    }

    let entries;

    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scannedFiles >= maxRelocateScanFiles) {
        truncated = true;
        return;
      }

      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) {
          await walk(fullPath, depth + 1);
        }

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      scannedFiles += 1;

      if (isAudioFile(fullPath)) {
        audioFiles.push(fullPath);
      }
    }
  }

  await walk(rootPath, 0);
  return { audioFiles, scannedFiles, truncated };
}

function createAudioPathIndex(audioFiles) {
  const index = {
    byFileName: new Map(),
    byStem: new Map(),
    all: audioFiles
  };

  for (const filePath of audioFiles) {
    const fileName = path.basename(filePath).toLowerCase();
    const stem = normalizeRelocateText(path.basename(filePath, path.extname(filePath)));
    const fileNameMatches = index.byFileName.get(fileName) || [];
    const stemMatches = index.byStem.get(stem) || [];
    fileNameMatches.push(filePath);
    stemMatches.push(filePath);
    index.byFileName.set(fileName, fileNameMatches);
    index.byStem.set(stem, stemMatches);
  }

  return index;
}

function getRelocateCandidates(track, audioIndex) {
  const candidates = new Set();
  const previousPath = typeof track.sourcePath === 'string' ? track.sourcePath : '';
  const expectedFileName = path.basename(previousPath).toLowerCase();
  const expectedStem = normalizeRelocateText(path.basename(previousPath, path.extname(previousPath)));
  const titleStem = normalizeRelocateText(track.title || '');

  for (const candidate of audioIndex.byFileName.get(expectedFileName) || []) {
    candidates.add(candidate);
  }

  for (const candidate of audioIndex.byStem.get(expectedStem) || []) {
    candidates.add(candidate);
  }

  if (candidates.size === 0 && titleStem.length >= 8) {
    for (const filePath of audioIndex.all) {
      const candidateStem = normalizeRelocateText(path.basename(filePath, path.extname(filePath)));

      if (candidateStem.includes(titleStem) || titleStem.includes(candidateStem)) {
        candidates.add(filePath);
      }
    }
  }

  return Array.from(candidates);
}

function chooseBestRelocateCandidate(track, candidates) {
  if (candidates.length === 0) {
    return '';
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  const artist = normalizeRelocateText(track.artist || '');
  const title = normalizeRelocateText(track.title || '');
  const previousPath = normalizeComparablePath(track.sourcePath || '');
  const previousFileName = path.basename(track.sourcePath || '').toLowerCase();

  return candidates
    .map((candidate) => ({
      candidate,
      score: (path.basename(candidate).toLowerCase() === previousFileName ? 8 : 0)
        + (previousPath && normalizeComparablePath(candidate).endsWith(previousPath.split('/').slice(-3).join('/')) ? 4 : 0)
        + (artist && normalizeRelocateText(candidate).includes(artist) ? 2 : 0)
        + (title && normalizeRelocateText(candidate).includes(title) ? 2 : 0)
    }))
    .sort((first, second) => second.score - first.score)[0].candidate;
}

function normalizeRelocateText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getRelocateDefaultPath(previousPath) {
  if (previousPath) {
    const directoryPath = path.dirname(previousPath);

    if (safeExists(directoryPath)) {
      return directoryPath;
    }
  }

  const musicPath = path.join(os.homedir(), 'Music');
  return safeExists(musicPath) ? musicPath : os.homedir();
}

function buildPathFixCandidates(currentPath, currentUser) {
  const candidates = [];
  const normalized = path.normalize(currentPath);
  const userSegmentMatch = normalized.match(/([A-Za-z]:\\Users\\)([^\\]+)(\\.*)$/i);

  if (userSegmentMatch && userSegmentMatch[2].toLowerCase() !== currentUser.toLowerCase()) {
    candidates.push({
      path: path.normalize(`${userSegmentMatch[1]}${currentUser}${userSegmentMatch[3]}`),
      reason: `Windows-Userpfad von ${userSegmentMatch[2]} auf ${currentUser} umgebogen`,
      confidence: 96
    });
  }

  const home = os.homedir();
  const basename = path.basename(normalized);

  if (basename) {
    candidates.push(
      { path: path.join(home, 'Music', basename), reason: 'Gleicher Dateiname im aktuellen Music-Ordner', confidence: 64 },
      { path: path.join(home, 'OneDrive', basename), reason: 'Gleicher Dateiname im aktuellen OneDrive-Ordner', confidence: 60 }
    );
  }

  return candidates;
}

async function commitSync(request) {
  if (!request || !importFormats.has(request.targetFormat) || typeof request.targetPath !== 'string') {
    throw new Error('Invalid sync commit request.');
  }

  if (!(await pathExists(request.targetPath))) {
    throw new Error(`Sync target not found: ${request.targetPath}`);
  }

  const replaceTargetLibrary = request.targetFormat === 'serato' && request.replaceTargetLibrary === true;

  if (replaceTargetLibrary && request.confirmedReplaceTarget !== true) {
    throw new Error('Serato Replace-Sync wurde nicht bestaetigt. Ziel-Library wurde nicht veraendert.');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(request.targetPath, 'Djoo Backups', `djoo-backup-${timestamp}`);
  const sourceTracks = Array.isArray(request.tracks) ? request.tracks.filter((track) => track && typeof track.sourcePath === 'string') : [];
  const exportedFiles = [];
  const warnings = [];

  await fs.mkdir(backupPath, { recursive: true });

  const backedUpFiles = request.targetFormat === 'serato'
    ? await backupSeratoTarget(request.targetPath, backupPath)
    : await backupMarkerFiles(request.targetPath, request.targetFormat, backupPath);

  if (request.targetFormat === 'serato' && sourceTracks.length > 0) {
    const playlistReferences = Array.isArray(request.playlistReferences) ? request.playlistReferences : [];
    const seratoExport = replaceTargetLibrary
      ? await writeSeratoReplacementLibrary(request.targetPath, sourceTracks, timestamp, request.playlistNames || [], playlistReferences)
      : request.updateTargetPlaylists === true
        ? await writeSeratoPlaylistUpdate(request.targetPath, sourceTracks, request.playlistNames || [], timestamp, playlistReferences)
        : await writeSeratoSyncExport(request.targetPath, sourceTracks, timestamp);
    exportedFiles.push(...seratoExport.exportedFiles);
    warnings.push(...seratoExport.warnings);

    if (seratoExport.exportedFiles.length > 0) {
      const serato4Refresh = await refreshSerato4LegacyImportState(request.targetPath, backupPath, seratoExport.crateHierarchy || [], seratoExport.smartCrates || []);
      exportedFiles.push(...serato4Refresh.exportedFiles);
      warnings.push(...serato4Refresh.warnings);
    }
  } else if (sourceTracks.length === 0) {
    warnings.push('Keine Quelltracks im Sync-Request. Es wurde nur ein Backup/Manifest erstellt.');
  } else {
    warnings.push(`${getFormatLabel(request.targetFormat)} Writeback ist noch nicht aktiv. Es wurde nur ein Backup/Manifest erstellt.`);
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceFormat: request.sourceFormat,
    targetFormat: request.targetFormat,
    targetPath: request.targetPath,
    trackCount: request.trackCount,
    addCount: request.addCount,
    keepCount: request.keepCount,
    removeCandidateCount: request.removeCandidateCount,
    backedUpFiles,
    exportedFiles,
    committed: exportedFiles.length > 0,
    replacedTargetLibrary: replaceTargetLibrary && exportedFiles.length > 0,
    note: exportedFiles.length > 0
      ? replaceTargetLibrary
        ? 'Serato library replaced from the selected source. Cue/loop details are preserved in the Djoo manifest; direct Serato Markers2 ID3 writeback is intentionally not performed yet.'
        : 'Serato crate export written. Cue/loop details are preserved in the Djoo manifest; direct Serato Markers2 ID3 writeback is intentionally not performed yet.'
      : 'Backup and dry-run manifest created. Vendor writeback for this target is not active yet.'
  };
  const manifestPath = path.join(backupPath, 'djoo-sync-manifest.json');

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    backupPath,
    manifestPath,
    committed: exportedFiles.length > 0,
    exportedFiles,
    replacedTargetLibrary: replaceTargetLibrary && exportedFiles.length > 0,
    warnings: exportedFiles.length > 0
      ? ['Backup wurde erstellt.', ...warnings]
      : ['Backup wurde erstellt. Writeback in das Zielsystem ist fuer dieses Ziel noch gesperrt.', ...warnings]
  };
}

async function backupMarkerFiles(targetPath, targetFormat, backupPath) {
  const collected = await collectFiles(targetPath, targetFormat, { includeStats: false });
  const filesToBackup = collected.markerFiles.length > 0 ? collected.markerFiles : [];

  for (const filePath of filesToBackup) {
    const relativePath = path.relative(targetPath, filePath);
    const destinationPath = path.join(backupPath, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(filePath, destinationPath);
  }

  return filesToBackup.length;
}

async function backupSeratoTarget(targetPath, backupPath) {
  const filesToBackup = [];

  async function walk(currentPath) {
    let entries;

    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(targetPath, fullPath);
      const normalizedRelativePath = relativePath.replace(/\\/g, '/').toLowerCase();

      if (!relativePath || normalizedRelativePath.startsWith('..') || normalizedRelativePath === 'djoo backups' || normalizedRelativePath.startsWith('djoo backups/')) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile()) {
        filesToBackup.push(fullPath);
      }
    }
  }

  await walk(targetPath);

  for (const filePath of filesToBackup) {
    const relativePath = path.relative(targetPath, filePath);
    const destinationPath = path.join(backupPath, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(filePath, destinationPath);
  }

  return filesToBackup.length;
}

async function refreshSerato4LegacyImportState(targetPath, backupPath, crateHierarchy = [], smartCrates = []) {
  const exportedFiles = [];
  const warnings = [];
  const libraryPath = getSerato4LibraryPath();

  if (!libraryPath) {
    return { exportedFiles, warnings };
  }

  const SQL = await getSqlModule();
  const rootDatabasePath = path.join(libraryPath, 'root.sqlite');
  const masterDatabasePath = path.join(libraryPath, 'master.sqlite');
  const rootRefresh = await refreshSerato4SqliteDatabase({
    SQL,
    databasePath: rootDatabasePath,
    backupPath,
    backupName: 'root.sqlite',
    targetPath,
    resetLegacyImport: true,
    crateHierarchy,
    smartCrates
  });
  const masterRefresh = await refreshSerato4SqliteDatabase({
    SQL,
    databasePath: masterDatabasePath,
    backupPath,
    backupName: 'master.sqlite',
    targetPath,
    resetLegacyImport: false,
    crateHierarchy,
    smartCrates
  });

  exportedFiles.push(...rootRefresh.exportedFiles, ...masterRefresh.exportedFiles);
  warnings.push(...rootRefresh.warnings, ...masterRefresh.warnings);

  if (rootRefresh.refreshed) {
    warnings.push('Serato DJ Lite 4 Import-State wurde aktualisiert: Serato liest beim naechsten Start database V2, neworder.pref und Subcrates neu in den SQLite-Index ein.');
  }

  return { exportedFiles, warnings };
}

async function refreshSerato4SqliteDatabase({ SQL, databasePath, backupPath, backupName, targetPath, resetLegacyImport, crateHierarchy = [], smartCrates = [] }) {
  const exportedFiles = [];
  const warnings = [];

  if (!(await pathExists(databasePath))) {
    return { exportedFiles, warnings, refreshed: false };
  }

  const activeSidecars = ['-wal', '-shm']
    .map((suffix) => `${databasePath}${suffix}`)
    .filter((sidecarPath) => safeExists(sidecarPath));

  if (activeSidecars.length > 0) {
    warnings.push(`Serato DJ Lite 4 Index ${backupName} wurde nicht angefasst, weil aktive SQLite-Sidecar-Dateien existieren. Bitte Serato schliessen und den Sync erneut ausfuehren.`);
    return { exportedFiles, warnings, refreshed: false };
  }

  let database;

  try {
    await backupSerato4Database(databasePath, backupPath, backupName);
    database = new SQL.Database(await fs.readFile(databasePath));
    const tables = new Set(executeSqlRows(database, "SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
    let changed = false;

    if (tables.has('asset')) {
      changed = patchSerato4PortableIds(database, targetPath) || changed;
    }

    if (tables.has('container') && crateHierarchy.length > 0) {
      changed = patchSerato4ContainerHierarchy(database, crateHierarchy, { executeSqlRows, normalizePlaylistName, smartCrates }) || changed;
    }

    if (resetLegacyImport) {
      if (!tables.has('dbv2_status') && !tables.has('last_seen_dbv2_library')) {
        warnings.push('Serato 4 Index wurde gefunden, enthaelt aber keine kompatiblen DBV2-Importtabellen. Legacy-Reimport wurde uebersprungen.');
      }

      if (tables.has('last_seen_dbv2_library')) {
        database.run('DELETE FROM last_seen_dbv2_library');
        changed = true;
      }

      if (tables.has('dbv2_status')) {
        const rows = executeSqlRows(database, 'SELECT COUNT(*) AS count FROM dbv2_status');
        const hasStatusRow = Number(rows[0]?.count || 0) > 0;

        if (hasStatusRow) {
          database.run('UPDATE dbv2_status SET autosync_disabled = 0, last_import_time = 0');
        } else {
          database.run('INSERT INTO dbv2_status (last_import_revision, last_import_time, last_export_revision, last_export_time, migrate_old_smart_crate, autosync_disabled) VALUES (0, 0, 0, 0, 0, 0)');
        }

        changed = true;
      }
    }

    if (changed) {
      await fs.writeFile(databasePath, Buffer.from(database.export()));
      exportedFiles.push(databasePath);
    }

    return { exportedFiles, warnings, refreshed: changed };
  } catch (error) {
    warnings.push(`Serato DJ Lite 4 Index ${backupName} konnte nicht vorbereitet werden: ${error.message}`);
    return { exportedFiles, warnings, refreshed: false };
  } finally {
    if (database) {
      database.close();
    }
  }
}

function patchSerato4PortableIds(database, targetPath) {
  const rows = executeSqlRows(database, `
    SELECT id, portable_id
    FROM asset
    WHERE portable_id LIKE 'C:%'
      OR portable_id LIKE 'D:%'
      OR portable_id LIKE 'E:%'
      OR portable_id LIKE 'F:%'
      OR portable_id LIKE 'G:%'
      OR portable_id LIKE 'H:%'
      OR portable_id LIKE '%C:/C:/%'
      OR portable_id LIKE '%C:\\C:\\%'
  `);
  let changed = false;

  for (const row of rows) {
    const nextPath = formatSeratoExportPath(row.portable_id, targetPath);

    if (nextPath && nextPath !== row.portable_id) {
      database.run('UPDATE asset SET portable_id = ? WHERE id = ?', [nextPath, row.id]);
      changed = true;
    }
  }

  return changed;
}

function getSerato4LibraryPath() {
  const candidates = [];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'Serato', 'Library'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Serato', 'Library'));
  } else {
    candidates.push(path.join(os.homedir(), '.local', 'share', 'Serato', 'Library'));
  }

  return candidates.find((candidate) => safeExists(candidate));
}

async function backupSerato4Database(databasePath, backupPath, backupName) {
  const destinationPath = path.join(backupPath, 'Serato 4 Library', backupName);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(databasePath, destinationPath);
}

async function writeSeratoReplacementLibrary(targetPath, tracks, timestamp, playlistNames = [], playlistReferences = []) {
  const subcratesPath = path.join(targetPath, 'Subcrates');
  const djooExportPath = path.join(targetPath, 'Djoo Sync');
  const exportedFiles = [];
  const warnings = [];
  const usableTracks = dedupeSeratoExportTracks(tracks.filter((track) => track.sourcePath && isAudioFile(track.sourcePath)));

  if (usableTracks.length === 0) {
    throw new Error('Serato Replace-Sync abgebrochen: keine nutzbaren Quelltracks mit Audiodatei-Pfad.');
  }

  await removeExistingSeratoLibrary(targetPath);
  await fs.mkdir(subcratesPath, { recursive: true });
  await fs.mkdir(djooExportPath, { recursive: true });

  const databasePath = path.join(targetPath, 'database V2');
  await fs.writeFile(databasePath, buildSeratoDatabaseBuffer(usableTracks, targetPath));
  exportedFiles.push(databasePath);

  const crateState = createSyncCrateGroups(usableTracks, playlistNames, playlistReferences, { cleanText, normalizePlaylistName, sanitizeFileName });
  const usedCrateFileNames = new Set();
  const crateFileNames = [];
  const crateFileNameByName = new Map();

  for (const [crateName, crateTracks] of crateState.groups) {
    const crateFileName = createUniqueSeratoCrateFileName(crateName, usedCrateFileNames);
    const cratePath = path.join(subcratesPath, `${crateFileName}.crate`);
    await fs.writeFile(cratePath, buildSeratoCrateBuffer(crateTracks, targetPath));
    crateFileNameByName.set(crateName, crateFileName);
    crateFileNames.push(crateFileName);
    exportedFiles.push(cratePath);
  }

  exportedFiles.push(await writeSeratoNewOrder(targetPath, crateFileNames));

  exportedFiles.push(await writeSeratoCueManifest(djooExportPath, usableTracks, timestamp));
  warnings.push(`Serato Library wurde komplett ersetzt: ${usableTracks.length} Tracks, ${crateState.groups.size} Crates${crateState.smartGroups.length > 0 ? ` und ${crateState.smartGroups.length} Smart Crates` : ''}, database V2 und Sidebar-Reihenfolge neu geschrieben.`);
  warnings.push('Cues und Loops wurden im Djoo Sync Manifest gesichert und beim direkten Re-Import wieder mit den Serato-Eintraegen verbunden. Direkter Serato Markers2 Tag-Writeback bleibt bis zur Markerwriter-Validierung deaktiviert.');

  return {
    exportedFiles,
    warnings,
    crateHierarchy: resolveCrateHierarchy(crateState.hierarchy, crateFileNameByName),
    smartCrates: crateState.smartGroups
  };
}

async function removeExistingSeratoLibrary(targetPath) {
  await Promise.all([
    removeFileIfExists(path.join(targetPath, 'database V2')),
    removeFileIfExists(path.join(targetPath, 'database')),
    removeFileIfExists(path.join(targetPath, 'neworder.pref')),
    removeDirectoryIfExists(path.join(targetPath, 'Subcrates')),
    removeDirectoryIfExists(path.join(targetPath, 'SmartCrates')),
    removeDirectoryIfExists(path.join(targetPath, 'Djoo Sync'))
  ]);
}

async function removeFileIfExists(filePath) {
  await fs.unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
}

async function removeDirectoryIfExists(directoryPath) {
  await fs.rm(directoryPath, { recursive: true, force: true });
}

async function writeSeratoSyncExport(targetPath, tracks, timestamp) {
  const subcratesPath = path.join(targetPath, 'Subcrates');
  const djooExportPath = path.join(targetPath, 'Djoo Sync');
  const exportedFiles = [];
  const warnings = [];
  const usableTracks = dedupeSeratoExportTracks(tracks.filter((track) => track.sourcePath && isAudioFile(track.sourcePath)));

  await fs.mkdir(subcratesPath, { recursive: true });
  await fs.mkdir(djooExportPath, { recursive: true });
  await removeExistingDjooSyncCrates(subcratesPath);

  const crateState = createSyncCrateGroups(usableTracks, [], [], { cleanText, normalizePlaylistName, sanitizeFileName });
  const usedCrateFileNames = new Set();

  for (const [crateName, crateTracks] of crateState.groups) {
    const cratePath = path.join(subcratesPath, `${createUniqueSeratoCrateFileName(`Djoo Sync - ${crateName}`, usedCrateFileNames)}.crate`);
    await fs.writeFile(cratePath, buildSeratoCrateBuffer(crateTracks, targetPath));
    exportedFiles.push(cratePath);
  }

  exportedFiles.push(await writeSeratoCueManifest(djooExportPath, usableTracks, timestamp));

  warnings.push(`${crateState.groups.size} Serato-Crates wurden als Djoo Sync Crates geschrieben.`);
  warnings.push('Cues und Loops wurden im Djoo Sync Manifest gesichert. Direkter Serato Markers2 Tag-Writeback bleibt bis zur Markerwriter-Validierung deaktiviert.');

  return { exportedFiles, warnings };
}

async function writeSeratoPlaylistUpdate(targetPath, tracks, playlistNames, timestamp, playlistReferences = []) {
  const selectedPlaylistNames = Array.isArray(playlistNames) ? playlistNames.map(cleanText).filter(Boolean) : [];

  if (selectedPlaylistNames.length === 0) {
    throw new Error('Playlist-Update abgebrochen: keine Playlist ausgewaehlt.');
  }

  const subcratesPath = path.join(targetPath, 'Subcrates');
  const djooExportPath = path.join(targetPath, 'Djoo Sync');
  const exportedFiles = [];
  const warnings = [];
  const usableTracks = dedupeSeratoExportTracks(tracks.filter((track) => track.sourcePath && isAudioFile(track.sourcePath)));
  const crateState = createSyncCrateGroups(usableTracks, selectedPlaylistNames, playlistReferences, { cleanText, normalizePlaylistName, sanitizeFileName });
  const selectedKeys = new Set(selectedPlaylistNames.map(normalizePlaylistName));
  const selectedCrateGroups = Array.from(crateState.groups.entries())
    .filter(([crateName]) => selectedKeys.has(normalizePlaylistName(crateName)));
  const selectedSmartGroups = crateState.smartGroups
    .filter((smartGroup) => selectedKeys.has(normalizePlaylistName(smartGroup.name)));

  if (selectedCrateGroups.length === 0 && selectedSmartGroups.length === 0) {
    throw new Error('Playlist-Update abgebrochen: ausgewaehlte Playlist wurde in der Quelle nicht gefunden.');
  }

  await fs.mkdir(subcratesPath, { recursive: true });
  await fs.mkdir(djooExportPath, { recursive: true });

  const selectedTracks = dedupeSeratoExportTracks(selectedCrateGroups.flatMap(([, crateTracks]) => crateTracks));
  const existingTargetScan = await scanLibrary('serato', targetPath);
  const mergedDatabaseTracks = dedupeSeratoExportTracks([...existingTargetScan.tracks, ...selectedTracks]);
  const databasePath = path.join(targetPath, 'database V2');
  await fs.writeFile(databasePath, buildSeratoDatabaseBuffer(mergedDatabaseTracks, targetPath));
  exportedFiles.push(databasePath);

  const crateFileNames = [];
  const usedCrateFileNames = new Set();
  const crateFileNameByName = new Map();

  for (const [crateName, crateTracks] of selectedCrateGroups) {
    const crateFileName = createUniqueSeratoCrateFileName(crateName, usedCrateFileNames);
    const cratePath = path.join(subcratesPath, `${crateFileName}.crate`);
    await fs.writeFile(cratePath, buildSeratoCrateBuffer(crateTracks, targetPath));
    crateFileNameByName.set(crateName, crateFileName);
    crateFileNames.push(crateFileName);
    exportedFiles.push(cratePath);
  }

  exportedFiles.push(await mergeSeratoNewOrder(targetPath, crateFileNames));
  exportedFiles.push(await writeSeratoCueManifest(djooExportPath, selectedTracks, timestamp));
  warnings.push(`${selectedCrateGroups.length + selectedSmartGroups.length} Serato-Playlists wurden aktiv aus der Quelle aktualisiert.${selectedSmartGroups.length > 0 ? ` ${selectedSmartGroups.length} davon als Smart Crates.` : ''}`);
  warnings.push(`database V2 wurde mit ${mergedDatabaseTracks.length} Tracks neu geschrieben, damit neue Playlist-Tracks in Serato referenzierbar sind.`);

  return {
    exportedFiles,
    warnings,
    crateHierarchy: resolveCrateHierarchy(crateState.hierarchy, crateFileNameByName),
    smartCrates: selectedSmartGroups
  };
}

async function writeSeratoCueManifest(djooExportPath, usableTracks, timestamp) {
  const cueManifestPath = path.join(djooExportPath, `djoo-cues-loops-${timestamp}.json`);
  await fs.writeFile(cueManifestPath, JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    trackCount: usableTracks.length,
    tracks: usableTracks.map((track) => ({
      title: track.title,
      artist: track.artist,
      sourcePath: track.sourcePath,
      crate: track.crate,
      crates: Array.isArray(track.crates) ? track.crates : undefined,
      bpm: track.bpm,
      musicalKey: track.musicalKey,
      cues: track.cues || [],
      loops: track.loops || []
    }))
  }, null, 2), 'utf8');

  return cueManifestPath;
}

function dedupeSeratoExportTracks(tracks) {
  const tracksByPath = new Map();

  for (const track of tracks) {
    const key = normalizeComparablePath(track.sourcePath || '');

    if (!key || tracksByPath.has(key)) {
      continue;
    }

    tracksByPath.set(key, track);
  }

  return Array.from(tracksByPath.values());
}

async function removeExistingDjooSyncCrates(subcratesPath) {
  let entries;

  try {
    entries = await fs.readdir(subcratesPath, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^Djoo Sync - .*\.crate$/i.test(entry.name))
    .map((entry) => fs.unlink(path.join(subcratesPath, entry.name)).catch(() => undefined)));
}

function resolveCrateHierarchy(crateHierarchy, crateFileNameByName) {
  return crateHierarchy
    .map((entry) => ({
      name: crateFileNameByName.get(entry.name) || entry.name,
      parentName: entry.parentName ? (crateFileNameByName.get(entry.parentName) || entry.parentName) : null,
      kind: entry.kind === 'smart' ? 'smart' : 'crate'
    }))
    .filter((entry) => entry.name !== 'All Tracks' || entry.parentName == null);
}

function buildSeratoDatabaseBuffer(tracks, targetPath) {
  const records = [createSeratoTag('vrsn', encodeUtf16Be(seratoDatabaseVersion))];

  for (const track of tracks) {
    const seratoPath = formatSeratoExportPath(track.sourcePath || '', targetPath);
    const fields = [
      createSeratoTag('pfil', encodeUtf16Be(seratoPath)),
      createSeratoTag('tsng', encodeUtf16Be(track.title || path.basename(track.sourcePath || ''))),
      createSeratoTag('tart', encodeUtf16Be(track.artist || 'Unknown Artist'))
    ];

    if (track.genre) fields.push(createSeratoTag('tgen', encodeUtf16Be(track.genre)));
    if (track.bpm) fields.push(createSeratoTag('tbpm', encodeUtf16Be(String(Math.round(track.bpm)))));
    if (track.musicalKey) fields.push(createSeratoTag('tkey', encodeUtf16Be(track.musicalKey)));
    if (track.durationSeconds) fields.push(createSeratoTag('tlen', encodeUtf16Be(formatSeratoDuration(track.durationSeconds))));

    records.push(createSeratoTag('otrk', Buffer.concat(fields)));
  }

  return Buffer.concat(records);
}

function buildSeratoCrateBuffer(tracks, targetPath) {
  const records = [createSeratoTag('vrsn', encodeUtf16Be(seratoCrateVersion))];

  for (const track of tracks) {
    records.push(createSeratoTag('otrk', createSeratoTag('ptrk', encodeUtf16Be(formatSeratoExportPath(track.sourcePath || '', targetPath)))));
  }

  return Buffer.concat(records);
}

function formatSeratoExportPath(filePath, targetPath) {
  const cleanPath = cleanText(filePath);

  if (!cleanPath) {
    return '';
  }

  if (process.platform !== 'win32') {
    return cleanPath.replace(/\\/g, '/');
  }

  const normalizedPath = stripDuplicateWindowsDrive(path.normalize(cleanPath));
  const fileRoot = path.parse(normalizedPath).root;
  const targetRoot = targetPath ? path.parse(path.resolve(targetPath)).root : fileRoot;

  if (fileRoot && targetRoot && fileRoot.toLowerCase() === targetRoot.toLowerCase()) {
    const relativePath = path.relative(fileRoot, normalizedPath);

    if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
      return relativePath.replace(/\\/g, '/');
    }
  }

  return normalizedPath.replace(/\\/g, '/');
}

function stripDuplicateWindowsDrive(filePath) {
  const duplicateDriveMatch = String(filePath || '').match(/^[A-Za-z]:[\\/]([A-Za-z]:[\\/].*)$/);
  return duplicateDriveMatch ? path.normalize(duplicateDriveMatch[1]) : filePath;
}

async function writeSeratoNewOrder(targetPath, crateFileNames) {
  const orderPath = path.join(targetPath, 'neworder.pref');
  const uniqueNames = dedupeTextValues(crateFileNames);
  const content = ['[begin record]', ...uniqueNames.map((crateName) => `[crate]${crateName}`), '[end record]', ''].join('\n');
  await fs.writeFile(orderPath, content, 'utf8');
  return orderPath;
}

async function mergeSeratoNewOrder(targetPath, crateFileNames) {
  const orderPath = path.join(targetPath, 'neworder.pref');
  let existingNames = [];

  try {
    const content = await fs.readFile(orderPath, 'utf8');
    existingNames = content
      .split(/\r?\n/)
      .map((line) => line.match(/^\[crate\](.*)$/)?.[1])
      .filter(Boolean);
  } catch {
    existingNames = [];
  }

  return writeSeratoNewOrder(targetPath, dedupeTextValues([...existingNames, ...crateFileNames]));
}

function dedupeTextValues(values) {
  const uniqueValues = [];
  const seen = new Set();

  for (const value of values) {
    const cleanValue = cleanText(value);
    const key = cleanValue.toLowerCase();

    if (!cleanValue || seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueValues.push(cleanValue);
  }

  return uniqueValues;
}

function createSeratoTag(tag, payload) {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function encodeUtf16Be(value) {
  const littleEndian = Buffer.from(String(value || ''), 'utf16le');
  const bigEndian = Buffer.alloc(littleEndian.length);

  for (let index = 0; index < littleEndian.length - 1; index += 2) {
    bigEndian[index] = littleEndian[index + 1];
    bigEndian[index + 1] = littleEndian[index];
  }

  return bigEndian;
}

function formatSeratoDuration(seconds) {
  const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = String(safeSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function createUniqueSeratoCrateFileName(crateName, usedFileNames) {
  const baseName = sanitizeFileName(crateName);
  let candidateName = baseName;
  let suffix = 2;

  while (usedFileNames.has(candidateName.toLowerCase())) {
    candidateName = sanitizeFileName(`${baseName} ${suffix}`);
    suffix += 1;
  }

  usedFileNames.add(candidateName.toLowerCase());
  return candidateName;
}

function normalizePlaylistName(value) {
  return sanitizeFileName(value).toLowerCase();
}

function sanitizeFileName(value) {
  return cleanText(value)
    .replace(/[\\/]+/g, ' - ')
    .replace(/[<>:"|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim() || 'Djoo Sync';
}

function getLibraryStatePath() {
  return path.join(app.getPath('userData'), 'djoo-library-state.json');
}

function safeExists(targetPath) {
  try {
    return fsSync.existsSync(targetPath);
  } catch {
    return false;
  }
}
