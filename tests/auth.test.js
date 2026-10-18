// Tests of the "own Google Cloud client" sign-in (Web application client, PKCE, optional passphrase).
// Google's token endpoint and consent screen are simulated; nothing talks to the network.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDrive } from './helpers/fake-drive.js';
import { makeDevice, use } from './helpers/device.js';
import * as S from '../sync.js';
import * as V from '../oauth-store.js';
import { getToken } from '../auth.js';
import { handleMessage } from '../messages.js';

const CLIENT = { clientId: '999-web.apps.googleusercontent.com', clientSecret: 'GOCSPX-test-secret-123' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sha256url = async (v) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))).toString('base64url');

let drive, dev, google;

function fakeGoogle() {
  const g = { refreshToken: 'rt-secret-777', refreshes: 0, revoked: false, tokenCalls: [], challenge: '', state: '', consent: 'ok' };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const p = Object.fromEntries(new URLSearchParams(init.body));
      g.tokenCalls.push(p);
      if (p.client_secret !== CLIENT.clientSecret || p.client_id !== CLIENT.clientId) return json(401, { error: 'invalid_client' });
      if (p.grant_type === 'authorization_code') {
        if (p.code !== 'code-1' || await sha256url(p.code_verifier) !== g.challenge) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: drive.token, expires_in: 3600, refresh_token: g.refreshToken });
      }
      if (p.refresh_token !== g.refreshToken || g.revoked) return json(400, { error: 'invalid_grant' });
      g.refreshes++;
      return json(200, { access_token: drive.token, expires_in: 3600 });
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') { g.revoked = true; return json(200, {}); }
    return drive.fetch(url, init);
  };
  return g;
}

beforeEach(() => {
  V.kdf.iterations = 1000;
  drive = new FakeDrive();
  google = fakeGoogle();
  dev = makeDevice('win', drive, { clientId: '' }); // no client in manifest.json
  dev.chrome.identity.launchWebAuthFlow = async ({ url }) => {
    if (google.consent === 'cancel') throw new Error('The user did not approve access.');
    const q = new URL(url).searchParams;
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('access_type'), 'offline');
    assert.equal(q.get('redirect_uri'), 'https://win.chromiumapp.org/');
    google.challenge = q.get('code_challenge');
    return `https://win.chromiumapp.org/?code=code-1&state=${q.get('state')}`;
  };
  use(dev, drive);
  globalThis.fetch = google.fetch;
  dev.chrome.storage.session.remove(['il_oauth_key', 'il_oauth_access']);
});

const folderSetup = async () => {
  const f = drive.addFolder('Links');
  await S.selectDriveFolder({ id: f, name: 'Links' }, 'important-links-sync.json');
};

test('without any client, sign-in explains the setup instead of failing mysteriously', async () => {
  await assert.rejects(() => getToken(true), { code: 'setup' });
  assert.equal((await S.getSyncStatus()).config.mode, 'folder');
});

test('client details are validated before anything is stored', async () => {
  await assert.rejects(() => S.saveGoogleClient({ ...CLIENT, clientId: 'not-a-client' }), { code: 'invalid' });
  await assert.rejects(() => S.saveGoogleClient({ ...CLIENT, clientSecret: 'short' }), { code: 'invalid' });
  await assert.rejects(() => S.saveGoogleClient({ ...CLIENT, passphrase: '1234' }), { code: 'invalid' });
  assert.equal(dev.store.il_oauth, undefined);
});

test('own client: interactive PKCE sign-in stores a refresh token and later refreshes silently', async () => {
  await S.setSyncMode('drive');
  await S.saveGoogleClient(CLIENT);
  const status = await S.connectGoogleDrive();
  assert.equal(status.config.account.email, 'me@example.com');
  assert.equal(dev.store.il_oauth.refreshToken, google.refreshToken);
  await folderSetup();
  // Simulate the access token expiring (browser restart clears session storage): refresh, no consent window.
  await dev.chrome.storage.session.remove('il_oauth_access');
  dev.chrome.identity.launchWebAuthFlow = async () => { throw new Error('must not prompt'); };
  assert.equal(await getToken(false), drive.token);
  assert.equal(google.refreshes, 1);
});

test('tokens and secrets never reach il_sync or messages to the popup', async () => {
  await S.saveGoogleClient(CLIENT);
  await S.connectGoogleDrive();
  const all = JSON.stringify([dev.store.il_sync, await handleMessage({ type: 'sync:status' }), await handleMessage({ type: 'sync:clientInfo' })]);
  for (const secret of [CLIENT.clientSecret, google.refreshToken, drive.token]) assert.ok(!all.includes(secret), `leaked ${secret}`);
});

test('cancelled consent is reported as cancelled and stores no refresh token', async () => {
  await S.saveGoogleClient(CLIENT);
  google.consent = 'cancel';
  await assert.rejects(() => S.connectGoogleDrive(), { code: 'cancelled' });
  assert.equal(dev.store.il_oauth.refreshToken, '');
});

test('wrong client secret is reported as a setup problem', async () => {
  await S.saveGoogleClient({ ...CLIENT, clientSecret: 'GOCSPX-wrong-secret' });
  await assert.rejects(() => S.connectGoogleDrive(), { code: 'setup' });
});

test('passphrase: secret and refresh token are encrypted at rest and need unlocking after a restart', async () => {
  await S.saveGoogleClient({ ...CLIENT, passphrase: 'correct horse battery' });
  await S.connectGoogleDrive();
  const stored = JSON.stringify(dev.store.il_oauth);
  assert.ok(!stored.includes(CLIENT.clientSecret) && !stored.includes(google.refreshToken), 'plaintext found in storage');
  assert.equal((await S.getClientState()).locked, false);

  await dev.chrome.storage.session.remove(['il_oauth_key', 'il_oauth_access']); // browser restart
  assert.equal((await S.getClientState()).locked, true);
  assert.equal((await S.getSyncStatus()).label, 'Locked');
  await assert.rejects(() => getToken(false), { code: 'locked' });
  await assert.rejects(() => S.unlockGoogleClient('wrong passphrase'), { code: 'locked' });
  await S.unlockGoogleClient('correct horse battery');
  assert.equal(await getToken(false), drive.token);

  await S.lockGoogleClient();
  assert.equal((await S.getClientState()).locked, true);
});

test('background sync stays quiet while locked and sync reports it without marking data as broken', async () => {
  await S.saveGoogleClient({ ...CLIENT, passphrase: 'correct horse battery' });
  await S.connectGoogleDrive();
  await folderSetup();
  await S.lockGoogleClient();
  await assert.rejects(() => S.syncWithGoogleDrive({ reason: 'manual' }), { code: 'locked' });
  const c = await S.getSyncConfig();
  assert.equal(c.lastError, null);
  assert.equal(c.needsAuth, false);
  await S.unlockGoogleClient('correct horse battery');
  assert.equal((await S.syncWithGoogleDrive({ reason: 'manual' })).status !== 'busy', true);
});

test('revoked grant: silent refresh fails as auth and forgets the dead refresh token', async () => {
  await S.saveGoogleClient(CLIENT);
  await S.connectGoogleDrive();
  await dev.chrome.storage.session.remove('il_oauth_access');
  google.revoked = true;
  await assert.rejects(() => getToken(false), { code: 'auth' });
  assert.equal(dev.store.il_oauth.refreshToken, '');
});

test('disconnect revokes at Google and clears the refresh token; the client can then be changed or removed', async () => {
  await S.saveGoogleClient(CLIENT);
  await S.connectGoogleDrive();
  await assert.rejects(() => S.saveGoogleClient(CLIENT), { code: 'bad_mode' });
  await assert.rejects(() => S.removeGoogleClient(), { code: 'bad_mode' });
  await S.disconnectGoogleDrive();
  assert.equal(google.revoked, true);
  assert.equal(dev.store.il_oauth.refreshToken, '');
  await S.removeGoogleClient();
  assert.equal(dev.store.il_oauth, undefined);
  assert.equal((await S.getClientState()).configured, false);
});

test('manifest client ID still works and the folder method needs none of this', async () => {
  const d2 = makeDevice('ub', drive); // valid client ID in manifest.json
  use(d2, drive);
  const st = await S.getClientState();
  assert.equal(st.source, 'manifest');
  assert.equal(await getToken(true), drive.token);
});

test('Google’s downloaded client JSON is understood (web and desktop), junk is rejected', () => {
  const web = V.parseClientJson(JSON.stringify({ web: { client_id: 'a.apps.googleusercontent.com', client_secret: 'GOCSPX-x', redirect_uris: [] } }));
  assert.deepEqual(web, { clientId: 'a.apps.googleusercontent.com', clientSecret: 'GOCSPX-x', type: 'web' });
  assert.equal(V.parseClientJson(JSON.stringify({ installed: { client_id: 'b.apps.googleusercontent.com' } })).type, 'installed');
  assert.equal(V.parseClientJson('not json'), null);
  assert.equal(V.parseClientJson('{"hello":1}'), null);
});
