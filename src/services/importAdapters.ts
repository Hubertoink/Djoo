import type { ImportResult, LibraryFormat, Track } from '../domain/library';

const audioExtensions = new Set(['.mp3', '.wav', '.aiff', '.aif', '.flac', '.m4a', '.ogg']);

const markerMatchers: Record<Exclude<LibraryFormat, 'djoo'>, Array<{ label: string; test: (path: string) => boolean }>> = {
  serato: [
    { label: '_Serato_ folder', test: (path) => path.includes('_serato_') },
    { label: 'Serato database', test: (path) => path.includes('database v2') || path.endsWith('/database') },
    { label: 'Serato crate', test: (path) => path.endsWith('.crate') }
  ],
  engine: [
    { label: 'Engine database', test: (path) => path.endsWith('.db') || path.endsWith('.m.db') },
    { label: 'Engine Library folder', test: (path) => path.includes('engine library') },
    { label: 'Engine export data', test: (path) => path.includes('database2') || path.includes('engine dj') }
  ],
  traktor: [
    { label: 'Traktor NML collection', test: (path) => path.endsWith('.nml') },
    { label: 'Traktor settings folder', test: (path) => path.includes('native instruments/traktor') }
  ]
};

export async function importFilesFromDirectory(files: FileList | File[], format: Exclude<LibraryFormat, 'djoo'>): Promise<ImportResult> {
  const selectedFiles = Array.from(files);
  const sourceName = getSourceName(selectedFiles);
  const markers = detectMarkers(selectedFiles, format);
  const warnings: string[] = [];
  const previewUrls: Record<string, string> = {};
  const importedAt = new Date().toISOString();

  if (selectedFiles.length === 0) {
    warnings.push('Keine Dateien ausgewaehlt.');
  }

  const audioFiles = selectedFiles.filter((file) => isAudioFile(file.name));

  if (audioFiles.length === 0) {
    warnings.push('Keine direkt abspielbaren Audiodateien gefunden. Der native Adapter muss spaeter die Library-Datenbank auslesen.');
  }

  if (markers.length === 0) {
    warnings.push('Keine eindeutigen Library-Marker gefunden. Der Import wird als Datei-Scan behandelt.');
  }

  const tracks: Track[] = audioFiles.map((file, index) => {
    const parsed = parseTrackName(file.name);
    const id = createId(`${format}-${file.name}-${file.size}-${file.lastModified}-${index}`);
    previewUrls[id] = URL.createObjectURL(file);

    return {
      id,
      title: parsed.title,
      artist: parsed.artist,
      genre: parsed.genre,
      sourceFormat: format,
      sourcePath: getRelativePath(file),
      crate: sourceName,
      dateAdded: importedAt,
      cues: [],
      loops: [],
      status: 'needs-review'
    };
  });

  return {
    report: {
      id: createId(`${format}-${sourceName}-${importedAt}`),
      format,
      sourceName,
      importedAt,
      trackCount: tracks.length,
      markers,
      warnings
    },
    tracks,
    previewUrls
  };
}

function detectMarkers(files: File[], format: Exclude<LibraryFormat, 'djoo'>) {
  const found = new Set<string>();
  const matchers = markerMatchers[format];

  for (const file of files) {
    const path = getRelativePath(file).toLowerCase().replace(/\\/g, '/');

    for (const matcher of matchers) {
      if (matcher.test(path)) {
        found.add(matcher.label);
      }
    }
  }

  return Array.from(found);
}

function isAudioFile(fileName: string) {
  const lower = fileName.toLowerCase();
  return Array.from(audioExtensions).some((extension) => lower.endsWith(extension));
}

function parseTrackName(fileName: string) {
  const cleanName = fileName.replace(/\.[^/.]+$/, '').replace(/_/g, ' ').trim();
  const parts = cleanName.split(' - ').map((part: string) => part.trim()).filter(Boolean);

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

function getSourceName(files: File[]) {
  const firstPath = files[0] ? getRelativePath(files[0]) : 'Manual selection';
  const firstSegment = firstPath.split(/[\\/]/)[0];
  return firstSegment || 'Manual selection';
}

function getRelativePath(file: File) {
  return file.webkitRelativePath || file.name;
}

function createId(seed: string) {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  const hash = Array.from(seed).reduce((accumulator, character) => {
    return (accumulator << 5) - accumulator + character.charCodeAt(0);
  }, 0);

  return `id-${Math.abs(hash)}-${Date.now()}`;
}
