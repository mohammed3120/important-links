// Minimal Google Drive v3 client (fetch only). Every failure becomes a DriveError with a stable code.
import { DriveError } from './errors.js';
import { getToken, dropToken } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export const retry = { max: 3, delayMs: 500 }; // tests set delayMs to 0
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();

async function toError(res) {
  let reason = '', message = '';
  try {
    const body = await res.json();
    reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '';
    message = body?.error?.message ?? '';
  } catch { /* non-JSON error body */ }
  if (res.status === 404) return new DriveError('not_found', 'That item no longer exists in Google Drive.', 404);
  if (res.status === 429 || /ratelimit|dailylimit|quotaexceeded/i.test(reason)) {
    return new DriveError('quota', /storage/i.test(reason) ? 'Your Google Drive is full.' : 'Google Drive is rate limiting requests. Sync will retry shortly.', res.status);
  }
  if (/storagequotaexceeded/i.test(reason)) return new DriveError('quota', 'Your Google Drive is full.', res.status);
  if (/accessnotconfigured|servicedisabled/i.test(reason) || /has not been used|is disabled/i.test(message)) {
    return new DriveError('setup', 'The Google Drive API isn’t enabled for your Google Cloud project (see docs/SYNC.md).', res.status);
  }
  if (res.status === 403) return new DriveError('forbidden', 'Google Drive denied access to this folder or file.', 403);
  return new DriveError('api', `Google Drive returned an error (${res.status}).`, res.status);
}

/** Authenticated fetch with one token refresh on 401 and backoff on network/429/5xx. */
async function request(url, { method = 'GET', headers = {}, body, retryable = true } = {}) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(false);
    let res;
    try {
      res = await fetch(url, { method, body, headers: { ...headers, Authorization: `Bearer ${token}` } });
    } catch {
      if (retryable && attempt < retry.max - 1) { await sleep(retry.delayMs * 2 ** attempt); continue; }
      throw new DriveError('network', 'Couldn’t reach Google Drive. Check your connection; your changes are safe and will sync later.');
    }
    if (res.status === 401) {
      await dropToken(token);
      if (!refreshed) { refreshed = true; attempt--; continue; }
      throw new DriveError('auth', 'Google access expired or was revoked. Reconnect Google Drive in Settings.', 401);
    }
    if ((res.status === 429 || res.status >= 500) && retryable && attempt < retry.max - 1) {
      await sleep(retry.delayMs * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw await toError(res);
    return res;
  }
}

const json = async (url, opts) => (await request(url, opts)).json();

export async function getAccount() {
  const r = await json(`${API}/about?${qs({ fields: 'user(displayName,emailAddress)' })}`);
  return { email: r.user?.emailAddress ?? '', name: r.user?.displayName ?? '' };
}

/** Resolves 'root' to the real id and verifies the folder is usable. */
export async function getFolder(id) {
  const f = await json(`${API}/files/${encodeURIComponent(id)}?${qs({ fields: 'id,name,mimeType,trashed,capabilities/canAddChildren', supportsAllDrives: true })}`);
  if (f.mimeType !== FOLDER_MIME || f.trashed) throw new DriveError('not_found', 'The selected Drive folder is missing or in the trash.', 404);
  if (f.capabilities?.canAddChildren === false) throw new DriveError('forbidden', 'You don’t have permission to add files to this folder.', 403);
  return { id: f.id, name: f.name };
}

export async function listFolders(parentId = 'root', pageToken) {
  const r = await json(`${API}/files?${qs({
    q: `'${esc(parentId)}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: 'nextPageToken,files(id,name)', orderBy: 'name', pageSize: 100, pageToken,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  })}`);
  return { folders: r.files ?? [], nextPageToken: r.nextPageToken ?? null };
}

export async function createFolder(parentId, name) {
  const r = await json(`${API}/files?${qs({ fields: 'id,name', supportsAllDrives: true })}`, {
    method: 'POST', retryable: false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return { id: r.id, name: r.name };
}

const FILE_FIELDS = 'id,name,version,modifiedTime,createdTime,trashed,parents';

/** Files with this name in the folder, oldest first (more than one means something duplicated the file). */
export async function findFile(folderId, name) {
  const r = await json(`${API}/files?${qs({
    q: `'${esc(folderId)}' in parents and name='${esc(name)}' and trashed=false and mimeType!='${FOLDER_MIME}'`,
    fields: `files(${FILE_FIELDS})`, orderBy: 'createdTime', pageSize: 10,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  })}`);
  return r.files ?? [];
}

export async function getFileMeta(fileId) {
  return json(`${API}/files/${encodeURIComponent(fileId)}?${qs({ fields: FILE_FIELDS, supportsAllDrives: true })}`);
}

export async function downloadText(fileId) {
  return (await request(`${API}/files/${encodeURIComponent(fileId)}?${qs({ alt: 'media', supportsAllDrives: true })}`)).text();
}

/** Creates the sync file. Not auto-retried: a repeated create could duplicate the file. */
export async function createJsonFile(folderId, name, text) {
  const boundary = `il${Math.random().toString(36).slice(2)}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' })}\r\n`
    + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
  return json(`${UPLOAD}/files?${qs({ uploadType: 'multipart', fields: 'id,name,version,modifiedTime', supportsAllDrives: true })}`, {
    method: 'POST', retryable: false, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  });
}

/** Replaces the file content in one request, so a failed upload leaves the old content intact. */
export async function updateJsonFile(fileId, text) {
  return json(`${UPLOAD}/files/${encodeURIComponent(fileId)}?${qs({ uploadType: 'media', fields: 'id,name,version,modifiedTime', supportsAllDrives: true })}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text,
  });
}
