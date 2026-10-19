// Pure: turns stored sync config into a status for the UI. Shared by the popup and the service worker.
const ATTENTION = new Set(['malformed', 'incompatible', 'folder_missing', 'forbidden']);

export function computeStatus(c, { clientConfigured = true, locked = false } = {}) {
  const folder = c.mode === 'folder';
  if (!folder && !clientConfigured) return { state: 'setup', label: 'Setup required', detail: 'Add your Google OAuth client ID under “Google Cloud client” below (see docs/SYNC.md).' };
  if (!folder && locked && c.connected) return { state: 'auth', label: 'Locked', detail: 'Enter your passphrase under “Google Cloud client” to resume syncing. Nothing is lost.' };
  if (!c.connected) return { state: 'disconnected', label: folder ? 'Not set up' : 'Not connected' };
  if (c.needsAuth && folder) return { state: 'auth', label: 'Folder access needed', detail: 'Chrome needs you to allow access to the sync folder again. Nothing is lost.' };
  if (c.needsAuth) return { state: 'auth', label: 'Authentication required', detail: 'Google access expired or was revoked. Reconnect to continue syncing.' };
  if (!c.folder || !c.confirmed) return { state: 'folder', label: folder ? 'Choose a sync folder' : 'Choose a Drive folder', detail: 'Pick where the sync file should live.' };
  if (c.syncing) return { state: 'syncing', label: 'Synchronizing…' };
  if (c.lastError) {
    const attention = ATTENTION.has(c.lastError.code);
    return {
      state: attention ? 'attention' : 'error',
      label: attention ? 'Cloud data requires attention' : 'Synchronization failed',
      detail: `${c.lastError.message}${c.dirty ? ' Your local changes are safe and not yet uploaded.' : ''}`,
    };
  }
  if (c.dirty) return { state: 'pending', label: 'Local changes pending upload' };
  if (!c.lastSyncAt) return { state: 'ready', label: 'Ready to synchronize' };
  return { state: 'ok', label: 'Synchronized' };
}
