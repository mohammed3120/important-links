// Storage for a user-supplied Google OAuth client (Web application type): client ID, client secret and refresh token.
// Nothing here is ever synced, exported, logged or sent anywhere except Google's own token endpoint.
// Optional passphrase: the secret and refresh token are then AES-GCM encrypted at rest (key from PBKDF2) and the
// derived key lives only in chrome.storage.session (memory, cleared when the browser closes).
import { DriveError } from './errors.js';

export const VAULT_KEY = 'il_oauth';
const KEY_SLOT = 'il_oauth_key';       // session: derived key (base64), only when a passphrase is set
const ACCESS_SLOT = 'il_oauth_access'; // session: cached short-lived access token { token, exp }
export const kdf = { iterations: 600_000 }; // tests lower this
export const CLIENT_ID_RE = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;
export const MIN_PASSPHRASE = 8;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const mem = {};
const session = () => globalThis.chrome?.storage?.session ?? {
  get: async (k) => (k in mem ? { [k]: mem[k] } : {}),
  set: async (o) => { Object.assign(mem, o); },
  remove: async (k) => { for (const x of [].concat(k)) delete mem[x]; },
};

const readVault = async () => (await chrome.storage.local.get(VAULT_KEY))[VAULT_KEY] ?? null;
const writeVault = (v) => chrome.storage.local.set({ [VAULT_KEY]: v });
const sessionKey = async () => (await session().get(KEY_SLOT))[KEY_SLOT] ?? null;

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: kdf.iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
}
const importRaw = (raw) => crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
const exportRaw = async (key) => b64(await crypto.subtle.exportKey('raw', key));

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), data: b64(ct) };
}
async function open(key, { iv, data }) {
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(data))));
}

const locked = () => new DriveError('locked', 'Enter your passphrase in Settings to unlock Google access.');

/** What the UI may know. Never includes the secret or any token. */
export async function getClientInfo() {
  const v = await readVault();
  if (!v?.clientId) return { saved: false, protected: false, locked: false, clientId: '' };
  return { saved: true, clientId: v.clientId, protected: Boolean(v.protected), locked: Boolean(v.protected) && !(await sessionKey()) };
}

export async function saveClient({ clientId, clientSecret, passphrase = '' }) {
  clientId = String(clientId ?? '').trim();
  clientSecret = String(clientSecret ?? '').trim();
  passphrase = String(passphrase ?? '');
  if (!CLIENT_ID_RE.test(clientId)) throw new DriveError('invalid', 'That doesn’t look like a Google client ID. It ends with “.apps.googleusercontent.com”.');
  if (clientSecret.length < 8 || /\s/.test(clientSecret)) throw new DriveError('invalid', 'Enter the client secret exactly as shown in Google Cloud (no spaces).');
  if (passphrase && passphrase.length < MIN_PASSPHRASE) throw new DriveError('invalid', `Use a passphrase of at least ${MIN_PASSPHRASE} characters, or leave it empty.`);
  await session().remove([KEY_SLOT, ACCESS_SLOT]);
  const secrets = { clientSecret, refreshToken: '' };
  if (!passphrase) return writeVault({ v: 1, clientId, protected: false, ...secrets });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  await writeVault({ v: 1, clientId, protected: true, salt: b64(salt), ...(await seal(key, secrets)) });
  await session().set({ [KEY_SLOT]: await exportRaw(key) });
}

/** { clientId, clientSecret, refreshToken } or null when nothing is saved. Throws code 'locked' when a passphrase is needed. */
export async function readSecrets() {
  const v = await readVault();
  if (!v?.clientId) return null;
  if (!v.protected) return { clientId: v.clientId, clientSecret: v.clientSecret ?? '', refreshToken: v.refreshToken ?? '' };
  const raw = await sessionKey();
  if (!raw) throw locked();
  try {
    return { clientId: v.clientId, ...(await open(await importRaw(raw), v)) };
  } catch {
    await session().remove(KEY_SLOT);
    throw locked();
  }
}

export async function setRefreshToken(refreshToken) {
  const v = await readVault();
  if (!v?.clientId) return;
  if (!v.protected) return writeVault({ ...v, refreshToken });
  const raw = await sessionKey();
  if (!raw) throw locked();
  const key = await importRaw(raw);
  const s = await open(key, v);
  await writeVault({ ...v, ...(await seal(key, { ...s, refreshToken })) });
}

export async function unlock(passphrase) {
  const v = await readVault();
  if (!v?.protected) return;
  const key = await deriveKey(String(passphrase ?? ''), unb64(v.salt));
  try { await open(key, v); } catch { throw new DriveError('locked', 'That passphrase is incorrect.'); }
  await session().set({ [KEY_SLOT]: await exportRaw(key) });
}

export async function lock() { await session().remove([KEY_SLOT, ACCESS_SLOT]); }

export async function clearClient() {
  await chrome.storage.local.remove(VAULT_KEY);
  await session().remove([KEY_SLOT, ACCESS_SLOT]);
}

export async function getCachedAccess() { return (await session().get(ACCESS_SLOT))[ACCESS_SLOT] ?? null; }
export const setCachedAccess = (token, exp) => session().set({ [ACCESS_SLOT]: { token, exp } });
export const clearCachedAccess = () => session().remove(ACCESS_SLOT);

/** Reads the JSON Google lets you download for an OAuth client. Returns { clientId, clientSecret, type } or null. */
export function parseClientJson(text) {
  let o;
  try { o = JSON.parse(String(text ?? '')); } catch { return null; }
  const type = o?.web ? 'web' : o?.installed ? 'installed' : 'unknown';
  const c = o?.web ?? o?.installed ?? o;
  if (typeof c?.client_id !== 'string') return null;
  return { clientId: c.client_id.trim(), clientSecret: String(c.client_secret ?? '').trim(), type };
}
