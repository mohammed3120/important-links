# Important Links

Fast to save, easy to find, easy to open. A private, local-only link manager for Chrome (Manifest V3).

- Save the current tab or add a link by hand; duplicates are detected
- Instant search (Ctrl/Cmd+K) across title, URL, note, category, tags
- Pin, edit, copy, open in a new or current tab, delete with Undo
- Categories and tags (both optional), sorting, filters
- Import/export JSON and CSV; merge or replace on import
- Light, dark, or system theme; keyboard and screen-reader friendly
- Optional two-way sync between computers: through a folder your Google Drive app keeps in sync (no Google Cloud setup), or directly via the Drive API with your own Google Cloud client entered in Settings (client ID, secret, optional passphrase; advanced). See `docs/SYNC.md`
- No servers, no analytics. Data lives in `chrome.storage.local`

## Install
1. Open `chrome://extensions` and enable Developer mode
2. Click **Load unpacked** and choose this folder

Upgrading from v1: your old links are migrated automatically the first time you open the popup.

## Permissions
`storage` (save your links), `activeTab` (read the current tab when you click the icon), `favicon` (site icons from Chrome's local cache), `identity` (Google sign-in for Drive sync), `alarms` (periodic sync).

## Sync
Default: Settings → Sync → Synced folder → choose a folder inside Google Drive for desktop (or rclone on Linux). No Google Cloud project needed. The optional Google sign-in method needs your own OAuth client, entered entirely in the app under Settings → Google Cloud client (client ID, secret, optional passphrase; no file editing); see `docs/SYNC.md`.

## Tests
`npm test` (Node 20+, no dependencies).
