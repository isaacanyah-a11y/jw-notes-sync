/**
 * Sync data model and platform interfaces.
 *
 * Terminology:
 *  - local archive : the .jwlibrary this device currently considers its latest.
 *  - head          : small JSON record in the cloud naming the latest synced snapshot.
 *  - snapshot      : an immutable .jwlibrary in the cloud. Never overwritten.
 *  - base          : the last snapshot THIS device successfully synced (kept locally).
 *                    Three-way reconciliation compares local and remote against it.
 */
import type { SyncConflict } from '../reconcile.js';

export interface SyncHead {
  formatVersion: 1;
  /** Monotonic counter. Each published head is exactly previous version + 1. */
  version: number;
  snapshotId: string;
  /** SHA-256 of the snapshot's bytes (transport integrity). */
  hash: string;
  /** Content fingerprint of the snapshot (see fingerprint.ts). */
  fingerprint: string;
  sizeBytes: number;
  updatedAt: string;
  updatedByDevice: string;
  updatedByLabel: string;
}

/** Cloud storage. Implementations: Google Drive appDataFolder (M3), in-memory fake (tests). */
export interface CloudProvider {
  getHead(): Promise<SyncHead | null>;
  /** Store an immutable snapshot. Must be idempotent for the same id. */
  putSnapshot(id: string, bytes: Uint8Array): Promise<void>;
  getSnapshot(id: string): Promise<Uint8Array>;
  /**
   * Compare-and-swap publish. Succeeds ONLY if the current head version is
   * `head.version - 1` (or there is no head and `head.version === 1`).
   * Returns 'conflict' if another device published first. Must never silently
   * overwrite a newer head.
   */
  publishHead(head: SyncHead): Promise<'published' | 'conflict'>;
  listSnapshots(): Promise<string[]>;
  deleteSnapshot(id: string): Promise<void>;
}

export interface BaseRecord {
  version: number;
  snapshotId: string;
  hash: string;
  fingerprint: string;
}

export type SyncOutcome = 'success' | 'no-changes' | 'failed' | 'needs-confirmation' | 'busy';
export type SyncAction = 'uploaded' | 'downloaded' | 'merged' | 'none';

export type SyncErrorCode =
  | 'busy'
  | 'network'
  | 'download-corrupt'
  | 'upload-verify-failed'
  | 'invalid-archive'
  | 'validation-failed'
  | 'head-conflict'
  | 'needs-confirmation'
  | 'local-storage'
  | 'unexpected';

export interface SyncHistoryEntry {
  id: string;
  startedAt: string;
  finishedAt: string;
  deviceId: string;
  outcome: SyncOutcome;
  action: SyncAction;
  /** Cloud version after this sync (or the version seen, for failures). */
  version: number | null;
  conflicts: SyncConflict[];
  errorCode?: SyncErrorCode;
  /** Safe, user-presentable message. Never contains tokens or raw provider errors. */
  message: string;
  /** Recovery copies saved during this sync. */
  recoveryIds: string[];
}

/** Device-local persistence. Implementations: expo-file-system (mobile), OPFS/IndexedDB (web). */
export interface LocalStore {
  deviceId(): Promise<string>;
  deviceLabel(): Promise<string>;
  /** Single-flight lock. Returns a release function, or null if a sync is already running. */
  tryLock(): Promise<(() => Promise<void>) | null>;
  getBase(): Promise<BaseRecord | null>;
  readBaseArchive(): Promise<Uint8Array | null>;
  readLocalArchive(): Promise<Uint8Array | null>;
  /** Keep a recoverable copy. Must durably persist before resolving. Returns its id. */
  saveRecovery(label: string, bytes: Uint8Array): Promise<string>;
  /**
   * ATOMIC: replace the local archive, the base archive and the base record
   * together, or change nothing. Must never leave a half-written state, and must
   * not discard the previous local archive without keeping a recovery copy.
   */
  commitSynced(args: { archive: Uint8Array; base: BaseRecord }): Promise<void>;
  appendHistory(entry: SyncHistoryEntry): Promise<void>;
}
