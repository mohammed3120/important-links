// Unit tests for the pure merge engine and sync-file validation. No browser APIs involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeData, parseRemote, serializeRemote, sameSyncState, diffLinks, RETENTION_MS, sanitizeSyncLink } from '../merge.js';
import { link } from './helpers/device.js';

const NOW = 1_700_000_000_000 + 86_400_000; // one day after the fixture links, inside the retention window
const D = (links = [], tombstones = {}) => ({ links, tombstones });
const ids = (r) => r.links.map((l) => l.id).sort();

test('union of independent links keeps everything (A,B,C + A,D,E)', () => {
  const A = link('A', 'https://a.example.com'), B = link('B', 'https://b.example.com'), C = link('C', 'https://c.example.com');
  const Dd = link('D', 'https://d.example.com'), E = link('E', 'https://e.example.com');
  const r = mergeData(D([A, B, C]), D([A, Dd, E]), { now: NOW });
  assert.deepEqual(ids(r), [A, B, C, Dd, E].map((l) => l.id).sort());
});

test('same link on both sides is not duplicated', () => {
  const A = link('A', 'https://a.example.com');
  assert.equal(mergeData(D([A]), D([structuredClone(A)]), { now: NOW }).links.length, 1);
});

test('newest updatedAt wins and creation time is preserved', () => {
  const A = link('A', 'https://a.example.com');
  const older = { ...A, title: 'old', createdAt: A.createdAt + 500, updatedAt: A.updatedAt + 10 };
  const newer = { ...A, title: 'new', updatedAt: A.updatedAt + 99 };
  for (const [x, y] of [[older, newer], [newer, older]]) {
    const [m] = mergeData(D([x]), D([y]), { now: NOW }).links;
    assert.equal(m.title, 'new');
    assert.equal(m.createdAt, A.createdAt);
  }
});

test('tie on updatedAt is deterministic and order independent', () => {
  const A = link('A', 'https://a.example.com');
  const x = { ...A, title: 'alpha' }, y = { ...A, title: 'omega' };
  const r1 = mergeData(D([x]), D([y]), { now: NOW }).links[0].title;
  const r2 = mergeData(D([y]), D([x]), { now: NOW }).links[0].title;
  assert.equal(r1, r2);
});

test('usage counters merge by max without being treated as edits', () => {
  const A = link('A', 'https://a.example.com');
  const [m] = mergeData(D([{ ...A, openCount: 3, lastOpenedAt: 50 }]), D([{ ...A, openCount: 7, lastOpenedAt: 40 }]), { now: NOW }).links;
  assert.equal(m.openCount, 7);
  assert.equal(m.lastOpenedAt, 50);
  assert.ok(sameSyncState(D([{ ...A, openCount: 1 }]), D([{ ...A, openCount: 9 }])));
});

test('tombstone deletes a stale copy and is not reversed by an older record', () => {
  const A = link('A', 'https://a.example.com');
  const r = mergeData(D([A]), D([], { [A.id]: { deletedAt: A.updatedAt + 1 } }), { now: NOW });
  assert.equal(r.links.length, 0);
  assert.ok(r.tombstones[A.id]);
});

test('a record edited after the deletion resurrects and clears the tombstone', () => {
  const A = link('A', 'https://a.example.com');
  const r = mergeData(D([{ ...A, updatedAt: A.updatedAt + 100 }]), D([], { [A.id]: { deletedAt: A.updatedAt + 1 } }), { now: NOW });
  assert.equal(r.links.length, 1);
  assert.equal(r.tombstones[A.id], undefined);
});

test('tombstone wins when deletedAt equals updatedAt', () => {
  const A = link('A', 'https://a.example.com');
  assert.equal(mergeData(D([A]), D([], { [A.id]: { deletedAt: A.updatedAt } }), { now: NOW }).links.length, 0);
});

test('old tombstones are pruned after the retention window, recent ones kept', () => {
  const r = mergeData(D([], { 'old-id-0001': { deletedAt: NOW - RETENTION_MS - 1 }, 'new-id-0001': { deletedAt: NOW - 1000 } }), D(), { now: NOW });
  assert.deepEqual(Object.keys(r.tombstones), ['new-id-0001']);
});

test('same page saved under two ids collapses to the oldest; the loser stays deleted', () => {
  const a = link('Docs', 'https://example.com/docs');
  const b = { ...link('Docs', 'http://www.example.com/docs/#intro'), createdAt: a.createdAt + 5000 };
  const r = mergeData(D([a]), D([b]), { now: NOW });
  assert.equal(r.links.length, 1);
  assert.equal(r.links[0].id, a.id);
  assert.ok(r.tombstones[b.id]);
  // merging again with the stale duplicate does not bring it back
  assert.equal(mergeData(D(r.links, r.tombstones), D([b]), { now: NOW }).links.length, 1);
});

test('same URL with meaningfully different details is kept as two links with a warning', () => {
  const a = link('Docs', 'https://example.com/docs', { tags: ['work'] });
  const b = link('Docs notes', 'https://example.com/docs', { description: 'different' });
  const r = mergeData(D([a]), D([b]), { now: NOW });
  assert.equal(r.links.length, 2);
  assert.equal(r.warnings[0].code, 'duplicate-url');
});

test('merge is idempotent and commutative (randomized)', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 200; round++) {
    const pool = Array.from({ length: 6 }, (_, i) => link(`P${round}-${i}`, `https://site${i}.example.com/${round}`));
    const side = () => {
      const links = pool.filter(() => rnd() < 0.6).map((l) => ({ ...l, title: rnd() < 0.4 ? `t${rnd()}` : l.title, updatedAt: l.updatedAt + Math.floor(rnd() * 3) }));
      const tombstones = Object.fromEntries(pool.filter(() => rnd() < 0.2).map((l) => [l.id, { deletedAt: l.updatedAt + Math.floor(rnd() * 3) }]));
      return D(links, tombstones);
    };
    const a = side(), b = side();
    const ab = mergeData(a, b, { now: NOW }), ba = mergeData(b, a, { now: NOW });
    assert.ok(sameSyncState(ab, ba), 'commutative');
    assert.ok(sameSyncState(mergeData(ab, a, { now: NOW }), ab), 'idempotent with a');
    assert.ok(sameSyncState(mergeData(ab, b, { now: NOW }), ab), 'idempotent with b');
    assert.ok(sameSyncState(mergeData(ab, ab, { now: NOW }), ab), 'idempotent with itself');
  }
});

test('diffLinks counts added, updated, deleted', () => {
  const a = link('A', 'https://a.example.com'), b = link('B', 'https://b.example.com'), c = link('C', 'https://c.example.com');
  assert.deepEqual(diffLinks([a, b], [{ ...a, title: 'x' }, c]), { added: 1, updated: 1, deleted: 1 });
});

/* ---------- Validation of cloud content ---------- */

const file = (over = {}) => JSON.stringify({ app: 'important-links-sync', schema: 1, revision: 3, updatedAt: 5, updatedBy: 'dev', links: [], tombstones: {}, ...over });

test('parseRemote accepts a valid file and round-trips serializeRemote', () => {
  const a = link('A', 'https://a.example.com');
  const text = serializeRemote({ revision: 4, updatedBy: 'dev', links: [a], tombstones: { 'gone-id-001': { deletedAt: 9 } } }, 123);
  const r = parseRemote(text);
  assert.equal(r.revision, 4);
  assert.deepEqual(r.links[0], sanitizeSyncLink(a));
  assert.equal(r.tombstones['gone-id-001'].deletedAt, 9);
});

test('parseRemote rejects empty, non-JSON, foreign and malformed files', () => {
  for (const bad of ['', '   ', 'not json', '[]', '{"app":"other","schema":1,"links":[]}', file({ links: 'x' }), file({ schema: 'one' }), file({ tombstones: [] })]) {
    assert.throws(() => parseRemote(bad), (e) => e.code === 'malformed', bad.slice(0, 30));
  }
});

test('parseRemote flags files from a newer schema as incompatible', () => {
  assert.throws(() => parseRemote(file({ schema: 99 })), (e) => e.code === 'incompatible');
});

test('hostile entries are dropped, limited and quarantined instead of trusted', () => {
  const good = link('Good', 'https://ok.example.com');
  const r = parseRemote(file({ links: [
    good,
    { ...good, id: 'js-link-001', url: 'javascript:alert(1)' },
    { ...good, id: '../../etc/passwd' },
    { ...good, id: 'long-title-1', title: 'x'.repeat(5000), description: 'y'.repeat(5000), tags: Array.from({ length: 50 }, (_, i) => `t${i}`) },
    null, 42, { id: 'no-times-001', url: 'https://x.example.com' },
  ] }));
  assert.equal(r.links.length, 2);
  assert.equal(r.skipped, 5);
  assert.equal(r.quarantine.length, 5); // every unreadable entry is kept verbatim so uploading never destroys it
  const long = r.links.find((l) => l.id === 'long-title-1');
  assert.equal(long.title.length, 200);
  assert.equal(long.description.length, 500);
  assert.equal(long.tags.length, 10);
  assert.ok(!JSON.stringify(r.links).includes('<script'));
});
