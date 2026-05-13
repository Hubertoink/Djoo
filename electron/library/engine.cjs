function defaultCleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function executeRows(database, query, executeSqlRows) {
  if (typeof executeSqlRows !== 'function') {
    throw new Error('readEngine helper requires executeSqlRows.');
  }

  return executeSqlRows(database, query);
}

function getEnginePlaylistPath(listId, playlistById, seen = new Set(), cleanText = defaultCleanText) {
  const playlist = playlistById.get(listId);

  if (!playlist || seen.has(listId)) {
    return '';
  }

  seen.add(listId);

  const parentPath = playlist.parentListId ? getEnginePlaylistPath(playlist.parentListId, playlistById, seen, cleanText) : '';
  const title = cleanText(playlist.title);

  if (!title) {
    return parentPath;
  }

  return parentPath ? `${parentPath}/${title}` : title;
}

function readEngineCratesByTrackId(database, helpers = {}) {
  const cleanText = helpers.cleanText || defaultCleanText;
  const rows = (query) => executeRows(database, query, helpers.executeSqlRows);
  const cratesByTrackId = new Map();

  try {
    const playlistRows = rows(`
      SELECT id, title, parentListId
      FROM Playlist
      WHERE title IS NOT NULL AND title != ''
    `);
    const playlistById = new Map(playlistRows.map((playlist) => [playlist.id, playlist]));
    const trackRows = rows(`
      SELECT PlaylistEntity.trackId, PlaylistEntity.listId
      FROM PlaylistEntity
      JOIN Playlist ON Playlist.id = PlaylistEntity.listId
      WHERE Playlist.title IS NOT NULL AND Playlist.title != ''
    `);

    for (const row of trackRows) {
      const playlistPath = getEnginePlaylistPath(row.listId, playlistById, new Set(), cleanText);

      if (!playlistPath) {
        continue;
      }

      const existingCrates = cratesByTrackId.get(row.trackId) || [];

      if (!existingCrates.includes(playlistPath)) {
        existingCrates.push(playlistPath);
      }

      cratesByTrackId.set(row.trackId, existingCrates);
    }
  } catch {
    return cratesByTrackId;
  }

  return cratesByTrackId;
}

function readEngineSmartlists(database, helpers = {}) {
  const cleanText = helpers.cleanText || defaultCleanText;
  const rows = (query) => executeRows(database, query, helpers.executeSqlRows);

  try {
    return rows(`
      SELECT listUuid, title, parentPlaylistPath, rules, lastEditTime
      FROM Smartlist
      WHERE title IS NOT NULL AND title != ''
    `)
      .map((row) => {
        const title = cleanText(row.title);
        const playlistPath = buildEngineSmartlistPath(row.parentPlaylistPath, title, cleanText);
        const parsedRules = parseEngineSmartlistRules(row.rules);

        if (!playlistPath || parsedRules.rules.length === 0) {
          return null;
        }

        return {
          id: row.listUuid || playlistPath,
          title,
          path: playlistPath,
          match: parsedRules.match,
          rules: parsedRules.rules,
          lastEditTime: row.lastEditTime || ''
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildEngineSmartlistPath(parentPlaylistPath, title, cleanText = defaultCleanText) {
  const parentSegments = String(parentPlaylistPath || '')
    .split(';')
    .map((segment) => cleanText(segment))
    .filter(Boolean);
  const cleanTitle = cleanText(title);

  if (!cleanTitle) {
    return parentSegments.join('/');
  }

  return [...parentSegments, cleanTitle].join('/');
}

function parseEngineSmartlistRules(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules
        .map(normalizeEngineSmartlistRule)
        .filter(Boolean)
      : [];

    return {
      match: parsed.match === 'any' ? 'any' : 'all',
      rules
    };
  } catch {
    return { match: 'all', rules: [] };
  }
}

function normalizeEngineSmartlistRule(rule) {
  if (!rule || typeof rule !== 'object') {
    return null;
  }

  const column = defaultCleanText(rule.col).toLowerCase();
  const condition = defaultCleanText(rule.con).toUpperCase();
  const param = extractEngineSmartlistParam(rule.param);

  if (!column || !condition || !param) {
    return null;
  }

  return {
    field: column,
    column,
    operator: condition,
    condition,
    value: param,
    param
  };
}

function extractEngineSmartlistParam(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  const unquoted = text.replace(/^'+|'+$/g, '');
  return unquoted.replace(/%/g, '').trim();
}

function matchEngineSmartlists(trackLike, smartlists) {
  if (!Array.isArray(smartlists) || smartlists.length === 0) {
    return [];
  }

  return smartlists
    .filter((smartlist) => smartlist && engineSmartlistMatchesTrack(trackLike, smartlist));
}

function engineSmartlistMatchesTrack(trackLike, smartlist) {
  if (!smartlist || !Array.isArray(smartlist.rules) || smartlist.rules.length === 0) {
    return false;
  }

  const matches = smartlist.rules.map((rule) => engineSmartlistRuleMatchesTrack(trackLike, rule));
  return smartlist.match === 'any' ? matches.some(Boolean) : matches.every(Boolean);
}

function engineSmartlistRuleMatchesTrack(trackLike, rule) {
  const value = getEngineSmartlistTrackValue(trackLike, rule.column);
  const normalizedValue = String(value || '').toLowerCase();
  const normalizedParam = String(rule.param || '').toLowerCase();

  if (!normalizedParam) {
    return false;
  }

  if (rule.condition === 'LIKE') {
    return normalizedValue.includes(normalizedParam);
  }

  if (rule.condition === 'NOT LIKE') {
    return !normalizedValue.includes(normalizedParam);
  }

  return false;
}

function getEngineSmartlistTrackValue(trackLike, column) {
  switch (column) {
    case 'genre':
      return trackLike.genre;
    case 'artist':
      return trackLike.artist;
    case 'album':
      return trackLike.album;
    case 'title':
      return trackLike.title;
    default:
      return trackLike[column];
  }
}

module.exports = {
  getEnginePlaylistPath,
  readEngineCratesByTrackId,
  readEngineSmartlists,
  matchEngineSmartlists
};
