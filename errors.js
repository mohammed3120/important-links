/** Error types shared by the sync modules. `code` is stable and drives UI status. */

export class DriveError extends Error {
  /** code: auth | cancelled | network | quota | forbidden | not_found | setup | locked | invalid | api */
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'DriveError';
    this.code = code;
    this.status = status;
  }
}

export class SyncDataError extends Error {
  /** code: malformed | incompatible */
  constructor(code, message) {
    super(message);
    this.name = 'SyncDataError';
    this.code = code;
  }
}

export class SyncError extends Error {
  /** code: not_connected | no_folder | folder_missing | conflict */
  constructor(code, message) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

/** Turns anything thrown into { code, message } that is safe to show. Never includes tokens. */
export function describeError(err) {
  if (err && typeof err.code === 'string' && err.message) return { code: err.code, message: err.message };
  return { code: 'unknown', message: 'Something unexpected went wrong during sync.' };
}
