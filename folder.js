// "Synced folder" backend: reads/writes the sync file inside a local folder the user picked (for example the folder
// that Google Drive for desktop, rclone, Dropbox or Syncthing keeps in sync). Uses Chrome's File System Access API,
// so no Google sign-in, OAuth client or Cloud project is needed. Exposes the same functions sync.js uses from drive.js.
import { DriveError } from './errors.js';

const DB_NAME = 'il_fs';
const STORE = 'handles';

/* ---------- Persisting the folder handle (IndexedDB can store FileSystemDirectoryHandle objects) ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const idbStore = {
  async run(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  get: (key) => idbStore.run('readonly', (s) => s.get(key)),
  put: (key, value) => idbStore.run('readwrite', (s) => s.put(value, key)),
  delete: (key) => idbStore.run('readwrite', (s) => s.delete(key)),
};

let store = idbStore;
/** Tests inject an in-memory store. */
export function setHandleStore(s) { store = s ?? idbStore; }

export const loadHandle = (which = 'active') => store.get(which);
export const saveHandle = (which, handle) => store.put(which, handle);
export const deleteHandle = (which) => store.delete(which);

/** Makes the folder picked earlier (but not yet confirmed) the active one. */
export async function promotePending() {
  const h = await store.get('pending');
  if (!h) return false;
  await store.put('active', h);
  await store.delete('pending');
  return true;
}

export async function clearHandles() {
  await store.delete('pending').catch(() => {});
  await store.delete('active').catch(() => {});
}

export const folderPickerSupported = () => typeof globalThis.showDirectoryPicker === 'function';

/** Must be called from a click handler in a page (not the service worker). Stored as "pending" until confirmed. */
export async function pickDirectory() {
  const handle = await globalThis.showDirectoryPicker({ id: 'important-links-sync', mode: 'readwrite' });
  await store.put('pending', handle);
  return handle;
}

/** Asks Chrome to re-grant access to the saved folder. Needs a user click in a page. Returns true when granted. */
export async function requestAccess(which = 'active') {
  const h = await store.get(which);
  if (!h) return false;
  return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

/* ---------- Errors ---------- */

function mapError(err) {
  if (err instanceof DriveError) return err;
  switch (err?.name) {
    case 'NotFoundError': return new DriveError('not_found', 'The sync folder or file is no longer there.');
    case 'NotAllowedError':
    case 'SecurityError':
      return new DriveError('auth', 'Chrome needs your permission to use the sync folder again. Open Settings and choose “Allow folder access”.');
    case 'QuotaExceededError': return new DriveError('quota', 'There isn’t enough free disk space to write the sync file.');
    case 'NoModificationAllowedError':
    case 'InvalidStateError':
      return new DriveError('api', 'The sync file is in use by another program. Try again in a moment.');
    default: return new DriveError('api', 'Couldn’t read or write the sync folder.');
  }
}

const meta = (name, file) => ({ id: name, name, version: `${file.lastModified}:${file.size}`, trashed: false });

/* ---------- Backend (same surface as drive.js, scoped to one folder) ---------- */

/** which: 'active' (the confirmed folder) or 'pending' (picked, being previewed). */
export function folderBackend(which = 'active') {
  async function dir() {
    const h = await store.get(which);
    if (!h) throw new DriveError('not_found', 'No sync folder is selected on this computer.');
    let state = 'prompt';
    try { state = await h.queryPermission({ mode: 'readwrite' }); } catch { /* treated as not granted */ }
    if (state !== 'granted') throw mapError({ name: 'NotAllowedError' });
    return h;
  }
  const guard = (fn) => async (...args) => {
    try { return await fn(...args); } catch (err) { throw mapError(err); }
  };
  const optionalFile = async (d, name) => {
    try { return await d.getFileHandle(name); } catch (err) {
      if (err?.name === 'NotFoundError') return null;
      throw err;
    }
  };

  return {
    getFolder: guard(async () => {
      const d = await dir();
      await d.values()[Symbol.asyncIterator]().next(); // throws NotFoundError if the folder was deleted or moved
      return { id: 'local', name: d.name };
    }),

    findFile: guard(async (_folderId, name) => {
      const fh = await optionalFile(await dir(), name);
      return fh ? [meta(name, await fh.getFile())] : [];
    }),

    getFileMeta: guard(async (name) => {
      const fh = await optionalFile(await dir(), name);
      if (!fh) throw new DriveError('not_found', 'The sync file is missing.');
      return meta(name, await fh.getFile());
    }),

    downloadText: guard(async (name) => {
      const fh = await optionalFile(await dir(), name);
      if (!fh) throw new DriveError('not_found', 'The sync file is missing.');
      return (await fh.getFile()).text();
    }),

    createJsonFile: guard(async (_folderId, name, text) => {
      const d = await dir();
      if (await optionalFile(d, name)) throw new DriveError('api', 'The sync file appeared while syncing. Try again.');
      const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close(); // the write only becomes visible once closed (Chrome swaps in a temporary file)
      return meta(name, await fh.getFile());
    }),

    updateJsonFile: guard(async (name, text) => {
      const fh = await optionalFile(await dir(), name);
      if (!fh) throw new DriveError('not_found', 'The sync file is missing.');
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      return meta(name, await fh.getFile());
    }),

    /** Names of "conflict copies" some sync tools create (e.g. "file (1).json", "file (conflicted copy).json"). */
    conflictCopies: guard(async (name) => {
      const d = await dir();
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      const out = [];
      for await (const entry of d.values()) {
        if (entry.kind !== 'file' || entry.name === name) continue;
        if (entry.name.startsWith(base) && entry.name.endsWith(ext) && /\(|conflict/i.test(entry.name.slice(base.length))) out.push(entry.name);
      }
      return out;
    }),
  };
}
