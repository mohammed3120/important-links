// Pure merge engine and sync-file validation. No chrome.* or DOM access, so it is fully unit-testable.
import { parseUrl, parseTags, normalizeUrl, domainOf, LIMITS } from './lib.js';
import { SyncDataError } from './errors.js';

export const APP_ID = 'important-links-sync';
export const SYNC_SCHEMA = 1;
export const RETENTION_DAYS = 180;
export const RETENTION_MS = RETENTION_DAYS * 86_400_000;
export const MAX_REMOTE_BYTES = 8 * 1024 * 1024;

const MAX_LINKS = 20_000;
const MAX_TOMBSTONES = 50_000;
const MAX_QUARANTINE = 200;
const MAX_QUARANTINE_ENTRY = 5_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const posInt = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const clip = (v, max) => String(v ?? '').trim().slice(0, max);

/* ---------- Validation (cloud content is untrusted) ---------- */

/** Returns a clean link with a stable id, or null if the entry is unusable. */
export function sanitizeSyncLink(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
  const parsed = parseUrl(raw.url);
  if (parsed.error) return null;
  const createdAt = posInt(raw.createdAt);
  const updatedAt = posInt(raw.updatedAt) ?? createdAt;
  if (!createdAt || !updatedAt) return null;
  return {
    id: raw.id,
    title: clip(raw.title, LIMITS.title) || domainOf(parsed.url) || parsed.url,
    url: parsed.url,
    description: clip(raw.description, LIMITS.description),
    category: clip(raw.category, LIMITS.category),
    tags: parseTags(raw.tags),
    favorite: raw.favorite === true,
    createdAt,
    updatedAt,
    openCount: Number.isInteger(raw.openCount) && raw.openCount > 0 ? Math.min(raw.openCount, 1e9) : 0,
    lastOpenedAt: posInt(raw.lastOpenedAt),
  };
}

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates the text of a sync file. Throws SyncDataError('malformed' | 'incompatible').
 * Entries that cannot be understood are kept in `quarantine` so uploading never destroys them.
 */
export function parseRemote(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new SyncDataError('malformed', 'The cloud sync file is empty.');
  if (raw.length > MAX_REMOTE_BYTES) throw new SyncDataError('malformed', 'The cloud sync file is too large.');
  let json;
  try {
    json = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    throw new SyncDataError('malformed', 'The cloud sync file isn’t valid JSON.');
  }
  if (!isPlainObject(json) || json.app !== APP_ID) throw new SyncDataError('malformed', 'That file in Drive isn’t an Important Links sync file.');
  if (!Number.isInteger(json.schema) || json.schema < 1) throw new SyncDataError('malformed', 'The cloud sync file has no valid version.');
  if (json.schema > SYNC_SCHEMA) {
    throw new SyncDataError('incompatible', 'The cloud file was written by a newer version of Important Links. Update the extension on this computer.');
  }
  if (!Array.isArray(json.links) || json.links.length > MAX_LINKS) throw new SyncDataError('malformed', 'The cloud sync file has an invalid link list.');
  if (json.tombstones != null && !isPlainObject(json.tombstones)) throw new SyncDataError('malformed', 'The cloud sync file has invalid deletion records.');
  const rawTombs = Object.entries(json.tombstones ?? {});
  if (rawTombs.length > MAX_TOMBSTONES) throw new SyncDataError('malformed', 'The cloud sync file has too many deletion records.');

  const quarantine = Array.isArray(json.quarantine) ? json.quarantine.slice(0, MAX_QUARANTINE) : [];
  const links = [];
  let skipped = 0;
  for (const entry of json.links) {
    const clean = sanitizeSyncLink(entry);
    if (clean) links.push(clean);
    else {
      skipped++;
      if (quarantine.length < MAX_QUARANTINE && JSON.stringify(entry ?? null).length <= MAX_QUARANTINE_ENTRY) quarantine.push(entry);
    }
  }
  const tombstones = {};
  for (const [id, t] of rawTombs) {
    const deletedAt = posInt(t?.deletedAt);
    if (ID_RE.test(id) && deletedAt) tombstones[id] = { deletedAt };
    else skipped++;
  }
  return {
    links,
    tombstones,
    quarantine,
    skipped,
    revision: Number.isInteger(json.revision) && json.revision >= 0 ? json.revision : 0,
    updatedAt: posInt(json.updatedAt),
    updatedBy: typeof json.updatedBy === 'string' ? json.updatedBy.slice(0, 64) : '',
  };
}

export const emptyRemote = () => ({ links: [], tombstones: {}, quarantine: [], skipped: 0, revision: 0, updatedAt: null, updatedBy: '' });

export function serializeRemote({ revision, updatedBy, links, tombstones, quarantine = [] }, at) {
  const doc = { app: APP_ID, schema: SYNC_SCHEMA, revision, updatedAt: at, updatedBy, links, tombstones };
  if (quarantine.length) doc.quarantine = quarantine;
  return JSON.stringify(doc);
}

/** Splits local links into ones that can sync and ones that cannot (kept locally, untouched). */
export function partitionLocal(links) {
  const valid = [];
  const invalid = [];
  for (const l of links) {
    const clean = sanitizeSyncLink(l);
    if (clean) valid.push(clean);
    else invalid.push(l);
  }
  return { valid, invalid };
}

/* ---------- Merge ---------- */

/** Everything that counts as a user edit. Usage counters are deliberately excluded. */
const fullKey = (l) => JSON.stringify([l.id, l.title, l.url, l.description, l.category, l.tags, l.favorite, l.createdAt, l.updatedAt]);
const contentKey = (l) => JSON.stringify([l.title.toLowerCase(), l.description, l.category.toLowerCase(), [...l.tags].sort()]);

/** Newest updatedAt wins; on equal timestamps the lexicographically larger full record wins (same answer on every device). */
function pickWinner(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return fullKey(a) >= fullKey(b) ? a : b;
}

const maxOrNull = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

function mergeRecord(a, b) {
  const winner = pickWinner(a, b);
  return {
    ...winner,
    createdAt: Math.min(a.createdAt, b.createdAt),
    openCount: Math.max(a.openCount || 0, b.openCount || 0),
    lastOpenedAt: maxOrNull(a.lastOpenedAt, b.lastOpenedAt),
  };
}

/**
 * Merges two datasets { links, tombstones } into one. Pure, deterministic, commutative and idempotent:
 * merge(a, b) equals merge(b, a), and merging the result with either input again changes nothing.
 */
export function mergeData(local, remote, { now = Date.now(), retentionMs = RETENTION_MS } = {}) {
  const tombstones = {};
  for (const src of [local.tombstones, remote.tombstones]) {
    for (const [id, t] of Object.entries(src ?? {})) {
      if (!tombstones[id] || t.deletedAt > tombstones[id].deletedAt) tombstones[id] = { deletedAt: t.deletedAt };
    }
  }

  const byId = new Map();
  for (const l of [...local.links, ...remote.links]) {
    const cur = byId.get(l.id);
    byId.set(l.id, cur ? mergeRecord(cur, l) : l);
  }

  // A tombstone beats a record unless the record was edited after the deletion.
  for (const [id, rec] of [...byId]) {
    const t = tombstones[id];
    if (!t) continue;
    if (t.deletedAt >= rec.updatedAt) byId.delete(id);
    else delete tombstones[id];
  }

  // Secondary duplicate detection: same normalized URL under different ids.
  const warnings = [];
  const byUrl = new Map();
  for (const rec of byId.values()) {
    const key = normalizeUrl(rec.url);
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(rec);
  }
  let collapsed = 0;
  for (const recs of byUrl.values()) {
    if (recs.length < 2) continue;
    const classes = new Map();
    for (const r of recs) {
      const k = contentKey(r);
      if (!classes.has(k)) classes.set(k, []);
      classes.get(k).push(r);
    }
    // Records that say the same thing are one link saved twice: keep the oldest, tombstone the rest.
    for (const members of classes.values()) {
      if (members.length < 2) continue;
      members.sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
      const keep = { ...members[0] };
      for (const dup of members.slice(1)) {
        keep.openCount = Math.max(keep.openCount || 0, dup.openCount || 0);
        keep.lastOpenedAt = maxOrNull(keep.lastOpenedAt, dup.lastOpenedAt);
        keep.favorite = keep.favorite || dup.favorite;
        tombstones[dup.id] = { deletedAt: dup.updatedAt };
        byId.delete(dup.id);
        collapsed++;
      }
      byId.set(keep.id, keep);
    }
    // Same URL but meaningfully different details: keep both and tell the user.
    if (classes.size > 1) warnings.push({ code: 'duplicate-url', url: recs[0].url, ids: recs.map((r) => r.id).sort() });
  }

  for (const [id, t] of Object.entries(tombstones)) {
    if (now - t.deletedAt > retentionMs) delete tombstones[id];
  }

  const links = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return { links, tombstones, warnings, collapsed };
}

/* ---------- Comparison helpers ---------- */

/** Compares links and deletion records, ignoring usage counters. */
export function sameSyncState(a, b) {
  const sig = (d) => JSON.stringify([
    [...d.links].sort((x, y) => (x.id < y.id ? -1 : 1)).map(fullKey),
    Object.entries(d.tombstones ?? {}).sort(([x], [y]) => (x < y ? -1 : 1)).map(([id, t]) => [id, t.deletedAt]),
  ]);
  return sig(a) === sig(b);
}

/** Counts what changes when going from `before` to `after`. */
export function diffLinks(before, after) {
  const prev = new Map(before.map((l) => [l.id, l]));
  const next = new Map(after.map((l) => [l.id, l]));
  let added = 0, updated = 0, deleted = 0;
  for (const [id, l] of next) {
    if (!prev.has(id)) added++;
    else if (fullKey(prev.get(id)) !== fullKey(l)) updated++;
  }
  for (const id of prev.keys()) if (!next.has(id)) deleted++;
  return { added, updated, deleted };
}
