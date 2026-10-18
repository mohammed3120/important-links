// Settings UI for Google Drive sync. All real work happens in the service worker; this only sends messages and paints status.
import { computeStatus } from './sync-status.js';
import { toJson } from './lib.js';
import { parseClientJson } from './oauth-store.js';
import { pickDirectory, folderPickerSupported, requestAccess } from './folder.js';

const SYNC_KEY = 'il_sync';
const VAULT_KEY = 'il_oauth';
const DEFAULT_FILE = 'important-links-sync.json';

async function rpc(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('The background service didn’t respond. Please try again.');
  if (!res.ok) {
    const err = new Error(res.error?.message || 'Something went wrong.');
    err.code = res.error?.code;
    throw err;
  }
  return res;
}

export function notifyDataChanged() {
  try { chrome.runtime.sendMessage({ type: 'sync:dataChanged' }).catch(() => {}); } catch { /* worker unavailable: sync happens later */ }
}
export function notifyOpened() {
  try { chrome.runtime.sendMessage({ type: 'sync:opened' }).catch(() => {}); } catch { /* ignore */ }
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function initSyncUI({ $, h, toast, ask, inTab, openInTab, getLinks, download }) {
  const el = {
    box: $('#sync-statusbox'), status: $('#sync-status'), detail: $('#sync-detail'), account: $('#sync-account'),
    connect: $('#sync-connect'), disconnect: $('#sync-disconnect'), folderName: $('#sync-folder-name'), folderId: $('#sync-folder-id'),
    pick: $('#sync-pick'), file: $('#sync-file'), auto: $('#sync-auto'), now: $('#sync-now'),
    last: $('#sync-last'), result: $('#sync-result'), warnings: $('#sync-warnings'),
    modes: [...document.querySelectorAll('input[name="sync-mode"]')], modeHint: $('#sync-mode-hint'), folderLabel: $('#sync-folder-label'),
    backupDest: $('#sync-backup-dest'), backupLast: $('#sync-backup-last'),
  };
  const gc = {
    box: $('#gc-client'), form: $('#gc-form'), source: $('#gc-source'), id: $('#gc-id'), secret: $('#gc-secret'), pass: $('#gc-pass'),
    show: $('#gc-show'), redirect: $('#gc-redirect'), copy: $('#gc-copy'), save: $('#gc-save'), remove: $('#gc-remove'),
    import: $('#gc-import'), file: $('#gc-file'), unlockRow: $('#gc-unlockrow'), unlockPass: $('#gc-unlock-pass'), unlock: $('#gc-unlock'), lock: $('#gc-lock'),
  };
  let client = { source: null, configured: true, clientId: '', protected: false, locked: false, redirectUri: '' };
  let config = { mode: 'folder', connected: false, fileName: DEFAULT_FILE, auto: true };
  let warnedAccess = false;
  let busy = false;

  const fail = (err, ms = 7000) => toast(err?.message || 'Something went wrong.', { kind: 'error', ms });
  const day = () => new Date().toISOString().slice(0, 10);

  /* ---------- Painting ---------- */

  const HINTS = {
    folder: 'Saves one file in a folder that your Google Drive app (Drive for desktop, rclone, Insync…) keeps in sync. No Google account setup needed.',
    drive: 'Talks to Google Drive directly. Requires your own Google Cloud OAuth client (advanced): enter it under “Google Cloud client” below. See docs/SYNC.md.',
  };

  function paint() {
    const folderMode = config.mode === 'folder';
    const st = computeStatus(config, { clientConfigured: client.configured, locked: client.locked });
    const ready = config.connected && !config.needsAuth;
    el.box.dataset.state = st.state;
    el.status.textContent = config.syncing || busy ? 'Synchronizing…' : st.label;
    el.detail.textContent = st.detail ?? '';
    el.detail.hidden = !st.detail;
    for (const r of el.modes) { r.checked = r.value === config.mode; r.disabled = config.connected || busy; }
    el.modeHint.textContent = HINTS[folderMode ? 'folder' : 'drive'];
    el.folderLabel.textContent = folderMode ? 'Sync folder' : 'Drive folder';
    el.account.textContent = !folderMode && config.connected && config.account?.email ? `Signed in as ${config.account.email}` : '';
    el.connect.hidden = folderMode || (config.connected && !config.needsAuth);
    el.connect.textContent = config.needsAuth ? 'Reconnect Google Drive' : 'Connect Google Drive';
    el.connect.disabled = busy;
    el.disconnect.hidden = !config.connected;
    el.disconnect.textContent = folderMode ? 'Stop syncing' : 'Disconnect';
    el.folderName.textContent = config.folder?.name ?? 'No folder selected';
    el.folderId.textContent = config.folder?.id ?? '';
    el.folderId.hidden = folderMode || !config.folder;
    el.pick.disabled = folderMode ? busy : (!ready || busy);
    el.pick.textContent = folderMode && config.needsAuth ? 'Allow folder access' : (config.folder ? 'Change…' : 'Choose folder…');
    if (document.activeElement !== el.file) el.file.value = config.fileName ?? DEFAULT_FILE;
    el.file.disabled = !ready || busy;
    el.auto.checked = config.auto !== false;
    el.auto.disabled = !config.connected;
    el.now.disabled = busy || !ready || !config.folder || !config.confirmed || Boolean(config.syncing);
    el.now.textContent = config.syncing || busy ? 'Syncing…' : 'Sync now';
    el.last.textContent = config.lastSyncAt ? `Last successful sync: ${when.format(config.lastSyncAt)}` : (config.connected ? 'Not synced yet' : '');
    const r = config.lastResult;
    el.result.textContent = r ? `${plural(r.added, 'link')} added · ${r.updated} updated · ${plural(r.deleted, 'deletion')} synced${r.uploaded ? ' · file updated' : ''}` : '';
    el.warnings.replaceChildren(...(config.warnings ?? []).map((w) => h('li', { text: w.message })));
    el.warnings.hidden = !(config.warnings ?? []).length;
    paintClient(folderMode);
    if (folderMode && config.needsAuth && !warnedAccess) {
      warnedAccess = true;
      toast('Sync is paused: open Settings and choose “Allow folder access”.', { kind: 'error', ms: 8000 });
    }
  }

  function paintClient(folderMode) {
    const custom = client.source === 'custom';
    const locked = custom && client.protected && client.locked;
    const frozen = !folderMode && config.connected; // changing the client while connected would orphan its tokens
    gc.box.hidden = folderMode;
    gc.source.textContent = custom
      ? `Using your own client: ${client.clientId}${client.protected ? (client.locked ? ' (locked)' : ' (passphrase-protected)') : ''}`
      : client.source === 'manifest' ? 'Using a client ID built into this copy of the extension. Save your own here to override it.' : 'No Google client set up yet.';
    if (document.activeElement !== gc.id) gc.id.value = custom ? client.clientId : gc.id.value;
    gc.secret.placeholder = custom ? '•••••••• saved. Re-enter to update' : 'GOCSPX-…';
    gc.redirect.textContent = client.redirectUri || 'Available after the extension loads';
    for (const f of [gc.id, gc.secret, gc.pass, gc.save]) f.disabled = frozen || busy;
    gc.save.textContent = custom ? 'Update client' : 'Save client';
    gc.remove.hidden = !custom;
    gc.remove.disabled = frozen || busy;
    gc.unlockRow.hidden = !locked;
    gc.lock.hidden = !(custom && client.protected && !client.locked);
    if (frozen) gc.source.textContent += '. Disconnect to change it.';
  }

  async function refreshClient() {
    try { client = (await rpc('sync:clientInfo')).client; } catch { /* keep the last known state */ }
    paint();
  }

  async function refresh() {
    const stored = (await chrome.storage.local.get(SYNC_KEY))[SYNC_KEY];
    config = { mode: 'folder', connected: false, fileName: DEFAULT_FILE, auto: true, ...stored };
    await refreshClient();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[VAULT_KEY]) refreshClient();
    if (!changes[SYNC_KEY]) return;
    config = { mode: 'folder', connected: false, fileName: DEFAULT_FILE, auto: true, ...changes[SYNC_KEY].newValue };
    paint();
  });

  /* ---------- Actions ---------- */

  async function withBusy(fn) {
    busy = true; paint();
    try { return await fn(); } finally { busy = false; paint(); }
  }

  async function connect() {
    if (!client.configured) {
      gc.box.open = true; gc.id.focus();
      toast('Add your Google Cloud client ID first, or switch Method to “Synced folder” (no Google Cloud needed).', { kind: 'error', ms: 9000 });
      return;
    }
    if (client.locked) {
      gc.box.open = true; gc.unlockPass.focus();
      toast('Enter your passphrase to unlock Google access first.', { kind: 'error' });
      return;
    }
    if (!inTab) { // Chrome closes the popup when Google's sign-in window takes focus, so do this in a full tab
      toast('Opening a full page for Google sign-in…');
      openInTab();
      return;
    }
    try {
      await withBusy(() => rpc('sync:connect'));
      toast('Connected to Google Drive');
    } catch (err) {
      if (err.code === 'cancelled') toast('Sign-in cancelled.');
      else fail(err);
      return;
    }
    await refresh();
    if (!config.folder) await chooseFolder();
  }

  async function disconnect() {
    const unsynced = config.dirty;
    const choice = await ask({
      title: unsynced ? 'You have unsynced changes' : (config.mode === 'folder' ? 'Stop syncing?' : 'Disconnect Google Drive?'),
      body: unsynced
        ? 'Some changes haven’t been uploaded yet. If you disconnect now they will exist only on this computer until you reconnect and sync.'
        : (config.mode === 'folder'
          ? 'Your links stay on this computer and the sync file stays in the folder. Syncing stops until you choose a folder again.'
          : 'Your links stay on this computer and in Drive. Syncing stops until you reconnect, and Google access for this extension is revoked.'),
      buttons: unsynced
        ? [{ key: 'cancel', label: 'Stay connected' }, { key: 'sync', label: 'Sync first' }, { key: 'go', label: 'Disconnect anyway', kind: 'danger' }]
        : [{ key: 'cancel', label: 'Stay connected' }, { key: 'go', label: 'Disconnect', kind: 'danger' }],
    });
    if (choice === 'cancel') return;
    if (choice === 'sync' && !(await syncNow({ quiet: true }))) return;
    try {
      await withBusy(() => rpc('sync:disconnect'));
      toast(config.mode === 'folder' ? 'Sync stopped' : 'Disconnected from Google Drive');
    } catch (err) { fail(err); }
  }

  async function saveClient(e) {
    e.preventDefault();
    try {
      const res = await withBusy(() => rpc('sync:saveClient', { clientId: gc.id.value, clientSecret: gc.secret.value, passphrase: gc.pass.value }));
      client = res.client;
      gc.secret.value = ''; gc.pass.value = ''; gc.secret.type = 'password'; gc.show.textContent = 'Show'; gc.show.setAttribute('aria-pressed', 'false');
      toast('Google client saved on this computer. You can connect now.');
    } catch (err) { fail(err); }
    paint();
  }

  async function removeClient() {
    const choice = await ask({
      title: 'Remove Google client?',
      body: 'This deletes the client ID, secret and Google access stored on this computer. Your links and the file in Drive stay. You can add the client again later.',
      buttons: [{ key: 'cancel', label: 'Keep it' }, { key: 'go', label: 'Remove', kind: 'danger' }],
    });
    if (choice !== 'go') return;
    try {
      client = (await withBusy(() => rpc('sync:removeClient'))).client;
      gc.id.value = ''; gc.secret.value = ''; gc.pass.value = '';
      toast('Google client removed');
    } catch (err) { fail(err); }
    paint();
  }

  async function unlockClient() {
    try {
      client = (await withBusy(() => rpc('sync:unlock', { passphrase: gc.unlockPass.value }))).client;
      gc.unlockPass.value = '';
      toast('Unlocked. Sync will resume.');
    } catch (err) { fail(err); gc.unlockPass.select(); }
    paint();
  }

  /** Returns true on success. */
  async function syncNow({ quiet = false } = {}) {
    try {
      const { result } = await withBusy(() => rpc('sync:now'));
      if (result?.status === 'busy') { toast('A sync is already running.'); return false; }
      if (!quiet) toast(`Synced. ${plural(result.added, 'link')} added, ${result.updated} updated, ${plural(result.deleted, 'deletion')}.`);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  function previewText(p, unsynced) {
    const lines = [
      `Folder: ${p.folder.name}`,
      `File: ${p.fileName} (${p.remoteExists ? `found, ${plural(p.remoteCount, 'link')}` : 'not there yet, it will be created'})`,
      `This computer: ${plural(p.localCount, 'link')}`,
      `After merging: ${plural(p.mergedCount, 'link')}`,
      '',
      `From the sync file: ${p.pull.added} new, ${p.pull.updated} updated, ${p.pull.deleted} removed here`,
      `To the sync file: ${p.push.added} new, ${p.push.updated} updated, ${p.push.deleted} removed there`,
    ];
    if (p.skippedLocal) lines.push(`${plural(p.skippedLocal, 'local link')} with unsupported URLs won’t be synced.`);
    for (const w of p.warnings) lines.push(`⚠ ${w}`);
    if (unsynced) lines.push('', '⚠ Changes made here since the last sync haven’t reached the current folder; they will go to the new one.');
    lines.push('', 'Nothing is replaced: both sides are combined, and a snapshot of this computer’s links is saved first.');
    return lines.join('\n');
  }

  /** Preview → confirm → switch destination → first merge. Nothing changes if the user cancels. */
  async function changeDestination(folder, fileName, pending = false) {
    let preview;
    try {
      ({ preview } = await withBusy(() => rpc('sync:preview', { folder: { id: folder.id, name: folder.name }, fileName, pending })));
    } catch (err) { fail(err); return false; }
    for (;;) {
      const choice = await ask({
        title: preview.remoteExists ? 'Merge with existing synced data' : 'Create the sync file from this computer',
        body: previewText(preview, config.dirty && config.confirmed && config.folder),
        buttons: [
          { key: 'cancel', label: 'Cancel' },
          { key: 'backup', label: 'Save backup first' },
          { key: 'go', label: preview.remoteExists ? 'Merge and sync' : 'Create and sync', kind: 'primary' },
        ],
      });
      if (choice === 'backup') { download(`important-links-backup-${day()}.json`, toJson(getLinks()), 'application/json'); toast('Backup downloaded'); continue; }
      if (choice !== 'go') return false;
      break;
    }
    try {
      await withBusy(() => rpc('sync:setDestination', { folder: preview.folder, fileName: preview.fileName, pending }));
    } catch (err) { fail(err); return false; }
    await refresh();
    return syncNow();
  }

  async function chooseFolder() {
    const folder = await pickFolder();
    if (folder) await changeDestination(folder, el.file.value);
  }

  /** Synced-folder method: pick a local folder (Chrome's own folder dialog), preview, confirm, sync. */
  async function chooseLocalFolder() {
    if (!inTab) { // the native folder dialog would close the popup, so do it in a full tab
      toast('Opening a full page to choose the folder…');
      openInTab();
      return;
    }
    if (!folderPickerSupported()) return fail(new Error('This browser can’t choose folders. Use Google Chrome 86 or newer.'));
    if (config.needsAuth) {
      try {
        if (!(await requestAccess())) return toast('Access wasn’t granted. Choose the folder again if needed.');
        await syncNow();
      } catch (err) { fail(err); }
      return;
    }
    let handle;
    try { handle = await pickDirectory(); } catch (err) {
      if (err?.name !== 'AbortError') fail(new Error('Couldn’t open that folder. Chrome doesn’t allow system folders; pick a normal subfolder.'));
      return;
    }
    try {
      if (!config.connected) await withBusy(() => rpc('sync:useFolder'));
    } catch (err) { return fail(err); }
    await refresh();
    await changeDestination({ id: 'local', name: handle.name }, el.file.value, true);
  }

  /* ---------- Folder picker (built on the Drive API: the hosted Google Picker would need remotely loaded code) ---------- */

  function pickFolder() {
    return new Promise((resolve) => {
      const dlg = $('#dlg-folders');
      const crumbs = $('#folders-path'), list = $('#folders-list'), msg = $('#folders-msg');
      const more = $('#folders-more'), newForm = $('#folders-newform'), newName = $('#folders-newname');
      const useBtn = $('#folders-use'), newBtn = $('#folders-new');
      const ac = new AbortController();
      const on = (node, ev, fn) => node.addEventListener(ev, fn, { signal: ac.signal });
      const path = [{ id: 'root', name: 'My Drive' }];
      let nextToken = null, chosen = null, token = 0;

      const here = () => path[path.length - 1];

      async function load(append = false) {
        const mine = ++token;
        msg.textContent = 'Loading folders…';
        useBtn.disabled = true;
        try {
          const res = await rpc('sync:listFolders', { parentId: here().id, pageToken: append ? nextToken : undefined });
          if (mine !== token) return;
          nextToken = res.nextPageToken;
          const items = res.folders.map((f) => h('li', {}, h('button', { type: 'button', class: 'folder-item', text: f.name, on: { click: () => { path.push(f); drawCrumbs(); load(); } } })));
          if (append) list.append(...items); else list.replaceChildren(...items);
          msg.textContent = list.children.length ? '' : 'No subfolders here. You can select this folder or create a new one.';
          more.hidden = !nextToken;
        } catch (err) {
          if (mine !== token) return;
          msg.textContent = err.message;
        }
        useBtn.disabled = false;
      }

      function drawCrumbs() {
        crumbs.replaceChildren(...path.flatMap((p, i) => [
          i ? h('span', { 'aria-hidden': 'true', text: '›' }) : null,
          h('button', {
            type: 'button', class: 'crumb', text: p.name, 'aria-current': i === path.length - 1 ? 'location' : null,
            on: { click: () => { path.length = i + 1; drawCrumbs(); load(); } },
          }),
        ]).filter(Boolean));
        useBtn.textContent = `Use “${here().name}”`;
        newForm.hidden = true;
      }

      on(useBtn, 'click', async () => {
        useBtn.disabled = true;
        try {
          const cur = here();
          chosen = cur.id === 'root' ? (await rpc('sync:resolveFolder', { id: 'root' })).folder : cur;
          dlg.close();
        } catch (err) { msg.textContent = err.message; useBtn.disabled = false; }
      });
      on(more, 'click', () => load(true));
      on($('#folders-cancel'), 'click', () => dlg.close());
      on(newBtn, 'click', () => { newForm.hidden = false; newName.value = ''; newName.focus(); });
      on(newForm, 'submit', async (e) => {
        e.preventDefault();
        const name = newName.value.trim();
        if (!name) return newName.focus();
        try {
          const { folder } = await rpc('sync:createFolder', { parentId: here().id, name: name.slice(0, 100) });
          path.push(folder); drawCrumbs(); load();
        } catch (err) { msg.textContent = err.message; }
      });
      dlg.addEventListener('close', () => { ac.abort(); resolve(chosen); }, { once: true });

      more.hidden = true;
      drawCrumbs();
      dlg.showModal();
      load();
    });
  }

  /* ---------- Wiring (registered once) ---------- */

  function fillFromJson(text) {
    const c = parseClientJson(text);
    if (!c) return false;
    gc.id.value = c.clientId;
    gc.secret.value = c.clientSecret;
    gc.secret.focus();
    toast(c.type === 'installed'
      ? 'Filled in. Note: this is a “Desktop” client; create a “Web application” client instead.'
      : (c.clientSecret ? 'Filled in from the JSON. Click Save client.' : 'Client ID filled in. Add the secret, then save.'), { kind: c.type === 'installed' ? 'error' : undefined, ms: 7000 });
    return true;
  }
  gc.id.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (text.trim().startsWith('{') && fillFromJson(text)) e.preventDefault();
  });
  gc.import.addEventListener('click', () => {
    if (!inTab) { toast('Opening a full page to choose the file…'); openInTab(); return; } // the file dialog would close the popup
    gc.file.click();
  });
  gc.file.addEventListener('change', async () => {
    const f = gc.file.files?.[0];
    gc.file.value = '';
    if (!f) return;
    if (f.size > 20_000 || !fillFromJson(await f.text())) fail(new Error('That file isn’t a Google OAuth client JSON.'));
  });
  gc.form.addEventListener('submit', saveClient);
  gc.remove.addEventListener('click', removeClient);
  gc.unlock.addEventListener('click', unlockClient);
  gc.unlockPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); unlockClient(); } });
  gc.lock.addEventListener('click', async () => { try { client = (await rpc('sync:lock')).client; } catch (err) { fail(err); } paint(); });
  gc.show.addEventListener('click', () => {
    const show = gc.secret.type === 'password';
    gc.secret.type = show ? 'text' : 'password';
    gc.show.textContent = show ? 'Hide' : 'Show';
    gc.show.setAttribute('aria-pressed', String(show));
  });
  gc.copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(client.redirectUri); toast('Redirect URI copied'); } catch { fail(new Error('Couldn’t copy. Select the address and copy it manually.')); }
  });
  el.connect.addEventListener('click', connect);
  el.disconnect.addEventListener('click', disconnect);
  el.pick.addEventListener('click', () => (config.mode === 'folder' ? chooseLocalFolder() : chooseFolder()));
  for (const r of el.modes) {
    r.addEventListener('change', async () => {
      try { await rpc('sync:setMode', { mode: r.value }); } catch (err) { fail(err); }
      await refresh();
    });
  }
  el.now.addEventListener('click', () => syncNow());
  el.auto.addEventListener('change', async () => {
    try { await rpc('sync:setAuto', { auto: el.auto.checked }); } catch (err) { fail(err); }
  });
  el.file.addEventListener('change', async () => {
    if (!config.folder || el.file.value.trim() === config.fileName) return;
    const ok = await changeDestination(config.folder, el.file.value);
    if (!ok) el.file.value = config.fileName;
  });
  for (const [btn, which] of [[el.backupDest, 'dest'], [el.backupLast, 'last']]) {
    btn.addEventListener('click', async () => {
      try {
        const { backup } = await rpc('sync:getBackup', { which });
        if (!backup) return toast('No backup of that kind exists yet.');
        download(`important-links-backup-${new Date(backup.at).toISOString().slice(0, 10)}.json`, toJson(backup.links), 'application/json');
      } catch (err) { fail(err); }
    });
  }

  refresh();
  return { refresh };
}
