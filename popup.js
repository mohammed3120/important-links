import {
  CATEGORIES, LIMITS, parseUrl, normalizeUrl, domainOf, isWebUrl, parseTags, makeLink,
  loadData, saveData, toJson, toCsv, parseImport, addTombstone, restoreLinks,
} from './lib.js';
import { initSyncUI, notifyDataChanged, notifyOpened } from './sync-ui.js';

/* ---------- Small DOM helpers (no innerHTML anywhere: user data is only ever set as text) ---------- */

const $ = (sel) => document.querySelector(sel);
const NS = 'http://www.w3.org/2000/svg';

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.filter((k) => k != null && k !== false));
  return el;
}

const ICONS = {
  search: ['c11,11,7', 'M20 20l-3.5-3.5'],
  settings: ['M4 7h9', 'M17 7h3', 'c15,7,2', 'M4 17h3', 'M11 17h9', 'c9,17,2'],
  plus: ['M12 5v14', 'M5 12h14'],
  tab: ['M4 5h16v14H4z', 'M4 9h16'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  star: ['M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  here: ['M5 12h12', 'M13 7l5 5-5 5'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  trash: ['M5 7h14', 'M10 7V4h4v3', 'M7 7l1 13h8l1-13'],
  bookmark: ['M6 4h12v16l-6-4-6 4z'],
};

function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  for (const part of ICONS[name]) {
    let node;
    if (part.startsWith('c')) {
      const [cx, cy, r] = part.slice(1).split(',');
      node = document.createElementNS(NS, 'circle');
      node.setAttribute('cx', cx); node.setAttribute('cy', cy); node.setAttribute('r', r);
    } else {
      node = document.createElementNS(NS, 'path');
      node.setAttribute('d', part);
    }
    svg.append(node);
  }
  return svg;
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion ? 0 : ms));

/* ---------- State ---------- */

const state = { data: null, query: '', fav: false, category: '', tag: '', enterId: null };
let editingId = null;
let syncUI = null;

const els = {
  list: $('#list'), filters: $('#filters'), count: $('#count'), search: $('#search'), sort: $('#sort'),
  toasts: $('#toasts'), edit: $('#dlg-edit'), confirm: $('#dlg-confirm'), settings: $('#dlg-settings'), file: $('#file'),
  f: { title: $('#f-title'), url: $('#f-url'), desc: $('#f-desc'), cat: $('#f-cat'), tags: $('#f-tags'), fav: $('#f-fav') },
};

/* ---------- Persistence ---------- */

/** Applies a change, saves it, and rolls back if storage fails. */
async function commit(mutate, okMessage) {
  // Start from the freshest stored copy: the sync worker may have merged cloud changes since the last render.
  try { state.data = await loadData(); } catch { /* keep the in-memory copy */ }
  const snapshot = structuredClone(state.data);
  mutate();
  try {
    await saveData(state.data);
  } catch {
    state.data = snapshot;
    render();
    toast('Couldn’t save your changes. Storage may be full or unavailable.', { kind: 'error' });
    return false;
  }
  render();
  if (linksChanged(snapshot, state.data)) notifyDataChanged();
  if (okMessage) toast(okMessage);
  return true;
}

const linksChanged = (a, b) => JSON.stringify([a.links, a.tombstones]) !== JSON.stringify([b.links, b.tombstones]);

/* ---------- Toasts & confirm dialog ---------- */

function toast(message, { kind = '', action = null, ms } = {}) {
  while (els.toasts.children.length >= 3) els.toasts.firstChild.remove();
  const el = h('div', { class: `toast ${kind}` }, h('span', { text: message }));
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 160); };
  if (action) el.append(h('button', { type: 'button', text: action.label, on: { click: () => { action.run(); dismiss(); } } }));
  els.toasts.append(el);
  setTimeout(dismiss, ms ?? (action ? 7000 : 3500));
}

/** Resolves with the key of the pressed button, or 'cancel' if dismissed with Esc. First button gets focus, so put the safe one first. */
function ask({ title, body, buttons }) {
  return new Promise((resolve) => {
    let result = 'cancel';
    $('#confirm-heading').textContent = title;
    $('#confirm-body').textContent = body;
    $('#confirm-actions').replaceChildren(...buttons.map((b) => h('button', {
      type: 'button', class: `btn ${b.kind ?? ''}`, text: b.label,
      on: { click: () => { result = b.key; els.confirm.close(); } },
    })));
    els.confirm.addEventListener('close', () => resolve(result), { once: true });
    els.confirm.showModal();
  });
}

/* ---------- Filtering & sorting ---------- */

const SORTERS = {
  recent: (a, b) => b.createdAt - a.createdAt,
  oldest: (a, b) => a.createdAt - b.createdAt,
  alpha: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  used: (a, b) => (b.openCount || 0) - (a.openCount || 0) || b.createdAt - a.createdAt,
};

function visibleLinks() {
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const sorter = SORTERS[state.data.settings.sort] ?? SORTERS.recent;
  return state.data.links
    .filter((l) => {
      if (state.fav && !l.favorite) return false;
      if (state.category && l.category !== state.category) return false;
      if (state.tag && !l.tags.includes(state.tag)) return false;
      if (!terms.length) return true;
      const hay = [l.title, l.url, l.description, l.category, ...l.tags].join('\n').toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || sorter(a, b));
}

/* ---------- Rendering ---------- */

function render() {
  if (!state.data) return;
  const total = state.data.links.length;
  const shown = visibleLinks();
  els.count.textContent = shown.length === total ? `${total} saved link${total === 1 ? '' : 's'}` : `${shown.length} of ${total} links`;
  renderFilters();
  renderList(shown, total);
}

function chip(label, pressed, onClick) {
  return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(pressed), text: label, on: { click: onClick } });
}

function renderFilters() {
  const links = state.data.links;
  const cats = [...new Set(links.map((l) => l.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const nodes = [];
  if (links.length) {
    const none = !state.fav && !state.category && !state.tag;
    nodes.push(chip('All', none, () => { state.fav = false; state.category = ''; state.tag = ''; render(); }));
    if (links.some((l) => l.favorite)) nodes.push(chip('Pinned', state.fav, () => { state.fav = !state.fav; render(); }));
    for (const c of cats) nodes.push(chip(c, state.category === c, () => { state.category = state.category === c ? '' : c; render(); }));
    if (state.tag) nodes.push(chip(`#${state.tag}  ×`, true, () => { state.tag = ''; render(); }));
  }
  els.filters.replaceChildren(...nodes);
  els.filters.hidden = !nodes.length;
}

function emptyState({ title, text, buttons }) {
  return h('div', { class: 'empty' },
    h('span', { class: 'art' }, icon('bookmark')),
    h('h2', { text: title }),
    h('p', { text }),
    buttons.length ? h('div', { class: 'btn-row' }, ...buttons) : null);
}

function renderList(shown, total) {
  if (!total) {
    els.list.replaceChildren(emptyState({
      title: 'No important links yet',
      text: 'Save the page you’re on, or add a link by hand. Everything stays in this browser.',
      buttons: [
        h('button', { type: 'button', class: 'btn primary', text: 'Save current tab', on: { click: saveCurrentTab } }),
        h('button', { type: 'button', class: 'btn', text: 'Add a link', on: { click: () => openEditor() } }),
      ],
    }));
    return;
  }
  if (!shown.length) {
    const searching = Boolean(state.query.trim());
    els.list.replaceChildren(emptyState({
      title: searching ? `No matches for “${state.query.trim().slice(0, 40)}”` : 'Nothing in this view',
      text: searching ? 'Try a different word, or search by domain or tag.' : 'No saved links match the current filter.',
      buttons: [h('button', { type: 'button', class: 'btn', text: 'Clear search and filters', on: { click: clearFilters } })],
    }));
    return;
  }
  els.list.replaceChildren(...shown.map(cardFor));
  state.enterId = null;
}

function clearFilters() {
  state.query = ''; state.fav = false; state.category = ''; state.tag = '';
  els.search.value = '';
  render();
}

function favicon(link) {
  const letter = (domainOf(link.url) || link.title || '?').charAt(0).toUpperCase();
  const box = h('span', { class: 'fav', 'aria-hidden': 'true', text: letter });
  if (isWebUrl(link.url)) {
    const src = new URL(chrome.runtime.getURL('/_favicon/'));
    src.searchParams.set('pageUrl', link.url);
    src.searchParams.set('size', '32');
    const img = h('img', { src: src.href, alt: '', loading: 'lazy', width: '20', height: '20' });
    img.addEventListener('load', () => box.replaceChildren(img));
  }
  return box;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateFmtYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const formatDate = (t) => (new Date(t).getFullYear() === new Date().getFullYear() ? dateFmt : dateFmtYear).format(t);

function tool(name, label, onClick, extra = '') {
  return h('button', { type: 'button', class: `icon-btn ${extra}`, 'aria-label': label, title: label, on: { click: onClick } }, icon(name));
}

function cardFor(link) {
  const openTab = (e) => { e.preventDefault(); openLink(link, 'tab'); };
  const title = h('a', {
    class: 'title', text: link.title, title: link.url,
    href: isWebUrl(link.url) ? link.url : null, role: isWebUrl(link.url) ? null : 'link', tabindex: '0',
    on: { click: openTab, auxclick: (e) => { if (e.button === 1) openTab(e); }, keydown: (e) => { if (e.key === 'Enter') openTab(e); } },
  });
  const pin = tool('star', link.favorite ? 'Unpin' : 'Pin to top', () => toggleFavorite(link), 'pin');
  pin.setAttribute('aria-pressed', String(link.favorite));
  const chips = [];
  if (link.category) chips.push(h('button', { type: 'button', class: 'tag cat', text: link.category, title: 'Filter by category', on: { click: () => { state.category = link.category; render(); } } }));
  for (const t of link.tags) chips.push(h('button', { type: 'button', class: 'tag', text: `#${t}`, title: 'Filter by tag', on: { click: () => { state.tag = t; render(); } } }));

  const card = h('article', { class: `card${link.favorite ? ' pinned' : ''}${state.enterId === link.id ? ' enter' : ''}`, 'data-id': link.id },
    favicon(link),
    h('div', { class: 'body' },
      title,
      h('div', { class: 'meta' }, h('span', { class: 'dom', text: domainOf(link.url) || link.url }), h('time', { datetime: new Date(link.createdAt).toISOString(), text: formatDate(link.createdAt) })),
      link.description ? h('p', { class: 'desc', text: link.description }) : null,
      chips.length ? h('div', { class: 'tags' }, ...chips) : null),
    h('div', { class: 'tools' },
      h('div', { class: 'extras' },
        tool('copy', 'Copy URL', () => copyUrl(link)),
        tool('here', 'Open in this tab', () => openLink(link, 'here')),
        tool('edit', 'Edit', () => openEditor({ link })),
        tool('trash', 'Delete', () => deleteLink(link, card), 'del')),
      pin));
  return card;
}

/* ---------- Link actions ---------- */

async function openLink(link, mode) {
  try {
    if (mode === 'here') await chrome.tabs.update({ url: link.url });
    else await chrome.tabs.create({ url: link.url });
  } catch {
    toast('Chrome couldn’t open this link.', { kind: 'error' });
    return;
  }
  await recordOpen(link.id);
  if (mode === 'here') window.close();
}

/** Usage counters are best-effort and deliberately don't count as an edit, so opening a link never triggers a sync. */
async function recordOpen(id) {
  try {
    const data = await loadData();
    const l = data.links.find((x) => x.id === id);
    if (!l) return;
    l.openCount = (l.openCount || 0) + 1;
    l.lastOpenedAt = Date.now();
    await saveData(data);
  } catch { /* ignore */ }
}

async function copyUrl(link) {
  try {
    await navigator.clipboard.writeText(link.url);
    toast('URL copied');
  } catch {
    toast('Couldn’t copy. Clipboard access was blocked.', { kind: 'error' });
  }
}

function toggleFavorite(link) {
  commit(() => {
    const l = state.data.links.find((x) => x.id === link.id);
    if (l) { l.favorite = !l.favorite; l.updatedAt = Date.now(); }
  });
}

async function deleteLink(link, card) {
  card.classList.add('leave');
  await wait(160);
  let removed, index;
  const ok = await commit(() => {
    index = state.data.links.findIndex((x) => x.id === link.id);
    if (index < 0) return; // already removed by a sync
    [removed] = state.data.links.splice(index, 1);
    addTombstone(state.data, removed.id); // so the deletion reaches your other computers
  });
  if (!ok || !removed) return;
  toast('Link deleted', {
    action: {
      label: 'Undo',
      run: () => commit(() => {
        restoreLinks(state.data, [removed]);
        state.data.links.splice(Math.min(index, state.data.links.length), 0, removed);
      }, 'Link restored'),
    },
  });
}

/* ---------- Add / edit dialog ---------- */

function setError(input, message) {
  const p = $(`#e-${input.id.slice(2)}`);
  p.hidden = !message;
  p.textContent = message ?? '';
  input.setAttribute('aria-invalid', String(Boolean(message)));
}

function openEditor({ link = null, prefill = {} } = {}) {
  const f = els.f;
  editingId = link?.id ?? null;
  $('#edit-heading').textContent = link ? 'Edit link' : 'Add link';
  const src = link ?? prefill;
  f.title.value = src.title ?? '';
  f.url.value = src.url ?? '';
  f.desc.value = src.description ?? '';
  f.cat.value = src.category ?? '';
  f.tags.value = (src.tags ?? []).join(', ');
  f.fav.checked = Boolean(src.favorite);
  setError(f.title, null); setError(f.url, null);
  const custom = state.data.links.map((l) => l.category).filter(Boolean);
  $('#cat-list').replaceChildren(...[...new Set([...CATEGORIES, ...custom])].map((c) => h('option', { value: c })));
  els.edit.showModal();
  (prefill.url ? f.title : f.url).focus();
  if (prefill.url) f.title.select();
}

async function onEditSubmit(e) {
  e.preventDefault();
  const f = els.f;
  const title = f.title.value.trim();
  const parsed = parseUrl(f.url.value);
  setError(f.title, title ? null : 'Add a title.');
  setError(f.url, parsed.error ?? null);
  if (!title) return f.title.focus();
  if (parsed.error) return f.url.focus();

  const fields = {
    title: title.slice(0, LIMITS.title),
    url: parsed.url,
    description: f.desc.value.trim().slice(0, LIMITS.description),
    category: f.cat.value.trim().slice(0, LIMITS.category),
    tags: parseTags(f.tags.value),
    favorite: f.fav.checked,
  };

  const key = normalizeUrl(parsed.url);
  const dup = state.data.links.find((l) => l.id !== editingId && normalizeUrl(l.url) === key);
  if (dup) {
    const choice = await ask({
      title: 'Already saved',
      body: `“${dup.title}” already uses this address.`,
      buttons: [
        { key: 'cancel', label: 'Cancel' },
        { key: 'open', label: 'Open existing' },
        { key: 'edit', label: 'Edit existing' },
        { key: 'anyway', label: 'Save anyway', kind: 'primary' },
      ],
    });
    if (choice === 'open') return openLink(dup, 'tab');
    if (choice === 'edit') { els.edit.close(); return openEditor({ link: dup }); }
    if (choice !== 'anyway') return;
  }

  const id = editingId ?? crypto.randomUUID();
  const ok = await commit(() => {
    const existing = state.data.links.find((l) => l.id === editingId);
    if (existing) Object.assign(existing, fields, { updatedAt: Date.now() });
    else state.data.links.push(makeLink({ id, ...fields }));
  }, editingId ? 'Link updated' : 'Link saved');
  if (!ok) return;
  if (!editingId) state.enterId = id;
  els.edit.close();
  render();
}

async function saveCurrentTab() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { /* handled below */ }
  if (!tab?.url) {
    toast('Chrome doesn’t let extensions read this page. Use “Add link” and paste the address.', { kind: 'error', ms: 6000 });
    return;
  }
  const parsed = parseUrl(tab.url);
  if (parsed.error) {
    toast('This page can’t be saved as a link.', { kind: 'error' });
    return;
  }
  openEditor({ prefill: { title: (tab.title || domainOf(parsed.url)).trim(), url: parsed.url } });
}

/* ---------- Settings, export, import ---------- */

function applyTheme() {
  const theme = state.data?.settings.theme ?? 'system';
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h('a', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportAs(kind) {
  if (!state.data.links.length) return toast('There are no links to export yet.');
  const day = new Date().toISOString().slice(0, 10);
  if (kind === 'json') download(`important-links-${day}.json`, toJson(state.data.links), 'application/json');
  else download(`important-links-${day}.csv`, toCsv(state.data.links), 'text/csv');
  toast('Export ready. Check your downloads.');
}

const IN_TAB = new URLSearchParams(location.search).has('tab');

/** Chrome closes toolbar popups when a file picker opens, so the picker only works from a full tab. */
async function importClick() {
  if (IN_TAB) return els.file.click();
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1&import=1') });
    window.close();
  } catch {
    toast('Couldn’t open the import page.', { kind: 'error' });
  }
}

async function onImportFile() {
  const file = els.file.files[0];
  els.file.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return toast('That file is too large (5 MB max).', { kind: 'error' });
  let parsed;
  try {
    parsed = parseImport(await file.text(), file.name);
  } catch (err) {
    return toast(err.message, { kind: 'error' });
  }
  const known = new Set(state.data.links.map((l) => normalizeUrl(l.url)));
  const fresh = [];
  let dupes = 0;
  for (const l of parsed.links) {
    const k = normalizeUrl(l.url);
    if (known.has(k)) dupes++; else { known.add(k); fresh.push(l); }
  }
  const skipped = parsed.skipped ? ` ${parsed.skipped} invalid entr${parsed.skipped === 1 ? 'y was' : 'ies were'} skipped.` : '';
  const choice = await ask({
    title: 'Import links',
    body: `${fresh.length} new, ${dupes} already saved.${skipped} Merge keeps everything you have. Replace swaps your ${state.data.links.length} current links for the file’s (you can undo right after).`,
    buttons: [
      { key: 'cancel', label: 'Cancel' },
      { key: 'replace', label: 'Replace', kind: 'danger' },
      { key: 'merge', label: `Merge ${fresh.length} new`, kind: 'primary' },
    ],
  });
  if (choice === 'merge') {
    if (await commit(() => state.data.links.push(...fresh), `Imported ${fresh.length} link${fresh.length === 1 ? '' : 's'}`)) els.settings.close();
  } else if (choice === 'replace') {
    let before = [];
    const unique = [...new Map(parsed.links.map((l) => [normalizeUrl(l.url), l])).values()];
    const replaced = await commit(() => {
      before = structuredClone(state.data.links);
      for (const l of before) addTombstone(state.data, l.id);
      state.data.links = unique;
    });
    if (replaced) {
      els.settings.close();
      toast(`Replaced with ${unique.length} links`, {
        action: {
          label: 'Undo',
          run: () => commit(() => {
            for (const l of unique) addTombstone(state.data, l.id);
            restoreLinks(state.data, before);
            state.data.links = before;
          }, 'Previous links restored'),
        },
      });
    }
  }
}

async function clearAll() {
  const n = state.data.links.length;
  if (!n) return toast('There’s nothing to clear.');
  const choice = await ask({
    title: `Delete all ${n} links?`,
    body: 'This removes every saved link from this browser. Export first if you want a backup.',
    buttons: [{ key: 'cancel', label: 'Keep my links' }, { key: 'delete', label: 'Delete all', kind: 'danger' }],
  });
  if (choice !== 'delete') return;
  let before = [];
  const cleared = await commit(() => {
    before = structuredClone(state.data.links);
    for (const l of before) addTombstone(state.data, l.id);
    state.data.links = [];
  });
  if (cleared) {
    els.settings.close();
    clearFilters();
    toast('All links deleted', {
      ms: 9000,
      action: { label: 'Undo', run: () => commit(() => { restoreLinks(state.data, before); state.data.links = before; }, 'Links restored') },
    });
  }
}

function openSettings() {
  syncUI?.refresh();
  document.querySelector(`input[name="theme"][value="${state.data.settings.theme}"]`).checked = true;
  $('#version').textContent = chrome.runtime.getManifest().version;
  els.settings.showModal();
}

/* ---------- Wiring (each listener is registered exactly once) ---------- */

function bind() {
  document.querySelectorAll('[data-icon]').forEach((el) => el.prepend(icon(el.dataset.icon)));
  const mac = /mac/i.test(navigator.platform);
  $('#kbd').textContent = mac ? '⌘K' : 'Ctrl K';

  els.search.addEventListener('input', () => { state.query = els.search.value; render(); });
  els.search.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (els.search.value) { e.preventDefault(); els.search.value = ''; state.query = ''; render(); } else els.search.blur();
  });
  els.sort.addEventListener('change', () => commit(() => { state.data.settings.sort = els.sort.value; }));

  $('#btn-save-tab').addEventListener('click', saveCurrentTab);
  $('#btn-add').addEventListener('click', () => openEditor());
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => els.settings.close());
  $('#form-edit').addEventListener('submit', onEditSubmit);
  $('#edit-cancel').addEventListener('click', () => els.edit.close());
  els.f.title.addEventListener('input', () => setError(els.f.title, null));
  els.f.url.addEventListener('input', () => setError(els.f.url, null));

  document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => {
    commit(() => { state.data.settings.theme = r.value; }).then(applyTheme);
  }));
  $('#exp-json').addEventListener('click', () => exportAs('json'));
  $('#exp-csv').addEventListener('click', () => exportAs('csv'));
  $('#imp').addEventListener('click', importClick);
  els.file.addEventListener('change', onImportFile);
  $('#clear-all').addEventListener('click', clearAll);

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
      e.preventDefault();
      els.search.focus();
      els.search.select();
    }
  });
}

async function init() {
  bind();
  try {
    state.data = await loadData();
  } catch {
    els.count.textContent = 'Unavailable';
    els.list.replaceChildren(emptyState({
      title: 'Couldn’t load your links',
      text: 'Chrome’s storage didn’t respond. Your links haven’t been changed. Close and reopen this popup to try again.',
      buttons: [],
    }));
    document.querySelectorAll('.actions .btn, #btn-settings, #search, #sort').forEach((el) => { el.disabled = true; });
    return;
  }
  if (IN_TAB) document.body.classList.add('tab');
  applyTheme();
  els.sort.value = state.data.settings.sort;
  render();

  syncUI = initSyncUI({
    $, h, toast, ask, inTab: IN_TAB, getLinks: () => state.data.links, download,
    openInTab: () => { chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1&settings=1') }); window.close(); },
  });
  // The sync worker can change stored links while this view is open: follow along.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.il_data?.newValue || !state.data) return;
    if (JSON.stringify(changes.il_data.newValue) === JSON.stringify(state.data)) return;
    try { state.data = await loadData(); applyTheme(); render(); } catch { /* next change will retry */ }
  });
  notifyOpened();

  const params = new URLSearchParams(location.search);
  if (IN_TAB && params.has('settings')) openSettings();
  if (IN_TAB && params.has('import')) {
    openSettings();
    $('#imp').focus();
    toast('Click “Import…” to choose your JSON or CSV file.', { ms: 6000 });
  }
}

init();
