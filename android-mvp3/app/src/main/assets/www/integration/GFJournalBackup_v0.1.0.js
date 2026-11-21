/* GFStorage backup envelope. This is separate from the analytical JSON export. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GFJournalBackup = api;
})(globalThis, function (root) {
  'use strict';
  const FORMAT = 'glucopapa.gfstorage.backup';
  const MAX_FILE_CHARS = 24_000_000;

  function checkMode(mode) {
    if (mode !== 'local' && mode !== 'demo') throw Error('BACKUP_MODE');
    return mode;
  }

  function validateSnapshot(snapshot, mode, storage) {
    if (!snapshot || snapshot.schemaVersion !== 5) throw Error('BACKUP_SCHEMA');
    const parsed = storage.createHost({driver: {
      load: () => snapshot,
      save: () => { throw Error('BACKUP_VALIDATION_WRITE'); }
    }}).exportState();
    if (parsed.privateHistory) throw Error('BACKUP_RESEARCH_JOURNAL_ISOLATED');
    if (mode === 'local' && (parsed.cgmMetadata?.sourceType === 'synthetic' || parsed.cgm.some(x => x.source === 'synthetic'))) {
      throw Error('BACKUP_SYNTHETIC_NOT_LOCAL');
    }
    return parsed;
  }

  async function checksum(body) {
    if (!root.crypto?.subtle) throw Error('BACKUP_CHECKSUM_UNAVAILABLE');
    const hash = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
    return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
  }

  async function create(mode, snapshot, storage, now = new Date()) {
    const activeMode = checkMode(mode);
    const body = {format: FORMAT, version: 1, mode: activeMode, createdAt: now.toISOString(),
      snapshot: validateSnapshot(snapshot, activeMode, storage)};
    return JSON.stringify({...body, sha256: await checksum(body)});
  }

  async function verify(text, mode, storage) {
    const activeMode = checkMode(mode);
    if (typeof text !== 'string' || !text.length || text.length > MAX_FILE_CHARS) throw Error('BACKUP_SIZE');
    let backup;
    try { backup = JSON.parse(text); }
    catch { throw Error('BACKUP_INVALID_JSON'); }
    if (backup?.format !== FORMAT || backup.version !== 1 || Object.keys(backup).length !== 6 ||
        !/^[0-9a-f]{64}$/.test(backup.sha256) ||
        typeof backup.createdAt !== 'string' || !Number.isFinite(Date.parse(backup.createdAt))) {
      throw Error('BACKUP_FORMAT');
    }
    if (backup.mode !== activeMode) throw Error('BACKUP_MODE_MISMATCH');
    const {format, version, createdAt, snapshot} = backup;
    const body = {format, version, mode: activeMode, createdAt, snapshot};
    if (await checksum(body) !== backup.sha256) throw Error('BACKUP_CHECKSUM_MISMATCH');
    return Object.freeze({mode: activeMode, createdAt, snapshot: validateSnapshot(snapshot, activeMode, storage)});
  }

  // The caller has already validated and obtained explicit confirmation. SQLite makes
  // the absent check and insert atomic, even if a second host wrote after the preview.
  function importEmpty(native, key, verified) {
    if (key !== 'GFV2SHELL_DATA_v1_' + verified.mode) throw Error('BACKUP_MODE_MISMATCH');
    const snapshot = JSON.stringify(verified.snapshot);
    let p = JSON.parse(native.importIfAbsent(key, snapshot));
    if (p.ok && p.code === 'EXISTS' && native.seedScope?.() === 'main')
      p = JSON.parse(native.restoreOverPrivateSeed(key, snapshot));
    if (p.ok && p.code === 'EXISTS') throw Error('BACKUP_TARGET_EXISTS');
    if (p.ok !== true || p.code !== 'IMPORTED' || p.revision !== verified.snapshot.revision) {
      throw Error('BACKUP_WRITE_FAILED');
    }
  }

  return Object.freeze({create, verify, importEmpty});
});
