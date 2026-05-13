function defaultCleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function defaultSanitizeFileName(value) {
  return defaultCleanText(value)
    .replace(/[\\/]+/g, ' - ')
    .replace(/[<>:"|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .trim() || 'Djoo Sync';
}

function defaultNormalizePlaylistName(value) {
  return defaultSanitizeFileName(value).toLowerCase();
}

function getTrackPlaylistReferences(track, cleanText = defaultCleanText) {
  if (Array.isArray(track?.playlists) && track.playlists.length > 0) {
    return track.playlists
      .map((playlist) => ({
        name: cleanText(playlist?.name || ''),
        kind: playlist?.kind === 'smart' ? 'smart' : 'crate',
        match: playlist?.match === 'any' ? 'any' : 'all',
        rules: Array.isArray(playlist?.rules)
          ? playlist.rules
            .map((rule) => ({
              field: cleanText(rule?.field || ''),
              operator: cleanText(rule?.operator || ''),
              value: cleanText(rule?.value || '')
            }))
            .filter((rule) => rule.field && rule.operator && rule.value)
          : undefined
      }))
      .filter((playlist) => playlist.name);
  }

  const rawCrateNames = Array.isArray(track?.crates)
    ? track.crates
    : String(track?.crate || '').split(',');

  return rawCrateNames
    .map((crateName) => cleanText(crateName))
    .filter(Boolean)
    .map((crateName) => ({ name: crateName, kind: 'crate' }));
}

function createSyncCrateGroups(tracks, playlistNames = [], playlistReferences = [], helpers = {}) {
  const cleanText = helpers.cleanText || defaultCleanText;
  const sanitizeFileName = helpers.sanitizeFileName || defaultSanitizeFileName;
  const normalizePlaylistName = helpers.normalizePlaylistName || defaultNormalizePlaylistName;
  const groups = new Map();
  const smartGroups = [];
  const hierarchy = [];
  const hierarchyKeys = new Set();
  const playlistStates = new Map();
  const selectedPlaylistNames = Array.isArray(playlistNames) ? playlistNames.map(cleanText).filter(Boolean) : [];
  const selectedPlaylistKeys = new Set(selectedPlaylistNames.map(normalizePlaylistName));

  groups.set('All Tracks', tracks);
  pushHierarchy(hierarchy, hierarchyKeys, 'All Tracks', null, 'crate', normalizePlaylistName);

  for (const playlistReference of Array.isArray(playlistReferences) ? playlistReferences : []) {
    const sourceName = cleanText(playlistReference?.name || '');

    if (!sourceName || /^serato library$/i.test(sourceName)) {
      continue;
    }

    if (selectedPlaylistKeys.size > 0 && !selectedPlaylistKeys.has(normalizePlaylistName(sourceName))) {
      continue;
    }

    const displayName = formatSeratoCrateDisplayName(sourceName, sanitizeFileName);
    const key = normalizePlaylistName(displayName);
    const parentName = formatSeratoCrateParentDisplayName(sourceName, sanitizeFileName);
    const existing = playlistStates.get(key);

    playlistStates.set(key, mergePlaylistState(existing, {
      name: displayName,
      sourceName,
      parentName,
      kind: playlistReference?.kind === 'smart' ? 'smart' : 'crate',
      match: playlistReference?.match === 'any' ? 'any' : 'all',
      rules: Array.isArray(playlistReference?.rules) ? playlistReference.rules : undefined,
      tracks: [],
      trackKeys: new Set()
    }, normalizePlaylistName));
  }

  for (const track of tracks) {
    const trackKey = normalizePlaylistName(String(track?.sourcePath || track?.id || ''));
    const trackPlaylists = getTrackPlaylistReferences(track, cleanText)
      .filter((playlistReference) => playlistReference.name && !/^serato library$/i.test(playlistReference.name))
      .filter((playlistReference) => selectedPlaylistKeys.size === 0 || selectedPlaylistKeys.has(normalizePlaylistName(playlistReference.name)));

    for (const playlistReference of trackPlaylists) {
      const displayName = formatSeratoCrateDisplayName(playlistReference.name, sanitizeFileName);
      const key = normalizePlaylistName(displayName);
      const parentName = formatSeratoCrateParentDisplayName(playlistReference.name, sanitizeFileName);
      const existing = playlistStates.get(key);
      const state = mergePlaylistState(existing, {
        name: displayName,
        sourceName: playlistReference.name,
        parentName,
        kind: playlistReference.kind === 'smart' ? 'smart' : 'crate',
        match: playlistReference.match === 'any' ? 'any' : 'all',
        rules: Array.isArray(playlistReference.rules) ? playlistReference.rules : undefined,
        tracks: existing?.tracks || [],
        trackKeys: existing?.trackKeys || new Set()
      }, normalizePlaylistName);

      if (!state.trackKeys.has(trackKey)) {
        state.trackKeys.add(trackKey);
        state.tracks.push(track);
      }

      playlistStates.set(key, state);
    }
  }

  for (const state of playlistStates.values()) {
    if (state.kind === 'smart') {
      smartGroups.push({
        name: state.name,
        sourceName: state.sourceName,
        parentName: state.parentName,
        kind: 'smart',
        match: state.match,
        rules: Array.isArray(state.rules) ? state.rules : [],
        tracks: state.tracks
      });
    } else {
      groups.set(state.name, state.tracks);
    }

    pushHierarchy(hierarchy, hierarchyKeys, state.name, state.parentName, state.kind, normalizePlaylistName);
  }

  return { groups, smartGroups, hierarchy };
}

function mergePlaylistState(existing, nextState, normalizePlaylistName) {
  if (!existing) {
    return nextState;
  }

  const prefersSmart = existing.kind === 'smart' || nextState.kind === 'smart';
  const fallbackName = existing.name || nextState.name;
  return {
    ...existing,
    ...nextState,
    name: fallbackName,
    sourceName: existing.sourceName || nextState.sourceName,
    parentName: existing.parentName || nextState.parentName,
    kind: prefersSmart ? 'smart' : 'crate',
    match: nextState.match || existing.match || 'all',
    rules: prefersSmart
      ? resolvePlaylistRules(existing.rules, nextState.rules, normalizePlaylistName)
      : undefined,
    tracks: existing.tracks || nextState.tracks || [],
    trackKeys: existing.trackKeys || nextState.trackKeys || new Set()
  };
}

function resolvePlaylistRules(firstRules, secondRules, normalizePlaylistName) {
  const candidates = [secondRules, firstRules]
    .filter((rules) => Array.isArray(rules) && rules.length > 0);

  if (candidates.length === 0) {
    return undefined;
  }

  const ruleMap = new Map();

  for (const rules of candidates) {
    for (const rule of rules) {
      const field = defaultCleanText(rule?.field || '');
      const operator = defaultCleanText(rule?.operator || '');
      const value = defaultCleanText(rule?.value || '');
      const key = `${normalizePlaylistName(field)}::${normalizePlaylistName(operator)}::${normalizePlaylistName(value)}`;

      if (!field || !operator || !value || ruleMap.has(key)) {
        continue;
      }

      ruleMap.set(key, { field, operator, value });
    }
  }

  return Array.from(ruleMap.values());
}

function pushHierarchy(hierarchy, hierarchyKeys, name, parentName, kind, normalizePlaylistName) {
  const key = `${normalizePlaylistName(name)}::${parentName ? normalizePlaylistName(parentName) : ''}::${kind}`;

  if (hierarchyKeys.has(key)) {
    return;
  }

  hierarchyKeys.add(key);
  hierarchy.push({ name, parentName, kind });
}

function formatSeratoCrateDisplayName(crateName, sanitizeFileName = defaultSanitizeFileName) {
  const segments = String(crateName || '')
    .split(/[\\/]+/)
    .map((segment) => defaultCleanText(segment))
    .filter(Boolean);

  return sanitizeFileName(segments.join(' - '));
}

function formatSeratoCrateParentDisplayName(crateName, sanitizeFileName = defaultSanitizeFileName) {
  const segments = String(crateName || '')
    .split(/[\\/]+/)
    .map((segment) => defaultCleanText(segment))
    .filter(Boolean);

  if (segments.length <= 1) {
    return null;
  }

  return sanitizeFileName(segments.slice(0, -1).join(' - '));
}

function patchSerato4ContainerHierarchy(database, crateHierarchy, helpers = {}) {
  if (!Array.isArray(crateHierarchy) || crateHierarchy.length === 0) {
    return false;
  }

  const executeSqlRows = helpers.executeSqlRows;
  const normalizePlaylistName = helpers.normalizePlaylistName || defaultNormalizePlaylistName;
  const smartCratesByName = new Map((Array.isArray(helpers.smartCrates) ? helpers.smartCrates : []).map((smartCrate) => [normalizePlaylistName(smartCrate.name), smartCrate]));

  if (typeof executeSqlRows !== 'function') {
    throw new Error('patchSerato4ContainerHierarchy requires executeSqlRows.');
  }

  const containerColumns = getSqliteTableColumns(database, 'container', executeSqlRows);
  const smartRuleColumns = getSqliteTableColumns(database, 'smart_crate_rules', executeSqlRows);
  const hasContainerRevision = containerColumns.has('revision');
  const hasSmartRuleRevision = smartRuleColumns.has('revision');
  const hasSmartRuleNeedsRefresh = smartRuleColumns.has('needs_refresh');
  let nextRevisionValue = getNextSqliteRevision(database, executeSqlRows, { hasContainerRevision, hasSmartRuleRevision });
  const nextRevision = () => {
    nextRevisionValue += 1;
    return nextRevisionValue;
  };

  const rows = executeSqlRows(database, `
    SELECT id, parent_id, name, type, list_order, space_id, expanded
    FROM container
  `);
  const libraryRoot = rows.find((row) => row.name === 'Serato Library root') || null;

  if (!libraryRoot) {
    return false;
  }

  const crateRows = rows.filter((row) => [1, 2].includes(Number(row.type)) && Number(row.space_id) === Number(libraryRoot.space_id));
  const crateByName = new Map(crateRows.map((row) => [normalizePlaylistName(row.name), row]));
  const childrenByParentId = new Map();
  const expandedParentIds = new Set();
  let changed = false;

  for (const entry of crateHierarchy) {
    const desiredType = entry.kind === 'smart' ? 2 : 1;
    const parentRow = entry.parentName ? crateByName.get(normalizePlaylistName(entry.parentName)) : null;
    const desiredParentId = parentRow ? Number(parentRow.id) : Number(libraryRoot.id);
    let crateRow = crateByName.get(normalizePlaylistName(entry.name));

    if (!crateRow) {
      const listOrderRows = crateRows.filter((row) => Number(row.parent_id) === desiredParentId);
      const desiredListOrder = listOrderRows.length + 1;
      const insertedRevision = nextRevision();
      insertSeratoContainer(database, {
        columns: containerColumns,
        revision: insertedRevision,
        parentId: desiredParentId,
        name: entry.name,
        type: desiredType,
        listOrder: desiredListOrder,
        spaceId: Number(libraryRoot.space_id),
        expanded: 0,
        portableId: ''
      });
      const insertedRows = executeSqlRows(database, 'SELECT last_insert_rowid() AS id');
      crateRow = {
        id: Number(insertedRows[0]?.id || 0),
        revision: insertedRevision,
        parent_id: desiredParentId,
        name: entry.name,
        type: desiredType,
        list_order: desiredListOrder,
        space_id: Number(libraryRoot.space_id),
        expanded: 0
      };
      crateRows.push(crateRow);
      crateByName.set(normalizePlaylistName(entry.name), crateRow);
      changed = true;
    }

    const currentParentId = crateRow.parent_id == null ? null : Number(crateRow.parent_id);
    const currentType = Number(crateRow.type);

    if (currentType !== desiredType) {
      updateSeratoContainer(database, containerColumns, crateRow.id, { type: desiredType, revision: nextRevision() });
      crateRow.type = desiredType;
      changed = true;

      if (desiredType === 2) {
        database.run('DELETE FROM container_asset WHERE container_id = ?', [crateRow.id]);
      } else {
        database.run('DELETE FROM smart_crate_rules WHERE container_id = ?', [crateRow.id]);
      }
    }

    if (currentParentId !== desiredParentId) {
      updateSeratoContainer(database, containerColumns, crateRow.id, { parent_id: desiredParentId, revision: nextRevision() });
      crateRow.parent_id = desiredParentId;
      changed = true;
    }

    if (desiredType === 2) {
      const smartCrate = smartCratesByName.get(normalizePlaylistName(entry.name));
      const rulesJson = buildSeratoSmartCrateRuleSet(smartCrate);

      if (rulesJson) {
        const existingRules = executeSqlRows(database, `SELECT rules${hasSmartRuleNeedsRefresh ? ', needs_refresh' : ''} FROM smart_crate_rules WHERE container_id = ?`, [crateRow.id])[0] || null;
        const desiredNeedsRefresh = 0;

        if (existingRules) {
          if (String(existingRules.rules || '') !== rulesJson || (hasSmartRuleNeedsRefresh && Number(existingRules.needs_refresh || 0) !== desiredNeedsRefresh)) {
            updateSeratoSmartCrateRules(database, smartRuleColumns, crateRow.id, {
              rules: rulesJson,
              version: 1,
              needsRefresh: desiredNeedsRefresh,
              revision: nextRevision()
            });
            changed = true;
          }
        } else {
          insertSeratoSmartCrateRules(database, smartRuleColumns, {
            containerId: crateRow.id,
            revision: nextRevision(),
            version: 1,
            rules: rulesJson,
            needsRefresh: desiredNeedsRefresh
          });
          changed = true;
        }
      }
    } else {
      const deletedRules = executeSqlRows(database, 'SELECT COUNT(*) AS count FROM smart_crate_rules WHERE container_id = ?', [crateRow.id]);

      if (Number(deletedRules[0]?.count || 0) > 0) {
        database.run('DELETE FROM smart_crate_rules WHERE container_id = ?', [crateRow.id]);
        changed = true;
      }
    }

    const siblings = childrenByParentId.get(desiredParentId) || [];
    siblings.push(crateRow.id);
    childrenByParentId.set(desiredParentId, siblings);

    if (parentRow) {
      expandedParentIds.add(parentRow.id);
    }
  }

  for (const [parentId, childIds] of childrenByParentId.entries()) {
    childIds.forEach((childId, index) => {
      const childRow = crateRows.find((row) => Number(row.id) === Number(childId));
      const desiredOrder = index + 1;

      if (childRow && Number(childRow.list_order) !== desiredOrder) {
        updateSeratoContainer(database, containerColumns, childId, { list_order: desiredOrder, revision: nextRevision() });
        changed = true;
      }
    });
  }

  for (const parentId of expandedParentIds) {
    const parentRow = rows.find((row) => Number(row.id) === Number(parentId));

    if (parentRow && Number(parentRow.expanded) !== 1) {
      updateSeratoContainer(database, containerColumns, parentId, { expanded: 1, revision: nextRevision() });
      changed = true;
    }
  }

  return changed;
}

function getSqliteTableColumns(database, tableName, executeSqlRows) {
  return new Set(executeSqlRows(database, `PRAGMA table_info(${tableName})`).map((row) => row.name));
}

function getNextSqliteRevision(database, executeSqlRows, options = {}) {
  const revisionValues = [];

  if (options.hasContainerRevision) {
    revisionValues.push(Number(executeSqlRows(database, 'SELECT MAX(revision) AS revision FROM container')[0]?.revision || 0));
  }

  if (options.hasSmartRuleRevision) {
    revisionValues.push(Number(executeSqlRows(database, 'SELECT MAX(revision) AS revision FROM smart_crate_rules')[0]?.revision || 0));
  }

  return Math.max(1, ...revisionValues.filter(Number.isFinite));
}

function insertSeratoContainer(database, values) {
  const columns = ['parent_id', 'name', 'type', 'list_order', 'space_id', 'expanded'];
  const params = [values.parentId, values.name, values.type, values.listOrder, values.spaceId, values.expanded];

  if (values.columns.has('revision')) {
    columns.unshift('revision');
    params.unshift(values.revision);
  }

  if (values.columns.has('portable_id')) {
    columns.push('portable_id');
    params.push(values.portableId || '');
  }

  if (values.columns.has('color')) {
    columns.push('color');
    params.push(null);
  }

  database.run(`INSERT INTO container (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, params);
}

function updateSeratoContainer(database, columns, containerId, values) {
  const updates = [];
  const params = [];

  for (const [column, value] of Object.entries(values)) {
    if (column === 'revision' && !columns.has('revision')) {
      continue;
    }

    if (!columns.has(column)) {
      continue;
    }

    updates.push(`${column} = ?`);
    params.push(value);
  }

  if (updates.length === 0) {
    return;
  }

  params.push(containerId);
  database.run(`UPDATE container SET ${updates.join(', ')} WHERE id = ?`, params);
}

function insertSeratoSmartCrateRules(database, columns, values) {
  const insertColumns = ['container_id', 'version', 'rules'];
  const params = [values.containerId, values.version, values.rules];

  if (columns.has('revision')) {
    insertColumns.splice(1, 0, 'revision');
    params.splice(1, 0, values.revision);
  }

  if (columns.has('needs_refresh')) {
    insertColumns.push('needs_refresh');
    params.push(values.needsRefresh);
  }

  database.run(`INSERT INTO smart_crate_rules (${insertColumns.join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`, params);
}

function updateSeratoSmartCrateRules(database, columns, containerId, values) {
  const updates = ['version = ?', 'rules = ?'];
  const params = [values.version, values.rules];

  if (columns.has('revision')) {
    updates.unshift('revision = ?');
    params.unshift(values.revision);
  }

  if (columns.has('needs_refresh')) {
    updates.push('needs_refresh = ?');
    params.push(values.needsRefresh);
  }

  params.push(containerId);
  database.run(`UPDATE smart_crate_rules SET ${updates.join(', ')} WHERE container_id = ?`, params);
}

function buildSeratoSmartCrateRuleSet(smartCrate) {
  if (!smartCrate || !Array.isArray(smartCrate.rules) || smartCrate.rules.length === 0) {
    return '';
  }

  const rules = smartCrate.rules
    .map((rule) => mapSeratoSmartCrateRule(rule))
    .filter(Boolean);

  if (rules.length === 0) {
    return '';
  }

  return JSON.stringify({
    spaces: ['Serato Library'],
    conjunction: smartCrate.match === 'any' ? 'OR' : 'AND',
    live_updates: true,
    rules
  });
}

function mapSeratoSmartCrateRule(rule) {
  const field = defaultCleanText(rule?.field || '').toLowerCase();
  const operator = defaultCleanText(rule?.operator || '').toUpperCase();
  const value = defaultCleanText(rule?.value || '');
  const attribute = mapSeratoSmartCrateAttribute(field);
  const mappedOperation = mapSeratoSmartCrateOperation(operator);

  if (!attribute || !mappedOperation || !value) {
    return null;
  }

  return {
    type: 'TEXT',
    attribute,
    operation: mappedOperation,
    version: 1,
    value
  };
}

function mapSeratoSmartCrateAttribute(field) {
  switch (field) {
    case 'genre':
      return 'genre';
    case 'artist':
      return 'artist';
    case 'album':
      return 'album';
    case 'title':
      return 'song';
    default:
      return '';
  }
}

function mapSeratoSmartCrateOperation(operator) {
  switch (operator) {
    case 'LIKE':
      return 'CONTAINS';
    case 'NOT LIKE':
      return 'DOES_NOT_CONTAIN';
    default:
      return '';
  }
}

module.exports = {
  createSyncCrateGroups,
  formatSeratoCrateDisplayName,
  formatSeratoCrateParentDisplayName,
  patchSerato4ContainerHierarchy
};
