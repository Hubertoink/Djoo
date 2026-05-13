import type { Track } from '../domain/library';

export const seedTracks: Track[] = [
  {
    id: 'seed-low',
    title: 'Low',
    artist: 'FloRida',
    bpm: 123,
    genre: 'Hip Hop',
    musicalKey: '12b',
    durationSeconds: 228,
    sourceFormat: 'djoo',
    sourcePath: 'Demo Library',
    crate: 'Warmup',
    dateAdded: '2026-05-13T10:00:00.000Z',
    cues: [
      { id: 'seed-low-cue-1', label: 'Intro', positionMs: 0, color: '#ec007a' },
      { id: 'seed-low-cue-2', label: 'Drop', positionMs: 62000, color: '#38d5ff' }
    ],
    loops: [],
    rating: 4,
    status: 'ready'
  },
  {
    id: 'seed-test',
    title: 'Test',
    artist: 'Hubertoink',
    bpm: 109,
    genre: 'House',
    musicalKey: '2a',
    durationSeconds: 196,
    sourceFormat: 'djoo',
    sourcePath: 'Demo Library',
    crate: 'Club Tools',
    dateAdded: '2026-05-13T10:02:00.000Z',
    cues: [{ id: 'seed-test-cue-1', label: 'First beat', positionMs: 1220, color: '#9afb89' }],
    loops: [{ id: 'seed-test-loop-1', label: 'Outro 8', startMs: 171000, endMs: 187000 }],
    rating: 3,
    status: 'ready'
  }
];
