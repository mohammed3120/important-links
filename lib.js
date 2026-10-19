// Pure helpers and storage. No DOM access here.

export const CATEGORIES = ['Work', 'Personal', 'Development', 'Research', 'Shopping', 'Learning', 'Other'];
export const LIMITS = { title: 200, description: 500, category: 40, tag: 30, tags: 10 };

const STORAGE_KEY = 'il_data';
const SCHEMA = 2;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'file:', 'chrome:', 'chrome-extension:', 'edge:', 'about:', 'mailto:']);
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_eid$)/i;

/* ---------- URLs ---------- */

/** Validates user input and returns { url } or { error }. Never prepends https:// to a URL that already has a scheme. */
export function parseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { error: 'Enter a URL.' };
  if (/^(javascript|data|vbscript|blob):/i.test(raw)) return { error: 'This kind of link isn’t supported.' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(mailto|about|chrome|edge|file):/i.test(raw);
  let u;
  try {
    u = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { error: 'That doesn’t look like a valid URL.' };
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) return { error: `Links starting with “${u.protocol}” aren’t supported.` };
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const h = u.hostname;
    const ok = h.includes('.') || h === 'localhost' || h.startsWith('[');
    if (!ok) return { error: 'Add a domain, like example.com.' };
  }
  return { url: u.href };
}

/** Key used to compare URLs: ignores scheme (http/https), www, hash, tracking params, trailing slash. */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href;
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params)}` : '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.port ? `:${u.port}` : ''}${path}${query}`;
  } catch {
    return String(url).trim().toLowerCase();
  }
}

export function domainOf(url) {
  try {
    const u = new URL(url);
    return u.hostname ? u.hostname.replace(/^www\./, '') : u.protocol.replace(':', '');
  } catch {
    return '';
  }
}

export function isWebUrl(url) {
  return /^https?:\/\//i.test(url);
}

/* ---------- Data model ---------- */

export function parseTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;]/);
  const seen = new Set();
  for (const t of list) {
    const tag = String(t).trim().replace(/^#/, '').toLowerCase().slice(0, LIMITS.tag);
    if (tag) seen.add(tag);
  }
  return [...seen].slice(0, LIMITS.tags);
}

export function makeLink(fields) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: '',
    url: '',
    description: '',
    category: '',
    tags: [],
    favorite: false,
    createdAt: now,
    updatedAt: now,
    openCount: 0,
    lastOpenedAt: null,
    ...fields,
  };
}

/** Cleans an untrusted object (import files). Returns a link or null. */
export function sanitizeLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = parseUrl(raw.url);
  if (parsed.error) return null;
  const time = (v) => {
    const t = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(t) && t > 0 ? t : Date.now();
  };
  const created = time(raw.createdAt);
  return makeLink({
    title: String(raw.title ?? '').trim().slice(0, LIMITS.title) || domainOf(parsed.url),
    url: parsed.url,
    description: String(raw.description ?? '').trim().slice(0, LIMITS.description),
    category: String(raw.category ?? '').trim().slice(0, LIMITS.category),
    tags: parseTags(raw.tags),
    favorite: raw.favorite === true || /^(true|yes|1)$/i.test(String(raw.favorite ?? '')),
    createdAt: created,
    updatedAt: raw.updatedAt ? time(raw.updatedAt) : created,
    openCount: Number.isInteger(raw.openCount) && raw.openCount > 0 ? raw.openCount : 0,
  });
}

/* ---------- Storage & migration ---------- */

const defaults = () => ({ schema: SCHEMA, links: [], tombstones: {}, settings: { theme: 'system', sort: 'recent' } });

function readLegacy() {
  try {
    const urls = JSON.parse(localStorage.getItem('array_links_list') || '[]');
    const labels = JSON.parse(localStorage.getItem('array_labels_list') || '[]');
    if (!Array.isArray(urls)) return [];
    const now = Date.now();
    return urls
      .map((u, i) => {
        if (typeof u !== 'string' || !u.trim()) return null;
        const parsed = parseUrl(u);
        const url = parsed.url ?? u.trim(); // keep unusual legacy values rather than lose them
        const label = String(labels[i] ?? '').trim();
        return makeLink({ title: label || domainOf(url) || url, url, createdAt: now - (urls.length - i), updatedAt: now });
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function loadData() {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (stored && Array.isArray(stored.links)) {
    const tombstones = stored.tombstones && typeof stored.tombstones === 'object' && !Array.isArray(stored.tombstones) ? stored.tombstones : {};
    return { ...defaults(), ...stored, tombstones, settings: { ...defaults().settings, ...stored.settings } };
  }
  const data = defaults();
  const legacy = readLegacy();
  if (legacy.length) {
    data.links = legacy;
    await saveData(data); // throws on failure, so old keys are only removed after a successful save
    localStorage.removeItem('array_links_list');
    localStorage.removeItem('array_labels_list');
  }
  return data;
}

export function saveData(data) {
  return chrome.storage.local.set({ [STORAGE_KEY]: data });
}

/* ---------- Deletion records (needed so deletions survive sync) ---------- */

/** Records that a link was deleted. A later edit (updatedAt > deletedAt) can still resurrect it. */
export function addTombstone(data, id, at = Date.now()) {
  data.tombstones[id] = { deletedAt: at };
}

/** Puts links back (undo). Bumps updatedAt past the tombstone so the restore wins when synced. */
export function restoreLinks(data, links, at = Date.now()) {
  for (const link of links) {
    const deletedAt = data.tombstones[link.id]?.deletedAt ?? 0;
    link.updatedAt = Math.max(at, (link.updatedAt || 0) + 1, deletedAt + 1);
    delete data.tombstones[link.id];
  }
}

/* ---------- Export / import ---------- */

const CSV_COLUMNS = ['title', 'url', 'description', 'category', 'tags', 'favorite', 'createdAt'];

export function toJson(links) {
  return JSON.stringify({ app: 'important-links', version: SCHEMA, exportedAt: new Date().toISOString(), links }, null, 2);
}

export function toCsv(links) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // prevents spreadsheet formula execution
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = links.map((l) => [l.title, l.url, l.description, l.category, l.tags.join(';'), l.favorite, new Date(l.createdAt).toISOString()]);
  return [CSV_COLUMNS, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

function parseCsvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Parses a JSON or CSV export. Returns { links, skipped } or throws Error with a friendly message. */
export function parseImport(text, filename = '') {
  const clean = text.replace(/^\uFEFF/, '');
  let items;
  if (/\.csv$/i.test(filename) || !/^\s*[[{]/.test(clean)) {
    const [header, ...rows] = parseCsvRows(clean);
    if (!header) throw new Error('The file is empty.');
    const cols = header.map((h) => h.trim().toLowerCase());
    if (!cols.includes('url')) throw new Error('This CSV needs a “url” column.');
    items = rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').replace(/^'(?=[=+\-@])/, '')])));
  } else {
    let json;
    try { json = JSON.parse(clean); } catch { throw new Error('This file isn’t valid JSON.'); }
    items = Array.isArray(json) ? json : json?.links;
    if (!Array.isArray(items)) throw new Error('No links found in this file.');
  }
  const links = items.map(sanitizeLink).filter(Boolean);
  if (!links.length) throw new Error('No valid links found in this file.');
  return { links, skipped: items.length - links.length };
}
