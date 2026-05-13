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

function createSyncCrateGroups(tracks, playlistNames = [], helpers = {}) {
  const cleanText = helpers.cleanText || defaultCleanText;
  const sanitizeFileName = helpers.sanitizeFileName || defaultSanitizeFileName;
  const normalizePlaylistName = helpers.normalizePlaylistName || defaultNormalizePlaylistName;
  const groups = new Map();
  const hierarchy = [];
  const hierarchyKeys = new Set();
  const selectedPlaylistNames = Array.isArray(playlistNames) ? playlistNames.map(cleanText).filter(Boolean) : [];
  const selectedPlaylistKeys = new Set(selectedPlaylistNames.map(normalizePlaylistName));

  groups.set('All Tracks', tracks);
  pushHierarchy(hierarchy, hierarchyKeys, 'All Tracks', null, normalizePlaylistName);

  for (const track of tracks) {
    const rawCrateNames = Array.isArray(track.crates)
      ? track.crates
      : String(track.crate || '').split(',');
    const crateNames = rawCrateNames
      .map((crateName) => cleanText(crateName))
      .filter((crateName) => crateName && !/^serato library$/i.test(crateName))
      .filter((crateName) => selectedPlaylistKeys.size === 0 || selectedPlaylistKeys.has(normalizePlaylistName(crateName)));

    for (const crateName of crateNames) {
      const displayName = formatSeratoCrateDisplayName(crateName, sanitizeFileName);
      const parentName = formatSeratoCrateParentDisplayName(crateName, sanitizeFileName);
      const group = groups.get(displayName) || [];
      group.push(track);
      groups.set(displayName, group);
      pushHierarchy(hierarchy, hierarchyKeys, displayName, parentName, normalizePlaylistName);
    }
  }

  return { groups, hierarchy };
}

function pushHierarchy(hierarchy, hierarchyKeys, name, parentName, normalizePlaylistName) {
  const key = `${normalizePlaylistName(name)}::${parentName ? normalizePlaylistName(parentName) : ''}`;

  if (hierarchyKeys.has(key)) {
    return;
  }

  hierarchyKeys.add(key);
  hierarchy.push({ name, parentName });
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

  if (typeof executeSqlRows !== 'function') {
    throw new Error('patchSerato4ContainerHierarchy requires executeSqlRows.');
  }

  const rows = executeSqlRows(database, `
    SELECT id, parent_id, name, type, list_order, space_id, expanded
    FROM container
  `);
  const libraryRoot = rows.find((row) => row.name === 'Serato Library root') || null;

  if (!libraryRoot) {
    return false;
  }

  const crateRows = rows.filter((row) => Number(row.type) === 1 && Number(row.space_id) === Number(libraryRoot.space_id));
  const crateByName = new Map(crateRows.map((row) => [normalizePlaylistName(row.name), row]));
  const childrenByParentId = new Map();
  const expandedParentIds = new Set();
  let changed = false;

  for (const entry of crateHierarchy) {
    const crateRow = crateByName.get(normalizePlaylistName(entry.name));

    if (!crateRow) {
      continue;
    }

    const parentRow = entry.parentName ? crateByName.get(normalizePlaylistName(entry.parentName)) : null;
    const desiredParentId = parentRow ? Number(parentRow.id) : Number(libraryRoot.id);
    const currentParentId = crateRow.parent_id == null ? null : Number(crateRow.parent_id);

    if (currentParentId !== desiredParentId) {
      database.run('UPDATE container SET parent_id = ?, revision = revision + 1 WHERE id = ?', [desiredParentId, crateRow.id]);
      changed = true;
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
        database.run('UPDATE container SET list_order = ?, revision = revision + 1 WHERE id = ?', [desiredOrder, childId]);
        changed = true;
      }
    });
  }

  for (const parentId of expandedParentIds) {
    const parentRow = rows.find((row) => Number(row.id) === Number(parentId));

    if (parentRow && Number(parentRow.expanded) !== 1) {
      database.run('UPDATE container SET expanded = 1, revision = revision + 1 WHERE id = ?', [parentId]);
      changed = true;
    }
  }

  return changed;
}

module.exports = {
  createSyncCrateGroups,
  formatSeratoCrateDisplayName,
  formatSeratoCrateParentDisplayName,
  patchSerato4ContainerHierarchy
};
