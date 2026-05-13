const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const importFormats = new Set(['serato', 'engine', 'traktor']);
const audioExtensions = new Set(['.mp3', '.wav', '.aiff', '.aif', '.flac', '.m4a', '.ogg']);
const maxScanFiles = 18000;
const maxScanDepth = 12;
const maxId3ReadBytes = 8 * 1024 * 1024;

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
    return scanLibrary(request.format, request.rootPath);
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

async function scanLibrary(format, rootPath) {
  const exists = await pathExists(rootPath);

  if (!exists) {
    throw new Error(`Library path not found: ${rootPath}`);
  }

  const importedAt = new Date().toISOString();
  const collected = await collectFiles(rootPath, format, { includeStats: true });
  const sourceName = path.basename(rootPath) || rootPath;
  const warnings = [...collected.warnings];
  const references = format === 'serato'
    ? await readSeratoLibraryEntries(rootPath, collected)
    : collected.audioFiles.map((file) => ({ path: file.path, crate: sourceName }));

  if (format === 'serato' && references.length > collected.audioFiles.length) {
    warnings.push(`Serato database V2/Crates lieferten ${references.length} Trackreferenzen. Der Ordner selbst enthaelt ${collected.audioFiles.length} Audiodateien.`);
  }

  if (references.length === 0) {
    warnings.push('Keine Tracks gefunden. Fuer dieses Format fehlt eventuell noch der vollstaendige Datenbankparser.');
  }

  if (collected.truncated) {
    warnings.push(`Scan wurde nach ${maxScanFiles} Dateien begrenzt.`);
  }

  const tracks = [];

  for (let index = 0; index < references.length; index += 1) {
    tracks.push(await buildTrackFromReference(references[index], format, sourceName, importedAt, index));
  }

  return {
    format,
    rootPath,
    sourceName,
    importedAt,
    tracks,
    markers: Array.from(collected.markers),
    warnings,
    scannedFiles: collected.scannedFiles,
    markerFiles: collected.markerFiles.length,
    audioFiles: tracks.length
  };
}

async function readSeratoLibraryEntries(rootPath, collected) {
  const entries = new Map();
  const databasePath = path.join(rootPath, 'database V2');

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
    return {
      path: entry.path,
      originalPath: entry.originalPath,
      title: entry.title,
      artist: entry.artist,
      genre: entry.genre,
      bpm: entry.bpm,
      musicalKey: entry.musicalKey,
      durationSeconds: entry.durationSeconds,
      crate: crates.length > 0 ? crates.join(', ') : 'Serato Library'
    };
  });
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

  return {
    id: createId(`${format}-${filePath}`),
    title,
    artist,
    bpm,
    genre: reference.genre || id3.genre || parsed.genre,
    musicalKey: reference.musicalKey || id3.musicalKey,
    durationSeconds,
    sourceFormat: format,
    sourcePath: filePath,
    originalSourcePath: reference.originalPath,
    crate: reference.crate || sourceName,
    dateAdded: importedAt,
    cues: id3.cues || [],
    loops: id3.loops || [],
    status: exists ? 'ready' : 'missing-file',
    previewUrl: exists ? pathToFileURL(filePath).toString() : ''
  };
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
  return lower === 'node_modules' || lower === '$recycle.bin' || lower === 'system volume information';
}

function getMarkerLabels(filePath, format) {
  const normalizedPath = filePath.toLowerCase().replace(/\\/g, '/');
  const basename = path.basename(filePath).toLowerCase();
  const labels = [];

  if (format === 'serato') {
    if (normalizedPath.includes('_serato_')) labels.push('_Serato_ folder');
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(request.targetPath, 'Djoo Backups', `djoo-backup-${timestamp}`);
  const collected = await collectFiles(request.targetPath, request.targetFormat, { includeStats: false });
  const filesToBackup = collected.markerFiles.length > 0 ? collected.markerFiles : [];

  await fs.mkdir(backupPath, { recursive: true });

  for (const filePath of filesToBackup) {
    const relativePath = path.relative(request.targetPath, filePath);
    const destinationPath = path.join(backupPath, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(filePath, destinationPath);
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
    backedUpFiles: filesToBackup.length,
    committed: false,
    note: 'Backup and dry-run manifest created. Vendor writeback is locked until the export adapter is implemented.'
  };
  const manifestPath = path.join(backupPath, 'djoo-sync-manifest.json');

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    backupPath,
    manifestPath,
    committed: false,
    warnings: ['Backup wurde erstellt. Writeback in das Zielsystem ist noch gesperrt, bis der Exportadapter fertig ist.']
  };
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
