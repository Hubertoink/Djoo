export interface CamelotKey {
  display: string;
  original: string;
  number?: number;
  mode?: 'minor' | 'major';
  className: string;
}

const noteToCamelot: Record<string, string> = {
  'abm': '1A',
  'g#m': '1A',
  'ebm': '2A',
  'd#m': '2A',
  'bbm': '3A',
  'a#m': '3A',
  'fm': '4A',
  'cm': '5A',
  'gm': '6A',
  'dm': '7A',
  'am': '8A',
  'em': '9A',
  'bm': '10A',
  'f#m': '11A',
  'gbm': '11A',
  'c#m': '12A',
  'dbm': '12A',
  'b': '1B',
  'f#': '2B',
  'gb': '2B',
  'db': '3B',
  'c#': '3B',
  'ab': '4B',
  'g#': '4B',
  'eb': '5B',
  'd#': '5B',
  'bb': '6B',
  'a#': '6B',
  'f': '7B',
  'c': '8B',
  'g': '9B',
  'd': '10B',
  'a': '11B',
  'e': '12B'
};

const openKeyMinorToCamelot = ['8A', '9A', '10A', '11A', '12A', '1A', '2A', '3A', '4A', '5A', '6A', '7A'];
const openKeyMajorToCamelot = ['8B', '9B', '10B', '11B', '12B', '1B', '2B', '3B', '4B', '5B', '6B', '7B'];

export function normalizeCamelotKey(value?: string): CamelotKey {
  const original = String(value || '').trim();

  if (!original || original === '-') {
    return { display: '-', original, className: 'key-badge neutral' };
  }

  const compact = original
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace('minor', 'm')
    .replace('major', '')
    .replace('min', 'm')
    .replace('maj', '')
    .replace('♭', 'b')
    .replace('＃', '#');

  const camelotMatch = compact.match(/^(1[0-2]|[1-9])([ab])$/i);

  if (camelotMatch) {
    return buildCamelotKey(`${Number(camelotMatch[1])}${camelotMatch[2].toUpperCase()}`, original);
  }

  const openKeyMatch = compact.match(/^(1[0-2]|[1-9])([md])$/i);

  if (openKeyMatch) {
    const index = Number(openKeyMatch[1]) - 1;
    const display = openKeyMatch[2].toLowerCase() === 'm'
      ? openKeyMinorToCamelot[index]
      : openKeyMajorToCamelot[index];
    return buildCamelotKey(display, original);
  }

  const noteKey = compact.replace('♯', '#');
  const noteDisplay = noteToCamelot[noteKey];

  if (noteDisplay) {
    return buildCamelotKey(noteDisplay, original);
  }

  return { display: original, original, className: 'key-badge neutral' };
}

function buildCamelotKey(display: string, original: string): CamelotKey {
  const match = display.match(/^(1[0-2]|[1-9])([AB])$/);
  const number = match ? Number(match[1]) : undefined;
  const mode = match?.[2] === 'A' ? 'minor' : 'major';
  const numberClass = number ? ` key-number-${number}` : '';
  const modeClass = mode ? ` ${mode}` : '';

  return {
    display,
    original,
    number,
    mode,
    className: `key-badge camelot${numberClass}${modeClass}`
  };
}
