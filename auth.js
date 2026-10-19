// Google sign-in. Two ways to get a token, chosen automatically:
//  1. "custom": the user's own OAuth client (type "Web application") saved in Settings: authorization code + PKCE through
//     chrome.identity.launchWebAuthFlow, refresh token kept in oauth-store.js. Works without editing manifest.json.
//  2. "manifest": a "Chrome Extension" client ID in manifest.json through chrome.identity.getAuthToken (no secret needed).
// Tokens are never logged or shown; errors carry only fixed messages.
import { DriveError } from './errors.js';
import * as vault from './oauth-store.js';
import { now } from './clock.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/drive'];

const manifest = () => chrome.runtime.getManifest();
function manifestClientId() {
  const id = manifest().oauth2?.client_id ?? '';
  return /\.apps\.googleusercontent\.com$/.test(id) && !/YOUR_/i.test(id) ? id : '';
}

/** Everything the UI needs to describe the Google client. Contains no secrets. */
export async function clientState() {
  const info = await vault.getClientInfo();
  const mid = manifestClientId();
  const source = info.saved ? 'custom' : (mid ? 'manifest' : null);
  return {
    source, configured: source !== null,
    clientId: info.saved ? info.clientId : mid,
    protected: info.protected, locked: info.locked,
    redirectUri: chrome.identity?.getRedirectURL?.() ?? '',
  };
}

export async function clientConfigured() { return (await clientState()).configured; }

const SETUP_MSG = 'Google sign-in isn’t set up yet. Add your OAuth client ID in Settings (see docs/SYNC.md).';

function toAuthError(err, interactive, source) {
  const msg = String(err?.message ?? err ?? '');
  if (/did not approve|cancel|closed|dismissed|access_denied/i.test(msg)) return new DriveError('cancelled', 'Sign-in was cancelled.');
  if (!interactive) return new DriveError('auth', 'Google access expired or was revoked. Reconnect Google Drive in Settings.');
  return source === 'custom'
    ? new DriveError('auth', 'Couldn’t sign in to Google. Check that the redirect URI shown in Settings is listed under “Authorized redirect URIs” and that your account is a test user (see docs/SYNC.md).')
    : new DriveError('auth', 'Couldn’t sign in to Google. Check that your OAuth client ID and extension ID match (see docs/SYNC.md).');
}

/* ---------- Manifest client (Chrome Extension type) ---------- */

async function manifestToken(interactive) {
  let result;
  try {
    result = await chrome.identity.getAuthToken({ interactive });
  } catch (err) {
    throw toAuthError(err, interactive, 'manifest');
  }
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw toAuthError(null, interactive, 'manifest');
  return token;
}

/* ---------- Custom client (Web application type, PKCE) ---------- */

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (bytes) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    throw new DriveError('network', 'Couldn’t reach Google. Check your connection; your changes are safe and will sync later.');
  }
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (res.ok && body.access_token) return body;
  const code = String(body.error ?? '');
  if (code === 'invalid_grant') return { invalidGrant: true };
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    throw new DriveError('setup', 'Google rejected the client ID or secret. Check them in Settings (the client must be of type “Web application”).', res.status);
  }
  if (res.status === 429 || res.status >= 500) throw new DriveError('network', 'Google is temporarily unavailable. Sync will retry shortly.', res.status);
  throw new DriveError('auth', 'Google didn’t accept the sign-in. Reconnect Google Drive in Settings.', res.status);
}

async function remember(body) {
  const ttl = Math.max(60, Number(body.expires_in) || 3600) * 1000;
  await vault.setCachedAccess(body.access_token, now() + ttl);
  return body.access_token;
}

async function customToken(interactive) {
  const cached = await vault.getCachedAccess();
  if (cached && cached.exp - 60_000 > now()) return cached.token;
  const s = await vault.readSecrets(); // throws 'locked' when a passphrase is needed
  if (s.refreshToken) {
    const body = await tokenRequest({ client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken, grant_type: 'refresh_token' });
    if (!body.invalidGrant) return remember(body);
    await vault.setRefreshToken(''); // revoked or expired: start over
  }
  if (!interactive) throw toAuthError(null, false, 'custom');
  return interactiveFlow(s);
}

async function interactiveFlow(s) {
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  const redirectUri = chrome.identity.getRedirectURL();
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: s.clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: (manifest().oauth2?.scopes ?? DEFAULT_SCOPES).join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent',
  })}`;
  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (err) {
    throw toAuthError(err, true, 'custom');
  }
  const q = new URL(responseUrl).searchParams;
  if (q.get('error')) throw toAuthError(q.get('error'), true, 'custom');
  if (q.get('state') !== state || !q.get('code')) throw toAuthError(null, true, 'custom');
  const body = await tokenRequest({
    client_id: s.clientId, client_secret: s.clientSecret, code: q.get('code'),
    code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code',
  });
  if (body.invalidGrant) throw toAuthError(null, true, 'custom');
  if (!body.refresh_token) throw new DriveError('auth', 'Google didn’t grant long-lived access. Remove the extension’s access at myaccount.google.com/permissions and connect again.');
  await vault.setRefreshToken(body.refresh_token);
  return remember(body);
}

/* ---------- Public API ---------- */

/** Returns an access token. interactive:false never shows UI and fails if the user must sign in again. */
export async function getToken(interactive = false) {
  const { source } = await clientState();
  if (!source) throw new DriveError('setup', SETUP_MSG);
  return source === 'custom' ? customToken(interactive) : manifestToken(interactive);
}

/** Drops the cached copy; with revoke:true also revokes the grant at Google and forgets the refresh token. Best effort. */
export async function dropToken(token, { revoke = false } = {}) {
  const { source } = await clientState();
  if (source === 'custom') await vault.clearCachedAccess().catch(() => {});
  else { try { await chrome.identity.removeCachedAuthToken({ token }); } catch { /* already gone */ } }
  if (!revoke) return;
  try { await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }); } catch { /* offline: grant stays, harmless */ }
  if (source === 'custom') await vault.setRefreshToken('').catch(() => {});
}
