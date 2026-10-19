// Tests of the "synced folder" backend: two simulated computers share one directory (as Drive for desktop would),
// with a fake File System Access API. No Google API, token or network is used (fetch throws if called).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDevice, seed, link } from './helpers/device.js';
import * as S from '../sync.js';
import { setHandleStore } from '../folder.js';
import { parseRemote } from '../merge.js';
import { addTombstone } from '../lib.js';

const FILE = 'important-links-sync.json';
let clock = 1_800_000_000_000;

class FakeDir {
  constructor(name) { this.kind = 'directory'; this.name = name; this.files = new Map(); this.gone = false; this.perm = 'granted'; }
  check() { if (this.gone) throw Object.assign(new Error('gone'), { name: 'NotFoundError' }); }
  async queryPermission() { return this.perm; }
  async requestPermission() { return this.perm; }
  async getFileHandle(name, { create } = {}) {
    this.check();
    if (!this.files.has(name)) {
      if (!create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
      this.files.set(name, { text: '', lastModified: ++clock });
    }
    const dir = this;
    return {
      kind: 'file', name,
      async getFile() { const f = dir.files.get(name); return { lastModified: f.lastModified, size: f.text.length, text: async () => f.text }; },
      async createWritable() {
        let buf = '';
        return { write: async (t) => { buf += t; }, close: async () => { dir.files.set(name, { text: buf, lastModified: ++clock }); } };
      },
    };
  }
  async *values() {
    this.check();
    for (const name of this.files.keys()) yield { kind: 'file', name };
  }
}

const device = (name) => {
  const dev = makeDevice(name, null);
  dev.handles = new Map();
  dev.chrome.identity = undefined; // proves the folder method never touches Google sign-in
  return dev;
};
const use = (dev) => {
  globalThis.chrome = dev.chrome;
  setHandleStore({ get: async (k) => dev.handles.get(k), put: async (k, v) => { dev.handles.set(k, v); }, delete: async (k) => { dev.handles.delete(k); } });
};

let shared, win, ub, calls;
beforeEach(() => {
  shared = new FakeDir('ImportantLinks');
  win = device('windows'); ub = device('ubuntu');
  calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network must not be used'); };
  delete globalThis.localStorage;
});

/** Mirrors the UI: pick (pending) -> preview -> confirm -> done. */
async function setup(dev, dir = shared) {
  use(dev);
  dev.handles.set('pending', dir);
  await S.useLocalFolder();
  const preview = await S.previewDestination({ folder: { id: 'local', name: dir.name }, fileName: FILE, pending: true });
  await S.selectDriveFolder({ id: 'local', name: dir.name }, FILE, { pending: true });
  return preview;
}
const sync = (dev) => { use(dev); return S.syncWithGoogleDrive({ reason: 'manual' }); };
const titles = (dev) => dev.store.il_data.links.map((l) => l.title).sort();
const remote = () => parseRemote(shared.files.get(FILE).text);

test('F1. first computer creates the file, second merges and receives it', async () => {
  seed(win, [link('A', 'https://a.example.com'), link('B', 'https://b.example.com')]);
  const p = await setup(win);
  assert.equal(p.remoteExists, false);
  assert.equal((await sync(win)).status, 'ok');
  assert.equal(remote().links.length, 2);

  seed(ub, [link('C', 'https://c.example.com')]);
  const p2 = await setup(ub);
  assert.equal(p2.remoteExists, true);
  assert.equal(p2.mergedCount, 3);
  await sync(ub);
  assert.deepEqual(titles(ub), ['A', 'B', 'C']);
  await sync(win);
  assert.deepEqual(titles(win), ['A', 'B', 'C']);
  assert.equal(calls, 0);
});

test('F2. edits and deletions propagate; repeated sync is a no-op', async () => {
  const a = link('A', 'https://a.example.com'), b = link('B', 'https://b.example.com');
  seed(win, [a, b]); await setup(win); await sync(win);
  seed(ub, []); await setup(ub); await sync(ub);

  const d = ub.store.il_data;
  d.links = d.links.filter((l) => l.title !== 'B'); addTombstone(d, b.id, Date.now());
  d.links.find((l) => l.title === 'A').title = 'A2'; d.links.find((l) => l.title === 'A2').updatedAt = Date.now() + 5;
  await sync(ub); await sync(win);
  assert.deepEqual(titles(win), ['A2']);

  const rev = remote().revision;
  const r = await sync(win);
  assert.equal(r.uploaded, false);
  assert.equal(remote().revision, rev);
});

test('F3. lost folder permission is reported without data loss, then recovers', async () => {
  seed(win, [link('A', 'https://a.example.com')]); await setup(win); await sync(win);
  shared.perm = 'prompt';
  await assert.rejects(sync(win), (e) => e.code === 'auth');
  const st = await S.getSyncStatus();
  assert.equal(st.state, 'auth');
  assert.match(st.label, /Folder access/);
  assert.deepEqual(titles(win), ['A']);
  shared.perm = 'granted';
  assert.equal((await sync(win)).status, 'ok');
  assert.equal((await S.getSyncStatus()).state, 'ok');
});

test('F4. a deleted folder needs attention and loses no data', async () => {
  seed(win, [link('A', 'https://a.example.com')]); await setup(win); await sync(win);
  shared.gone = true;
  await assert.rejects(sync(win), (e) => e.code === 'folder_missing');
  assert.equal((await S.getSyncStatus()).state, 'attention');
  assert.deepEqual(titles(win), ['A']);
});

test('F5. previewing a different folder changes nothing until confirmed', async () => {
  seed(win, [link('A', 'https://a.example.com')]); await setup(win); await sync(win);
  const other = new FakeDir('Other');
  other.files.set(FILE, { text: shared.files.get(FILE).text, lastModified: 1 });
  win.handles.set('pending', other);
  const p = await S.previewDestination({ folder: { id: 'local', name: 'Other' }, fileName: FILE, pending: true });
  assert.equal(p.remoteExists, true);
  assert.equal(win.handles.get('active'), shared, 'active folder untouched by preview');
  assert.equal((await S.getSyncConfig()).folder.name, 'ImportantLinks');
  await S.selectDriveFolder({ id: 'local', name: 'Other' }, FILE, { pending: true });
  assert.equal(win.handles.get('active'), other);
  assert.equal(win.handles.has('pending'), false);
  assert.ok(win.store.il_backup_dest, 'snapshot saved before switching');
});

test('F6. extra copies made by the sync tool produce a warning', async () => {
  seed(win, [link('A', 'https://a.example.com')]); await setup(win); await sync(win);
  shared.files.set('important-links-sync (1).json', { text: '{}', lastModified: 5 });
  const r = await sync(win);
  assert.ok(r.warnings.some((w) => w.code === 'conflict-copies'));
});

test('F7. a corrupted sync file is never overwritten', async () => {
  seed(win, [link('A', 'https://a.example.com')]); await setup(win);
  shared.files.set(FILE, { text: 'not json {{', lastModified: 9 });
  await assert.rejects(sync(win), (e) => e.code === 'malformed');
  assert.equal(shared.files.get(FILE).text, 'not json {{');
  assert.deepEqual(titles(win), ['A']);
});

test('F8. stop syncing forgets the folder and leaves the file and local links alone', async () => {
  seed(win, [link('A', 'https://a.example.com')]); await setup(win); await sync(win);
  await S.disconnectGoogleDrive();
  assert.equal(win.handles.size, 0);
  assert.equal((await S.getSyncStatus()).config.connected, false);
  assert.ok(shared.files.has(FILE));
  assert.deepEqual(titles(win), ['A']);
});

test('F9. mode can only change while disconnected', async () => {
  use(win);
  await S.setSyncMode('drive');
  assert.equal((await S.getSyncConfig()).mode, 'drive');
  await S.setSyncMode('folder');
  await S.useLocalFolder();
  await assert.rejects(S.setSyncMode('drive'), (e) => e.code === 'bad_mode');
});
