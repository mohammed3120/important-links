# Sync between computers — setup, behavior, limits

There are two methods. Both use the same merge engine, the same sync file, and the same safety rules.

| | **Synced folder** (default) | **Google sign-in** (advanced) |
|---|---|---|
| Google Cloud project / OAuth client | **Not needed** | Required (entered in Settings or `manifest.json`) |
| How it works | Writes `important-links-sync.json` into a local folder that your Drive app syncs | Talks to the Drive API directly |
| Needs on each computer | A Drive sync app (see below) | Google Chrome signed in to Google |
| Works while Chrome is in the background | Yes, while Chrome still has folder permission | Yes |

## 0. Synced folder method (no Google Cloud)
1. **Windows:** install *Google Drive for desktop* and sign in. Create a folder such as `G:\My Drive\ImportantLinks`.
   **Ubuntu:** Google has no official Drive client for Linux. Use one of: `rclone mount` (free; `rclone mount gdrive: ~/GoogleDrive --vfs-cache-mode full &`), *Insync* (paid), or any other tool that keeps a normal folder in sync. (The same method works with Dropbox, Syncthing, Nextcloud, OneDrive…) Create the same folder, e.g. `~/GoogleDrive/ImportantLinks`.
2. Load the extension on each computer, open the popup → Settings (⚙) → **Synced folder** → **Choose folder…** (a full page opens, because Chrome's folder dialog would close the popup) → pick the folder → review the preview → **Merge and sync**.
3. Use the **same sync file name** on both computers (default `important-links-sync.json`).
4. Chrome does not allow picking a drive root, your home folder, or system folders: choose a *subfolder* like `ImportantLinks`.

How it behaves:
- Local links are only changed after the sync file has been written and read back successfully; edits made during a sync are re-merged, not lost.
- The Drive app uploads the file in the background. A change on one computer appears on the other after *Drive's* sync delay (seconds to a couple of minutes) plus the next extension sync (on open, ~5 s after changes, every 15 min). Use **Sync now** to pull immediately.
- Chrome may ask you to re-allow folder access after a restart. The Settings status then shows *Folder access needed*; click **Allow folder access**. Until you do, nothing is lost and nothing syncs (you also get a notice when you open the popup).
- If your sync tool creates copies like `important-links-sync (1).json`, a warning is shown. Nothing is lost, because every computer keeps its full data and re-merges on its next sync; delete the extra copies when convenient.
- Two computers writing within the same Drive-sync window can overwrite each other's *file*. This is self-healing: each computer's local data still has everything, and the next sync merges and re-uploads.
- **Stop syncing** forgets the folder; the file and your local links stay.

The rest of this document (merge algorithm, concurrency, scheduling, tests) applies to both methods. Sections 1–2 are only for the Google sign-in method.

## 1. Google sign-in method only: one-time Google Cloud setup (manual, ~10 min)
Create a project, enable the API and the consent screen once; then pick **one** of two ways to give the extension a client.

1. Go to https://console.cloud.google.com → create a project (e.g. "Important Links").
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen**: User type *External*; add app name, your email; add scope `https://www.googleapis.com/auth/drive`; under *Test users* add your Google account(s) (while the app is in "Testing", only listed users can sign in, and refresh tokens expire after 7 days: publish the app or reconnect when asked).

### Option A (easiest): enter the client in the extension (Web application client)
4. **Credentials → Create credentials → OAuth client ID** → type **Web application**.
5. Under **Authorized redirect URIs** add the address shown in the extension at Settings → Sync → Method *Google sign-in* → **Google Cloud client** (it looks like `https://<extension-id>.chromiumapp.org/`; there is a Copy button). The extension ships with a fixed ID, `opcgpedigbcmnndabghghifopdggpbkg`, so it is the same on every computer.
6. Click **Import JSON file…** (or paste the downloaded JSON into the Client ID box) to fill both fields, or copy the **Client ID** and **Client secret** by hand. Optionally set a **passphrase**. Click **Save client**, then **Connect Google Drive**. No file editing, no reload.

How it is stored and protected:
- Sign-in uses the authorization-code flow with PKCE (`chrome.identity.launchWebAuthFlow`); the extension keeps only a long-lived *refresh token* and fetches short-lived access tokens (cached in memory only, `chrome.storage.session`).
- The client ID, client secret and refresh token live in `chrome.storage.local` of this browser profile, in a record separate from your links. They are **never exported, synced, logged, shown again or sent anywhere except `oauth2.googleapis.com`**.
- Without a passphrase they are stored as plain text, like any extension setting: anyone with access to your OS account or browser profile could read them. Google treats this secret as non-confidential for installed apps, and it only works together with a signed-in test user, but the refresh token grants Drive access, so treat the profile accordingly.
- With a passphrase (min. 8 characters) the secret and refresh token are encrypted with AES-GCM (key from PBKDF2-SHA-256, 600 000 iterations). The derived key is kept only in memory (`chrome.storage.session`), so after you restart the browser sync pauses with status **Locked** until you enter the passphrase once. Forgot it? **Remove** the client and enter it again; nothing in Drive or your links is affected.
- The client can only be changed while Google Drive is disconnected. **Disconnect** revokes the grant at Google and deletes the refresh token. **Remove** deletes everything stored for the client.

### Option B (optional, for developers): client ID in `manifest.json` (Chrome Extension client, no secret)
Not needed for normal use: everything above is entered in Settings.
4. **Credentials → Create credentials → OAuth client ID** → type **Chrome Extension** → Item ID `opcgpedigbcmnndabghghifopdggpbkg`.
5. Copy the client ID into `manifest.json` → `oauth2.client_id` (replace `YOUR_CLIENT_ID.apps.googleusercontent.com`) and reload the extension on each computer.

A client saved in Settings (Option A) takes precedence over the one in `manifest.json`. Until one of them exists the Settings page shows "Setup required" and the Connect button explains what to do. Option B works only in Google Chrome; Option A also works in Chromium-based browsers that support `launchWebAuthFlow`.

### Why the full `drive` scope
`drive.file` only exposes files the app itself created, so it cannot browse or select an existing folder or find a sync file created by another install. A real folder picker needs `drive`. The hosted Google Picker is not usable in MV3 (remote script), so the extension has its own folder browser built on the Drive API. Trade-off: the token can read your whole Drive; the extension only ever reads folder names and the one sync file, and tokens are never stored by the extension, shown, logged, exported or synced (Chrome manages them).

## 2. Google sign-in method only: install & connect on each machine
**Windows and Ubuntu (identical):** copy/unzip this folder (same `manifest.json`), open `chrome://extensions`, enable Developer mode, **Load unpacked**, pick the folder. Confirm the ID shown equals `opcgpedigbcmnndabghghifopdggpbkg`. Sign in to Chrome? Not required; the Google account chosen in the consent window is used.
Open the popup → Settings → **Connect Google Drive** (opens a tab so sign-in doesn't close the popup) → **Choose…** a folder → review the preview → confirm. On the second machine choose the **same folder and file name** (default `important-links-sync.json`). First sync merges; nothing is overwritten without the preview and an optional backup.

## 3. Merge / conflict algorithm
Sync file: `{app, schema:1, revision, updatedAt, updatedBy, links[], tombstones{id:{deletedAt}}, quarantine[]}`.
- Records matched by stable `id`. Greater `updatedAt` wins; tie → lexicographically larger canonical JSON of the record (deterministic, same result on any device).
- `createdAt` = earliest; `openCount`/`lastOpenedAt` = max (usage counters aren't edits).
- Deletion: a tombstone wins if `deletedAt >= updatedAt`; a later edit (or Undo) resurrects the link and clears the tombstone. Tombstones are kept **180 days**, then pruned. A device offline longer than that gets a stale warning.
- Secondary duplicates (same normalized URL, different ids): identical content → collapsed to the oldest, loser tombstoned; different content → both kept with a warning.
- Remote data is untrusted: validated with the same limits; invalid entries are kept verbatim in `quarantine` and never destroyed; newer schema → sync refuses ("update the extension"); malformed file → never overwritten.
- Merge is commutative and idempotent (randomized property test).

## 4. Concurrency (best-effort)
Drive has no atomic compare-and-swap. Flow: lock (per device) → download → merge → re-check remote version → upload → read back and verify revision/device → on mismatch re-merge and retry (max 4). Local data is saved only after the remote write is verified; local edits made during sync are re-merged, not lost. Two devices writing at the same instant can still race; the verification step detects it and retries, but this is not a transaction.

## 5. Scheduling
On connect, on popup open (if stale >30 s), 5 s after local changes, every 15 min (`chrome.alarms`), retries with backoff after errors. Overlapping syncs are blocked.

## 6. Tests
`npm test` → 71 tests, all passing, using an in-memory fake Drive / fake shared folder and two fake devices (Windows/Ubuntu): all 17 required scenarios plus failure injection (expired token, offline, quota, 403, folder deleted, malformed/hostile/newer-schema remote, remote change mid-sync). A headless-browser UI smoke test covered both methods (connect/choose folder, preview, confirm, stop). The File System Access calls were also verified in real Chromium against the browser's private file system.
**Not tested with a real Google Drive sync app** (needs your machines): after setting up, change a link on Windows, wait for Drive to sync, press *Sync now* on Ubuntu.
**Not tested with real Google** (needs your credentials; the token endpoint and consent window are simulated, including PKCE, refresh, revocation, wrong secret and passphrase lock/unlock). Manual integration checklist: add the client in Settings, connect (consent opens), restart the browser and confirm sync resumes (or asks for the passphrase if set); connect on A; sync; connect on B with same folder → preview → merge; add on A → appears on B; edit on both → newest wins; delete on A → gone on B; go offline, edit, reconnect → syncs; revoke access at myaccount.google.com/permissions → app shows "reconnect"; change folder → preview shown, old folder untouched.

## 7. Limitations
- Synced folder: the real native folder dialog and Chrome's permission-persistence behavior after restart could not be exercised in the headless environment; the folder permission may need one click after restarts.
- `chrome.identity.getAuthToken` (Google sign-in method) works in Google Chrome only (not Chromium without Google sign-in support, Brave/Edge variants vary).
- Consent screen in Testing mode: test-user list and token expiry limits.
- Periodic alarm min granularity ~30 s; 15 min used. Drive listings are eventually consistent.
- If the chosen folder is deleted/unshared, status shows an error and local data is untouched.
- Revoking tokens or disconnecting does not delete the Drive file.
