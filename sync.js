// Google Drive sync service. Runs in the service worker; the popup talks to it through messages.js.
import { loadData, saveData } from './lib.js';
import {
  mergeData, parseRemote, serializeRemote, emptyRemote, partitionLocal, sameSyncState, diffLinks, RETENTION_MS,
} from './merge.js';
import * as drive from './drive.js';
import { getToken, dropToken, clientState } from './auth.js';
import * as vault from './oauth-store.js';
import { folderBackend, promotePending, clearHandles } from './folder.js';
import { DriveError, SyncError, describeError } from './errors.js';
import { computeStatus } from './sync-status.js';
import { now } from './clock.js';

export const SYNC_KEY = 'il_sync';
export const BACKUP_DEST_KEY = 'il_backup_dest';
export const BACKUP_LAST_KEY = 'il_backup_last';
export const DEFAULT_FILE_NAME = 'important-links-sync.json';

const LOCK_MS = 120_000;
const MAX_ATTEMPTS = 4;

/* ---------- Per-device sync config (stored separately from link data) ---------- */

const defaults = () => ({
  mode: 'folder', // 'folder' (synced local folder, no Google setup) | 'drive' (Google Drive API)
  deviceId: '', connected: false, account: null, folder: null, fileName: DEFAULT_FILE_NAME, fileId: null,
  confirmed: false, auto: true, dirty: false, syncing: false, needsAuth: false,
  lastSyncAt: null, lastAttemptAt: null, lastResult: null, lastError: null, warnings: [],
  remote: { version: null, revision: 0 }, lock: null,
});

export async function getSyncConfig() {
  const stored = (await chrome.storage.local.get(SYNC_KEY))[SYNC_KEY];
  const config = { ...defaults(), ...stored };
  if (!config.deviceId) {
    config.deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ [SYNC_KEY]: config });
  }
  return config;
}

// All writes to the config go through one queue so concurrent patches never lose each other.
let writeChain = Promise.resolve();
export function patchSync(patch) {
  const run = writeChain.then(async () => {
    const current = await getSyncConfig();
    const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
    await chrome.storage.local.set({ [SYNC_KEY]: next });
    return next;
  });
  writeChain = run.catch(() => {});
  return run;
}

export function normalizeFileName(name) {
  let n = String(name ?? '').trim().replace(/[\\/]/g, '-').slice(0, 100);
  if (!n) n = DEFAULT_FILE_NAME;
  return /\.[A-Za-z0-9]+$/.test(n) ? n : `${n}.json`;
}

/** Chooses the storage backend. 'pending' is a folder that was picked but not yet confirmed (used for previews). */
const backendFor = (config, which = 'active') => (config.mode === 'folder' ? folderBackend(which) : drive);
const needsGoogle = (config) => config.mode !== 'folder';

export async function getSyncStatus() {
  const config = await getSyncConfig();
  const cs = await clientState();
  return { ...computeStatus(config, { clientConfigured: cs.configured, locked: cs.locked }), config: publicConfig(config) };
}

/** Everything the UI may see. Contains no tokens (none are ever stored here). */
function publicConfig(c) {
  const { lock, deviceId, ...rest } = c; // eslint-disable-line no-unused-vars
  return rest;
}

/* ---------- Connect / disconnect / destination ---------- */

/* ---------- Google client (user-supplied OAuth client ID / secret / passphrase) ---------- */

const guardClientChange = async () => {
  const c = await getSyncConfig();
  if (c.connected && c.mode === 'drive') throw new SyncError('bad_mode', 'Disconnect Google Drive before changing the Google client.');
};

export const getClientState = () => clientState();

export async function saveGoogleClient(input) {
  await guardClientChange();
  await vault.saveClient(input);
  await patchSync({ needsAuth: false, lastError: null });
  return clientState();
}

export async function removeGoogleClient() {
  await guardClientChange();
  await vault.clearClient();
  return clientState();
}

export async function unlockGoogleClient(passphrase) {
  await vault.unlock(passphrase);
  await patchSync({ lastError: null });
  return clientState();
}

export async function lockGoogleClient() {
  await vault.lock();
  return clientState();
}

export async function connectGoogleDrive() {
  await getToken(true);
  const account = await drive.getAccount();
  await patchSync({ mode: 'drive', connected: true, needsAuth: false, account, lastError: null });
  return getSyncStatus();
}

/** Only allowed while nothing is connected. */
export async function setSyncMode(mode) {
  if (mode !== 'folder' && mode !== 'drive') throw new SyncError('bad_mode', 'Unknown sync method.');
  const c = await getSyncConfig();
  if (c.connected) throw new SyncError('bad_mode', 'Stop syncing before changing the method.');
  await patchSync({ mode });
  return getSyncStatus();
}

/** Marks the synced-folder method as active. The folder itself is chosen (and previewed) afterwards. */
export async function useLocalFolder() {
  await patchSync({ mode: 'folder', connected: true, needsAuth: false, account: null, lastError: null });
  return getSyncStatus();
}

export async function disconnectGoogleDrive() {
  if ((await getSyncConfig()).mode === 'folder') await clearHandles().catch(() => {});
  else {
    try {
      const token = await getToken(false);
      await dropToken(token, { revoke: true });
    } catch { /* nothing to revoke */ }
  }
  await patchSync({
    connected: false, account: null, folder: null, fileId: null, confirmed: false,
    dirty: false, syncing: false, needsAuth: false, lastError: null, lock: null, warnings: [],
  });
  return getSyncStatus();
}

export async function getSelectedDriveFolder() {
  return (await getSyncConfig()).folder;
}

export const listDriveFolders = (parentId, pageToken) => drive.listFolders(parentId, pageToken);
export const createDriveFolder = (parentId, name) => drive.createFolder(parentId, name);
export const resolveDriveFolder = (id) => drive.getFolder(id);

async function saveBackup(key, reason) {
  const d = await loadData();
  await chrome.storage.local.set({ [key]: { at: now(), reason, links: d.links, tombstones: d.tombstones } });
}

export async function getBackup(which) {
  const key = which === 'dest' ? BACKUP_DEST_KEY : BACKUP_LAST_KEY;
  return (await chrome.storage.local.get(key))[key] ?? null;
}

/**
 * Read-only look at what syncing with a destination would do. Writes nothing, so the user can cancel safely.
 */
export async function previewDestination({ folder, fileName, pending = false }) {
  const be = backendFor(await getSyncConfig(), pending ? 'pending' : 'active');
  const f = await be.getFolder(folder.id);
  const name = normalizeFileName(fileName);
  const files = await be.findFile(f.id, name);
  const warnings = [];
  let remote = emptyRemote();
  if (files.length) {
    remote = parseRemote(await be.downloadText(files[0].id)); // throws SyncDataError for malformed/incompatible
    if (files.length > 1) warnings.push(`${files.length} files named “${name}” exist in this folder; the oldest will be used.`);
  }
  const local = await loadData();
  const { valid, invalid } = partitionLocal(local.links);
  const merged = mergeData({ links: valid, tombstones: local.tombstones }, remote, { now: now() });
  return {
    folder: f, fileName: name, remoteExists: files.length > 0,
    localCount: valid.length, remoteCount: remote.links.length, mergedCount: merged.links.length,
    pull: diffLinks(valid, merged.links), push: diffLinks(remote.links, merged.links),
    skippedLocal: invalid.length, skippedRemote: remote.skipped,
    warnings: [...warnings, ...merged.warnings.map((w) => `Possible duplicate: ${w.url}`)],
  };
}

/** Commits a destination the user has previewed and confirmed. Snapshots local data first. */
export async function selectDriveFolder(folder, fileName, { pending = false } = {}) {
  const config = await getSyncConfig();
  const verified = await backendFor(config, pending ? 'pending' : 'active').getFolder(folder.id);
  await saveBackup(BACKUP_DEST_KEY, 'before changing destination');
  if (config.mode === 'folder' && pending) await promotePending();
  await patchSync({
    folder: verified, fileName: normalizeFileName(fileName), fileId: null, confirmed: true, dirty: true,
    remote: { version: null, revision: 0 }, lastSyncAt: null, lastResult: null, lastError: null, warnings: [],
  });
  return getSyncStatus();
}

export async function setAutoSync(auto) {
  await patchSync({ auto: Boolean(auto) });
  return getSyncStatus();
}

/* ---------- Remote download / merge / upload ---------- */

async function locateRemote(config, warnings) {
  const be = backendFor(config);
  if (config.fileId) {
    try {
      const meta = await be.getFileMeta(config.fileId);
      if (!meta.trashed && (!meta.parents || meta.parents.includes(config.folder.id))) return meta;
    } catch (err) {
      if (err.code !== 'not_found') throw err;
    }
  }
  const found = await be.findFile(config.folder.id, config.fileName);
  if (found.length > 1) warnings.push({ code: 'multiple-files', message: `${found.length} files named “${config.fileName}” exist in the folder. Using the oldest.` });
  return found[0] ?? null;
}

/** Returns { meta, data } or null when no sync file exists yet. */
export async function downloadRemoteData(config, warnings = []) {
  const meta = await locateRemote(config, warnings);
  if (!meta) return null;
  return { meta, data: parseRemote(await backendFor(config).downloadText(meta.id)) };
}

export function mergeLocalAndRemoteData(local, remote, at = now()) {
  const { valid, invalid } = partitionLocal(local.links);
  const merged = mergeData({ links: valid, tombstones: local.tombstones }, remote, { now: at });
  return { merged, validLocal: valid, invalidLocal: invalid };
}

export async function uploadMergedData({ config, remoteMeta, remote, merged, at }) {
  const revision = (remote.revision || 0) + 1;
  const text = serializeRemote({
    revision, updatedBy: config.deviceId, links: merged.links, tombstones: merged.tombstones, quarantine: remote.quarantine,
  }, at);
  const be = backendFor(config);
  const meta = remoteMeta
    ? await be.updateJsonFile(remoteMeta.id, text)
    : await be.createJsonFile(config.folder.id, config.fileName, text);
  // Read it back: if another device wrote between our check and our write, the revision/author will not match ours.
  const back = parseRemote(await be.downloadText(meta.id));
  return { meta, revision, confirmed: back.revision === revision && back.updatedBy === config.deviceId };
}

/* ---------- Locking and the sync loop ---------- */

let inFlight = null;
let rerunRequested = false;

/** Overlapping calls in this context share one run, then a single follow-up run catches anything newer. */
export function syncWithGoogleDrive(options = {}) {
  if (inFlight) {
    rerunRequested = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      let result = await runLocked(options);
      while (rerunRequested) {
        rerunRequested = false;
        result = await runLocked({ ...options, reason: 'queued' });
      }
      return result;
    } finally {
      inFlight = null;
      rerunRequested = false;
    }
  })();
  return inFlight;
}

async function acquireLock() {
  const config = await getSyncConfig();
  if (config.lock && config.lock.expires > now()) return null; // another context is syncing (or died less than LOCK_MS ago)
  const owner = crypto.randomUUID();
  await patchSync({ lock: { owner, expires: now() + LOCK_MS } });
  const check = await getSyncConfig();
  return check.lock?.owner === owner ? owner : null;
}

async function runLocked(options) {
  const owner = await acquireLock();
  if (!owner) return { status: 'busy' };
  try {
    return await doSync(options, owner);
  } catch (err) {
    const { code, message } = describeError(err);
    await patchSync((c) => ({
      syncing: false,
      lastError: code === 'cancelled' || code === 'locked' ? c.lastError : { code, message, at: now() },
      needsAuth: code === 'auth' ? true : c.needsAuth,
    }));
    throw err;
  } finally {
    await patchSync((c) => (c.lock?.owner === owner ? { lock: null, syncing: false } : {}));
  }
}

async function doSync(options, owner) {
  let config = await getSyncConfig();
  const be = backendFor(config);
  const where = needsGoogle(config) ? 'Drive folder' : 'sync folder';
  if (needsGoogle(config)) {
    const cs = await clientState();
    if (!cs.configured) throw new DriveError('setup', 'Google sign-in isn’t set up yet (see docs/SYNC.md).');
    if (cs.locked) throw new DriveError('locked', 'Enter your passphrase in Settings to unlock Google access.');
  }
  if (!config.connected) throw new SyncError('not_connected', needsGoogle(config) ? 'Google Drive isn’t connected.' : 'Sync isn’t set up.');
  if (!config.folder || !config.confirmed) throw new SyncError('no_folder', `Choose a ${where} in Settings first.`);
  await patchSync({ syncing: true, lastAttemptAt: now(), lastError: null });

  const staleMs = config.lastSyncAt ? now() - config.lastSyncAt : 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    config = await getSyncConfig();
    const at = now();
    const warnings = [];
    if (staleMs > RETENTION_MS) {
      warnings.push({ code: 'stale-device', message: 'This computer hadn’t synced for a long time, so links deleted elsewhere in the meantime may have reappeared.' });
    }

    if (attempt === 0) {
      try {
        const f = await be.getFolder(config.folder.id);
        if (f.name !== config.folder.name) await patchSync({ folder: { id: f.id, name: f.name } });
      } catch (err) {
        if (err.code === 'not_found') throw new SyncError('folder_missing', `The selected ${where} is missing${needsGoogle(config) ? ' or in the trash' : ''}. Choose a folder in Settings.`);
        throw err;
      }
    }

    const local = await loadData();
    const remoteFile = await downloadRemoteData(config, warnings);
    const remote = remoteFile?.data ?? emptyRemote();
    if (!needsGoogle(config)) {
      const copies = await be.conflictCopies(config.fileName).catch(() => []);
      if (copies.length) warnings.push({ code: 'conflict-copies', message: `Your sync tool left extra copies of the sync file (${copies.slice(0, 3).join(', ')}). Delete them once all computers are synced.` });
    }
    const { merged, validLocal, invalidLocal } = mergeLocalAndRemoteData(local, remote, at);
    warnings.push(...merged.warnings.map((w) => ({ code: w.code, message: `Two similar links share ${w.url}. Both were kept.` })));
    if (remote.skipped) warnings.push({ code: 'skipped-remote', message: `${remote.skipped} unreadable entr${remote.skipped === 1 ? 'y' : 'ies'} in the cloud file ${remote.skipped === 1 ? 'was' : 'were'} preserved but ignored.` });
    if (invalidLocal.length) warnings.push({ code: 'skipped-local', message: `${invalidLocal.length} local link${invalidLocal.length === 1 ? ' has' : 's have'} an unsupported URL and ${invalidLocal.length === 1 ? 'was' : 'were'} not synced.` });

    let meta = remoteFile?.meta ?? null;
    let revision = remote.revision;
    const needsUpload = !remoteFile || !sameSyncState(merged, remote);
    if (needsUpload) {
      if (remoteFile) {
        // Best-effort optimistic check: Drive has no conditional update, so re-read the version just before writing.
        const latest = await be.getFileMeta(remoteFile.meta.id);
        if (String(latest.version) !== String(remoteFile.meta.version)) continue; // changed during our sync: re-merge
      }
      await patchSync((c) => (c.lock?.owner === owner ? { lock: { owner, expires: now() + LOCK_MS } } : {}));
      const up = await uploadMergedData({ config, remoteMeta: remoteFile?.meta ?? null, remote, merged, at });
      if (!up.confirmed) continue; // someone else wrote at the same moment: re-merge against their version
      meta = up.meta;
      revision = up.revision;
    }

    // Only now that the cloud is up to date do we touch local data. Re-read it: the user may have edited meanwhile.
    const fresh = await loadData();
    const freshParts = partitionLocal(fresh.links);
    const final = mergeData({ links: freshParts.valid, tombstones: fresh.tombstones }, { links: merged.links, tombstones: merged.tombstones }, { now: at });
    const next = { ...fresh, links: [...final.links, ...freshParts.invalid], tombstones: final.tombstones };
    if (JSON.stringify([fresh.links, fresh.tombstones]) !== JSON.stringify([next.links, next.tombstones])) {
      await saveBackupOf(fresh);
      await saveData(next);
    }
    const editedMeanwhile = !sameSyncState(final, merged);

    const pull = diffLinks(validLocal, merged.links);
    const push = diffLinks(remote.links, merged.links);
    const result = {
      at,
      added: pull.added + push.added,
      updated: pull.updated + push.updated,
      deleted: pull.deleted + push.deleted,
      pulled: pull, pushed: push, uploaded: needsUpload, total: final.links.length,
    };
    await patchSync({
      syncing: false, lastSyncAt: at, lastError: null, needsAuth: false, dirty: editedMeanwhile,
      fileId: meta.id, remote: { version: meta.version ?? null, revision }, lastResult: result, warnings,
    });
    return { status: 'ok', ...result, warnings };
  }
  throw new SyncError('conflict', 'The cloud file kept changing while syncing. Your local data is safe; try again in a moment.');
}

async function saveBackupOf(data) {
  await chrome.storage.local.set({ [BACKUP_LAST_KEY]: { at: now(), reason: 'before applying sync changes', links: data.links, tombstones: data.tombstones } });
}
