// Message router + scheduling for the service worker. Kept separate from background.js so it can be tested.
import {
  getSyncConfig, patchSync, getSyncStatus, connectGoogleDrive, disconnectGoogleDrive, useLocalFolder, setSyncMode, previewDestination, selectDriveFolder,
  setAutoSync, syncWithGoogleDrive, listDriveFolders, createDriveFolder, resolveDriveFolder, getBackup,
  getClientState, saveGoogleClient, removeGoogleClient, unlockGoogleClient, lockGoogleClient,
} from './sync.js';
import { describeError } from './errors.js';
import { now } from './clock.js';

export const ALARMS = { debounce: 'il-debounce', periodic: 'il-periodic', retry: 'il-retry' };
export const DEBOUNCE_MS = 5_000;
const PERIODIC_MINUTES = 15;
const RETRY_MINUTES = [0.5, 1, 2, 5, 15];
const OPEN_SYNC_MIN_AGE_MS = 30_000;

let debounceTimer = null;
let retryCount = 0;

export function ensureAlarms() {
  chrome.alarms.get(ALARMS.periodic).then((a) => {
    if (!a) chrome.alarms.create(ALARMS.periodic, { delayInMinutes: 5, periodInMinutes: PERIODIC_MINUTES });
  }).catch(() => {});
}

function scheduleRetry() {
  const minutes = RETRY_MINUTES[Math.min(retryCount, RETRY_MINUTES.length - 1)];
  retryCount++;
  chrome.alarms.create(ALARMS.retry, { delayInMinutes: minutes });
}

/** Background-initiated sync: respects the auto-sync switch and never prompts for sign-in. */
export async function triggerAutoSync(reason) {
  const c = await getSyncConfig();
  if (!c.auto || !c.connected || !c.confirmed || c.needsAuth) return null;
  if (c.mode !== 'folder') {
    const cs = await getClientState();
    if (!cs.configured || cs.locked) return null; // locked: sync resumes after the user enters the passphrase
  }
  try {
    const result = await syncWithGoogleDrive({ reason });
    retryCount = 0;
    chrome.alarms.clear(ALARMS.retry);
    return result;
  } catch (err) {
    if (['network', 'quota', 'api', 'conflict'].includes(err.code)) scheduleRetry();
    return null;
  }
}

function scheduleDebounced() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => triggerAutoSync('change'), DEBOUNCE_MS);
  // The timer dies if the service worker is suspended; the alarm is the backup (Chrome's minimum is 30 s).
  chrome.alarms.create(ALARMS.debounce, { delayInMinutes: 0.5 });
}

export async function onAlarm(name) {
  if (name === ALARMS.debounce) {
    if ((await getSyncConfig()).dirty) await triggerAutoSync('change');
  } else if (name === ALARMS.periodic) await triggerAutoSync('periodic');
  else if (name === ALARMS.retry) await triggerAutoSync('retry');
}

export async function handleMessage(msg) {
  try {
    switch (msg.type) {
      case 'sync:status': return { ok: true, status: await getSyncStatus() };
      case 'sync:clientInfo': return { ok: true, client: await getClientState() };
      case 'sync:saveClient': return { ok: true, client: await saveGoogleClient(msg) };
      case 'sync:removeClient': return { ok: true, client: await removeGoogleClient() };
      case 'sync:unlock': {
        const client = await unlockGoogleClient(msg.passphrase);
        triggerAutoSync('unlock'); // intentionally not awaited
        return { ok: true, client };
      }
      case 'sync:lock': return { ok: true, client: await lockGoogleClient() };
      case 'sync:connect': return { ok: true, status: await connectGoogleDrive() };
      case 'sync:useFolder': return { ok: true, status: await useLocalFolder() };
      case 'sync:setMode': return { ok: true, status: await setSyncMode(msg.mode) };
      case 'sync:disconnect': return { ok: true, status: await disconnectGoogleDrive() };
      case 'sync:listFolders': return { ok: true, ...(await listDriveFolders(msg.parentId, msg.pageToken)) };
      case 'sync:createFolder': return { ok: true, folder: await createDriveFolder(msg.parentId, msg.name) };
      case 'sync:resolveFolder': return { ok: true, folder: await resolveDriveFolder(msg.id) };
      case 'sync:preview': return { ok: true, preview: await previewDestination(msg) };
      case 'sync:setDestination': return { ok: true, status: await selectDriveFolder(msg.folder, msg.fileName, { pending: msg.pending === true }) };
      case 'sync:setAuto': return { ok: true, status: await setAutoSync(msg.auto) };
      case 'sync:getBackup': return { ok: true, backup: await getBackup(msg.which) };
      case 'sync:now': {
        try {
          return { ok: true, result: await syncWithGoogleDrive({ reason: 'manual' }) };
        } catch (err) {
          if (['network', 'quota', 'api', 'conflict'].includes(err.code)) scheduleRetry();
          throw err;
        }
      }
      case 'sync:dataChanged': {
        const c = await patchSync((cur) => (cur.connected && cur.confirmed ? { dirty: true } : {}));
        if (c.connected && c.confirmed && c.auto) scheduleDebounced();
        return { ok: true };
      }
      case 'sync:opened': {
        const c = await getSyncConfig();
        const stale = !c.lastSyncAt || now() - c.lastSyncAt > OPEN_SYNC_MIN_AGE_MS;
        if (stale || c.dirty || c.lastError) triggerAutoSync('open'); // intentionally not awaited
        return { ok: true };
      }
      default: return { ok: false, error: { code: 'unknown', message: 'Unknown request.' } };
    }
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}
