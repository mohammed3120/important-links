// A fake browser profile: its own chrome.storage, identity and (optionally) localStorage. Tests swap globalThis.chrome
// between devices to simulate Windows and Ubuntu sharing one Drive account.
export const VALID_CLIENT = '123-abc.apps.googleusercontent.com';

export function makeDevice(name, drive, { clientId = VALID_CLIENT } = {}) {
  const store = {};
  const sess = {};
  const dev = {
    name, store, sess, tokenMode: 'ok', // 'ok' | 'revoked'
    chrome: {
      runtime: { id: `ext-${name}`, getManifest: () => ({ version: '2.1.0', oauth2: { client_id: clientId } }) },
      storage: { local: {
        get: async (k) => (typeof k === 'string' ? (k in store ? { [k]: structuredClone(store[k]) } : {}) : {}),
        set: async (o) => { if (dev.storageFails) throw new Error('QUOTA_BYTES quota exceeded'); for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
        remove: async (k) => { for (const x of [].concat(k)) delete store[x]; },
      },
      session: {
        get: async (k) => (k in sess ? { [k]: structuredClone(sess[k]) } : {}),
        set: async (o) => { for (const [k, v] of Object.entries(o)) sess[k] = structuredClone(v); },
        remove: async (k) => { for (const x of [].concat(k)) delete sess[x]; },
      } },
      identity: {
        getRedirectURL: () => `https://${name}.chromiumapp.org/`,
        getAuthToken: async ({ interactive }) => {
          if (dev.tokenMode === 'revoked' && !interactive) throw new Error('OAuth2 not granted or revoked.');
          if (dev.tokenMode === 'cancel') throw new Error('The user did not approve access.');
          return { token: dev.cached ?? drive.token };
        },
        removeCachedAuthToken: async () => { dev.removedToken = true; dev.cached = undefined; },
      },
      alarms: { create: () => {}, clear: () => {}, get: async () => null },
    },
  };
  return dev;
}

export function use(dev, drive) {
  globalThis.chrome = dev.chrome;
  globalThis.fetch = drive.fetch;
}

export function seed(dev, links, tombstones = {}) {
  dev.store.il_data = { schema: 2, links, tombstones, settings: { theme: 'system', sort: 'recent' } };
}

let n = 0;
export function link(title, url, extra = {}) {
  n++;
  const t = 1_700_000_000_000 + n * 1000;
  return { id: `id-${title.replace(/\W/g, '')}-${n}`.padEnd(10, 'x'), title, url, description: '', category: '', tags: [], favorite: false, createdAt: t, updatedAt: t, openCount: 0, lastOpenedAt: null, ...extra };
}
