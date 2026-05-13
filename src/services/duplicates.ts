import type { Track } from '../domain/library';

export interface DuplicateCandidate {
  id: string;
  tracks: [Track, Track];
  confidence: number;
  reason: string;
}

export function findDuplicateCandidates(tracks: Track[]): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];

  for (let outerIndex = 0; outerIndex < tracks.length; outerIndex += 1) {
    for (let innerIndex = outerIndex + 1; innerIndex < tracks.length; innerIndex += 1) {
      const first = tracks[outerIndex];
      const second = tracks[innerIndex];
      const titleMatch = normalize(first.title) === normalize(second.title);
      const artistMatch = normalize(first.artist) === normalize(second.artist);
      const bpmClose = first.bpm && second.bpm ? Math.abs(first.bpm - second.bpm) <= 1 : false;
      const pathMatch = normalize(first.sourcePath || '') === normalize(second.sourcePath || '');

      if (pathMatch || (titleMatch && artistMatch) || (titleMatch && bpmClose)) {
        const confidence = pathMatch ? 98 : titleMatch && artistMatch ? 88 : 72;
        const reason = pathMatch
          ? 'Gleicher Dateipfad'
          : titleMatch && artistMatch
            ? 'Titel und Artist stimmen ueberein'
            : 'Titel passt, BPM ist sehr nah';

        candidates.push({
          id: `${first.id}-${second.id}`,
          tracks: [first, second],
          confidence,
          reason
        });
      }
    }
  }

  return candidates.sort((first, second) => second.confidence - first.confidence);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}
