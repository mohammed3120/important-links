// Automated tests of the sync service against an in-memory fake of the Drive API.
// They exercise the real sync.js / drive.js / merge.js code; only Google and the browser are simulated.
// (Tests that need a real Google account are listed in docs/SYNC.md under "Manual integration checklist".)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDrive } from './helpers/fake-drive.js';
import { makeDevice, use, seed, link } from './helpers/device.js';
import * as S from '../sync.js';
import { retry } from '../drive.js';
import { serializeRemote, parseRemote } from '../merge.js';
import { addTombstone } from '../lib.js';
import { handleMessage } from '../messages.js';

let drive, win, ub, folder;
const FILE = 'important-links-sync.json';

beforeEach(() => {
  retry.delayMs = 0;
  drive = new FakeDrive();
  win = makeDevice('windows', drive);
  ub = makeDevice('ubuntu', drive);
  folder = drive.addFolder('Important Links Sync');
  delete globalThis.localStorage;
});

async function connect(dev, folderId = folder, fileName = FILE) {
  use(dev, drive);
  await S.connectGoogleDrive();
  await S.selectDriveFolder({ id: folderId, name: 'Important Links Sync' }, fileName);
}
const sync = (dev) => { use(dev, drive); return S.syncWithGoogleDrive({ reason: 'manual' }); };
const status = async (dev) => { use(dev, drive); return S.getSyncStatus(); };
const titles = (dev) => dev.store.il_data.links.map((l) => l.title).sort();
const remote = (name = FILE, f = folder) => parseRemote(drive.find(f, name).content);
const remoteTitles = () => remote().links.map((l) => l.title).sort();

test('1. empty local data and empty cloud: creates an empty sync file, then is a no-op', async () => {
  await connect(win);
  const r = await sync(win);
  assert.equal(r.status, 'ok');
  assert.equal(remote().links.length, 0);
  const again = await sync(win);
  assert.equal(again.uploaded, false);
  assert.equal((await status(win)).state, 'ok');
});

test('2. existing Windows data, empty Ubuntu', async () => {
  seed(win, [link('A', 'https://a.example.com'), link('B', 'https://b.example.com')]);
  await connect(win); await sync(win);
  await connect(ub); await sync(ub);
  assert.deepEqual(titles(ub), ['A', 'B']);
});

test('3. existing Ubuntu data, empty Windows', async () => {
  seed(ub, [link('U1', 'https://u1.example.com')]);
  await connect(ub); await sync(ub);
  await connect(win); await sync(win);
  assert.deepEqual(titles(win), ['U1']);
});

test('4. different links added on both computers end up everywhere', async () => {
  seed(win, [link('A', 'https://a.example.com'), link('B', 'https://b.example.com'), link('C', 'https://c.example.com')]);
  seed(ub, [link('D', 'https://d.example.com'), link('E', 'https://e.example.com')]);
  await connect(win); await connect(ub);
  await sync(win); await sync(ub); await sync(win);
  assert.deepEqual(titles(win), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(titles(ub), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(remoteTitles(), ['A', 'B', 'C', 'D', 'E']);
});

test('5. the same link on both computers is not duplicated', async () => {
  const A = link('A', 'https://a.example.com');
  seed(win, [A]); seed(ub, [structuredClone(A)]);
  await connect(win); await connect(ub);
  await sync(win); await sync(ub); await sync(win);
  assert.equal(win.store.il_data.links.length, 1);
  assert.equal(ub.store.il_data.links.length, 1);
});

test('6. conflicting edits: the newest edit wins on both sides', async () => {
  const A = link('A', 'https://a.example.com');
  seed(win, [A]); seed(ub, [structuredClone(A)]);
  await connect(win); await connect(ub);
  await sync(win); await sync(ub);
  Object.assign(win.store.il_data.links[0], { title: 'edited on windows', updatedAt: A.updatedAt + 1000 });
  Object.assign(ub.store.il_data.links[0], { title: 'edited on ubuntu (later)', updatedAt: A.updatedAt + 5000 });
  await sync(win); await sync(ub); await sync(win);
  assert.deepEqual(titles(win), ['edited on ubuntu (later)']);
  assert.deepEqual(titles(ub), ['edited on ubuntu (later)']);
  assert.equal(win.store.il_data.links[0].createdAt, A.createdAt);
});

test('7. a deletion propagates and a stale copy cannot resurrect the link', async () => {
  const A = link('A', 'https://a.example.com'), B = link('B', 'https://b.example.com');
  seed(win, [A, B]); seed(ub, [structuredClone(A), structuredClone(B)]);
  await connect(win); await connect(ub);
  await sync(win); await sync(ub);
  const d = win.store.il_data; d.links = d.links.filter((l) => l.id !== A.id); addTombstone(d, A.id, Date.now());
  await sync(win);
  await sync(ub);
  assert.deepEqual(titles(ub), ['B']);
  // ubuntu still had the old copy before syncing; syncing again from either side must not bring it back
  await sync(ub); await sync(win);
  assert.deepEqual(titles(win), ['B']);
  assert.deepEqual(remoteTitles(), ['B']);
  assert.ok(remote().tombstones[A.id]);
});

test('8. offline: local data survives, nothing is reported as synced, retry succeeds', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win);
  drive.fail(/./, 'network', 100);
  await assert.rejects(sync(win), (e) => e.code === 'network');
  let st = await status(win);
  assert.equal(st.state, 'error');
  assert.equal(st.config.lastSyncAt, null);
  assert.equal(st.config.dirty, true);
  assert.deepEqual(titles(win), ['A']);
  drive.failures.length = 0;
  assert.equal((await sync(win)).status, 'ok');
  assert.equal((await status(win)).state, 'ok');
  assert.deepEqual(remoteTitles(), ['A']);
});

test('8b. a transient network blip is retried automatically', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win);
  drive.fail(/^GET \/drive\/v3\/files$/, 'network', 1);
  assert.equal((await sync(win)).status, 'ok');
});

test('9a. an expired cached token is refreshed transparently', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win);
  win.cached = 'expired-token';
  assert.equal((await sync(win)).status, 'ok');
  assert.ok(win.removedToken);
});

test('9b. revoked access asks for re-authentication and keeps local data', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win);
  win.cached = 'expired-token'; win.tokenMode = 'revoked';
  await assert.rejects(sync(win), (e) => e.code === 'auth');
  const st = await status(win);
  assert.equal(st.state, 'auth');
  assert.deepEqual(titles(win), ['A']);
  win.tokenMode = 'ok';
  use(win, drive); await S.connectGoogleDrive();
  assert.equal((await sync(win)).status, 'ok');
});

test('9c. cancelling sign-in leaves everything unchanged', async () => {
  use(win, drive); win.tokenMode = 'cancel';
  await assert.rejects(S.connectGoogleDrive(), (e) => e.code === 'cancelled');
  assert.equal((await status(win)).state, 'disconnected');
});

test('9d. quota, rate-limit and missing-API errors are reported with clear codes', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win);
  drive.fail(/^PATCH|^POST \/upload/, 403, 1, { error: { errors: [{ reason: 'storageQuotaExceeded' }] } });
  await assert.rejects(sync(win), (e) => e.code === 'quota' && /full/.test(e.message));
  drive.failures.length = 0;
  drive.fail(/^GET \/drive\/v3\/files$/, 429, 1); // retried, then succeeds
  assert.equal((await sync(win)).status, 'ok');
  drive.fail(/./, 403, 1, { error: { message: 'Google Drive API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } });
  await assert.rejects(sync(win), (e) => e.code === 'setup');
});

test('9e. missing client ID is reported as setup required', async () => {
  const bad = makeDevice('x', drive, { clientId: 'YOUR_CLIENT_ID.apps.googleusercontent.com' });
  use(bad, drive);
  await S.setSyncMode('drive');
  assert.equal((await S.getSyncStatus()).state, 'setup');
  await assert.rejects(S.connectGoogleDrive(), (e) => e.code === 'setup');
});

test('10a. a deleted or trashed destination folder needs attention and loses no data', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win); await sync(win);
  drive.files.get(folder).trashed = true;
  await assert.rejects(sync(win), (e) => e.code === 'folder_missing');
  const st = await status(win);
  assert.equal(st.state, 'attention');
  assert.deepEqual(titles(win), ['A']);
});

test('10b. a renamed folder keeps working and the new name is stored', async () => {
  await connect(win); await sync(win);
  drive.files.get(folder).name = 'Renamed Folder';
  await sync(win);
  assert.equal((await S.getSelectedDriveFolder()).name, 'Renamed Folder');
});

test('11. changing destination: preview writes nothing, then merge keeps both datasets', async () => {
  seed(win, [link('Local', 'https://local.example.com')]);
  await connect(win); await sync(win);
  const folder2 = drive.addFolder('Other');
  const other = serializeRemote({ revision: 5, updatedBy: 'someone', links: [link('Remote', 'https://remote.example.com')], tombstones: {} }, 1);
  const fileId = drive.addFile(folder2, FILE, other);
  const configBefore = JSON.stringify(win.store.il_sync);
  use(win, drive);
  const p = await S.previewDestination({ folder: { id: folder2 }, fileName: FILE });
  assert.equal(p.remoteExists, true);
  assert.equal(p.remoteCount, 1); assert.equal(p.localCount, 1); assert.equal(p.mergedCount, 2);
  assert.equal(p.pull.added, 1); assert.equal(p.push.added, 1);
  assert.equal(JSON.stringify(win.store.il_sync), configBefore, 'preview must not change settings');
  assert.equal(drive.files.get(fileId).content, other, 'preview must not change the cloud');
  await S.selectDriveFolder({ id: folder2, name: 'Other' }, FILE);
  assert.ok(win.store.il_backup_dest, 'a recoverable snapshot is taken first');
  await sync(win);
  assert.deepEqual(titles(win), ['Local', 'Remote']);
  assert.deepEqual(remote(FILE, folder2).links.map((l) => l.title).sort(), ['Local', 'Remote']);
  assert.deepEqual(remote(FILE, folder).links.map((l) => l.title), ['Local'], 'old folder untouched');
});

test('11b. a custom file name is honoured', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win, folder, 'my links');
  await sync(win);
  assert.ok(drive.find(folder, 'my links.json'));
});

test('12a. an interrupted upload leaves the cloud file and local data intact', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win); await sync(win);
  const before = drive.find(folder, FILE).content;
  win.store.il_data.links.push(link('B', 'https://b.example.com'));
  drive.fail(/^PATCH/, 'network', 100);
  await assert.rejects(sync(win), (e) => e.code === 'network');
  assert.equal(drive.find(folder, FILE).content, before);
  assert.deepEqual(titles(win), ['A', 'B']);
  assert.notEqual((await status(win)).state, 'ok');
  drive.failures.length = 0;
  await sync(win);
  assert.deepEqual(remoteTitles(), ['A', 'B']);
});

test('12b. an interrupted download is retried; a persistent one fails safely', async () => {
  seed(ub, [link('U', 'https://u.example.com')]);
  await connect(ub); await sync(ub);
  seed(win, [link('W', 'https://w.example.com')]);
  await connect(win);
  let n = 0;
  drive.hooks.afterDownload = () => { if (n++ < 1) throw new TypeError('Failed to fetch'); };
  assert.equal((await sync(win)).status, 'ok');
  drive.hooks.afterDownload = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(sync(win), (e) => e.code === 'network');
  drive.hooks.afterDownload = null;
  assert.deepEqual(titles(win), ['U', 'W']);
});

test('13a. overlapping syncs in one context share a single run', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win); use(win, drive);
  const [r1, r2] = await Promise.all([S.syncWithGoogleDrive(), S.syncWithGoogleDrive()]);
  assert.equal(r1.status, 'ok'); assert.equal(r2.status, 'ok');
  assert.equal(drive.calls.filter((c) => c.startsWith('POST /upload')).length, 1, 'exactly one file created');
  assert.equal([...drive.files.values()].filter((f) => f.name === FILE).length, 1);
});

test('13b. a live lock held by another context blocks syncing; an expired lock does not', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win);
  win.store.il_sync.lock = { owner: 'someone-else', expires: Date.now() + 60_000 };
  drive.calls.length = 0;
  assert.deepEqual(await sync(win), { status: 'busy' });
  assert.equal(drive.calls.length, 0);
  win.store.il_sync.lock = { owner: 'crashed', expires: Date.now() - 1 }; // interrupted earlier, e.g. browser restart
  assert.equal((await sync(win)).status, 'ok');
  assert.equal(win.store.il_sync.lock, null);
});

test('14a. malformed cloud JSON is never overwritten and local data is kept', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win);
  const id = drive.addFile(folder, FILE, '{ this is not json');
  await assert.rejects(sync(win), (e) => e.code === 'malformed');
  assert.equal(drive.files.get(id).content, '{ this is not json');
  assert.equal((await status(win)).state, 'attention');
  assert.deepEqual(titles(win), ['A']);
});

test('14b. a sync file from a newer schema is refused', async () => {
  await connect(win);
  const id = drive.addFile(folder, FILE, JSON.stringify({ app: 'important-links-sync', schema: 99, links: [] }));
  await assert.rejects(sync(win), (e) => e.code === 'incompatible');
  assert.match(drive.files.get(id).content, /"schema":99/);
});

test('14c. unreadable entries in the cloud file are preserved, not destroyed', async () => {
  const weird = { id: 'weird-0001', url: 'javascript:alert(1)', title: 'x', createdAt: 5 };
  drive.addFile(folder, FILE, JSON.stringify({ app: 'important-links-sync', schema: 1, revision: 1, links: [weird], tombstones: {} }));
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win);
  const r = await sync(win);
  assert.ok(r.warnings.some((w) => w.code === 'skipped-remote'));
  const doc = JSON.parse(drive.find(folder, FILE).content);
  assert.deepEqual(doc.quarantine, [weird]);
  assert.deepEqual(titles(win), ['A']);
});

test('15a. data written by v2.0.0 (no tombstones field) syncs fine', async () => {
  win.store.il_data = { schema: 2, links: [link('Old', 'https://old.example.com')], settings: { theme: 'dark', sort: 'alpha' } };
  await connect(win); await sync(win);
  assert.deepEqual(remoteTitles(), ['Old']);
  assert.equal(win.store.il_data.settings.theme, 'dark', 'settings are never synced or overwritten');
  assert.deepEqual(win.store.il_data.tombstones, {});
});

test('15b. legacy v1 localStorage links migrate and then sync', async () => {
  const ls = { array_links_list: JSON.stringify(['https://github.com', 'https://news.ycombinator.com']), array_labels_list: JSON.stringify(['GitHub', 'HN']) };
  globalThis.localStorage = { getItem: (k) => ls[k] ?? null, removeItem: (k) => { delete ls[k]; } };
  await connect(win); await sync(win);
  assert.deepEqual(remoteTitles(), ['GitHub', 'HN']);
  assert.equal(ls.array_links_list, undefined, 'legacy keys removed only after a successful save');
});

test('16. repeated syncing never duplicates and stops uploading once converged', async () => {
  seed(win, [link('A', 'https://a.example.com'), link('B', 'https://b.example.com')]);
  seed(ub, [link('C', 'https://c.example.com')]);
  await connect(win); await connect(ub);
  for (let i = 0; i < 3; i++) { await sync(win); await sync(ub); }
  assert.equal(win.store.il_data.links.length, 3);
  assert.equal(ub.store.il_data.links.length, 3);
  const rev = remote().revision;
  const r = await sync(win);
  assert.equal(r.uploaded, false);
  assert.deepEqual([r.added, r.updated, r.deleted], [0, 0, 0]);
  assert.equal(remote().revision, rev);
});

test('17a. a remote change made between our download and upload is merged, not overwritten', async () => {
  seed(win, [link('W1', 'https://w1.example.com')]);
  await connect(win); await sync(win);
  win.store.il_data.links.push(link('W2', 'https://w2.example.com'));
  let fired = false;
  drive.hooks.onMeta = (f) => {
    if (fired || f.name !== FILE) return;
    fired = true; // another computer uploads right now
    const cur = parseRemote(f.content);
    drive.put(f.id, serializeRemote({ revision: cur.revision + 1, updatedBy: 'other-device', links: [...cur.links, link('FromOther', 'https://other.example.com')], tombstones: cur.tombstones }, Date.now()));
  };
  await sync(win);
  assert.deepEqual(remoteTitles(), ['FromOther', 'W1', 'W2']);
  assert.deepEqual(titles(win), ['FromOther', 'W1', 'W2']);
});

test('17b. a write collision caught by the read-back is retried against the winner', async () => {
  seed(win, [link('W1', 'https://w1.example.com')]);
  await connect(win); await sync(win);
  win.store.il_data.links.push(link('W2', 'https://w2.example.com'));
  let fired = false;
  drive.hooks.afterUpdate = (f) => {
    if (fired) return;
    fired = true; // another computer's write lands right after ours, before we read back
    const ours = parseRemote(f.content);
    drive.put(f.id, serializeRemote({ revision: ours.revision, updatedBy: 'other-device', links: [...ours.links, link('Racer', 'https://racer.example.com')], tombstones: ours.tombstones }, Date.now()));
  };
  await sync(win);
  assert.deepEqual(remoteTitles(), ['Racer', 'W1', 'W2']);
});

test('18. tokens never appear in stored settings or in the cloud file', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win); await sync(win);
  const dump = JSON.stringify(win.store) + drive.find(folder, FILE).content;
  assert.ok(!dump.includes(drive.token));
  assert.ok(!JSON.stringify((await status(win)).config).includes('lock'));
});

test('19. link edits made while a sync is running are kept and flagged for the next sync', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win); await sync(win);
  win.store.il_data.links.push(link('B', 'https://b.example.com'));
  drive.hooks.afterUpdate = () => { win.store.il_data.links.push(link('Typed meanwhile', 'https://typed.example.com')); };
  await sync(win);
  assert.deepEqual(titles(win), ['A', 'B', 'Typed meanwhile']);
  assert.equal(win.store.il_sync.dirty, true);
  drive.hooks.afterUpdate = null;
  await sync(win);
  assert.deepEqual(remoteTitles(), ['A', 'B', 'Typed meanwhile']);
  assert.equal(win.store.il_sync.dirty, false);
});

test('20. disconnecting keeps local links; message router marks changes dirty', async () => {
  seed(win, [link('A', 'https://a.example.com')]);
  await connect(win); await sync(win);
  use(win, drive);
  await S.setAutoSync(false); // avoids starting the debounce timer in the test
  await handleMessage({ type: 'sync:dataChanged' });
  assert.equal((await status(win)).state, 'pending');
  await S.disconnectGoogleDrive();
  assert.equal((await status(win)).state, 'disconnected');
  assert.deepEqual(titles(win), ['A']);
  const res = await handleMessage({ type: 'sync:now' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not_connected');
});
