/**
 * The sync engine. One-click sync, scheduled sync and automatic sync all call
 * `runSync`; nothing platform-specific lives here.
 *
 * Guarantees:
 *  - Cloud snapshots are immutable; the head moves only by compare-and-swap.
 *  - Local state changes only through the atomic `commitSynced`, and only AFTER
 *    the cloud upload has been read back and verified and the head published.
 *  - Every sync keeps recovery copies of the local archive and the merged result.
 *  - Failures leave local and cloud state unchanged and are written to history
 *    with a safe message (no tokens, no raw provider errors).
 *  - A device that appears to have wiped its data does not delete the other
 *    devices' data without explicit confirmation.
 */
import type { PlatformAdapter } from '../platform.js';
import type { DatabaseContents, JWLibraryArchive } from '../models.js';
import { parseJWLibrary } from '../parser.js';
import { buildArchive } from '../builder.js';
import { mergeAll } from '../merge-all.js';
import { DEFAULT_MERGE_CONFIG, type MergeConfig } from '../merge-config.js';
import { contentFingerprint } from '../fingerprint.js';
import { bookmarkKey, locKeys, reconcile, tagKey, type SyncConflict } from '../reconcile.js';
import type {
  BaseRecord,
  CloudProvider,
  LocalStore,
  SyncAction,
  SyncErrorCode,
  SyncHead,
  SyncHistoryEntry,
} from './types.js';

export class SyncError extends Error {
  constructor(
    public readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

const MESSAGES: Record<SyncErrorCode, string> = {
  busy: 'A sync is already running on this device.',
  network: 'Could not reach Google Drive. Check your connection and try again. Nothing was changed.',
  'download-corrupt': 'The downloaded data did not pass its integrity check. Nothing was changed; try again.',
  'upload-verify-failed': 'The upload could not be verified. Nothing was changed; try again.',
  'invalid-archive': 'A backup file is not a valid JW Library backup. Nothing was changed.',
  'validation-failed': 'The merged result failed safety checks, so it was not saved or uploaded. Your data is unchanged.',
  'head-conflict': 'Another device kept syncing at the same time. Nothing was lost; please try again.',
  'needs-confirmation':
    'This device has far fewer items than at the last sync. To protect your other devices, nothing was changed. Confirm to continue.',
  'local-storage': 'Could not save on this device. Cloud data is safe; please try again.',
  unexpected: 'Sync failed unexpectedly. Nothing was changed.',
};

export interface SyncOptions {
  adapter: PlatformAdapter;
  cloud: CloudProvider;
  local: LocalStore;
  config?: MergeConfig;
  now?: () => Date;
  newId?: () => string;
  /** User explicitly confirmed propagating a large deletion. */
  allowMassDeletion?: boolean;
  /** How many times to re-run if another device publishes concurrently. */
  maxAttempts?: number;
}

export interface SyncResult {
  outcome: 'success' | 'no-changes';
  action: SyncAction;
  version: number | null;
  conflicts: SyncConflict[];
}

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? defaultId;
  const startedAt = now().toISOString();
  const recoveryIds: string[] = [];
  let seenVersion: number | null = null;
  let deviceId = 'unknown';

  const record = async (
    outcome: SyncHistoryEntry['outcome'],
    action: SyncAction,
    message: string,
    conflicts: SyncConflict[],
    errorCode?: SyncErrorCode,
    version: number | null = seenVersion,
  ): Promise<void> => {
    try {
      await opts.local.appendHistory({
        id: newId(),
        startedAt,
        finishedAt: now().toISOString(),
        deviceId,
        outcome,
        action,
        version,
        conflicts,
        errorCode,
        message,
        recoveryIds: [...recoveryIds],
      });
    } catch {
      // History is best-effort; it must never mask the real outcome.
    }
  };

  const release = await opts.local.tryLock();
  if (!release) {
    throw new SyncError('busy', MESSAGES.busy); // not recorded: another run owns the history
  }

  try {
    deviceId = await opts.local.deviceId();
    const result = await attemptLoop(opts, now, newId, recoveryIds, (v) => (seenVersion = v));
    await record(
      result.outcome,
      result.action,
      result.outcome === 'no-changes' ? 'Already up to date.' : 'Sync complete.',
      result.conflicts,
      undefined,
      result.version,
    );
    return result;
  } catch (err) {
    const e = err instanceof SyncError ? err : new SyncError('unexpected', MESSAGES.unexpected);
    await record(
      e.code === 'needs-confirmation' ? 'needs-confirmation' : 'failed',
      'none',
      e.message,
      [],
      e.code,
    );
    throw e;
  } finally {
    try {
      await release();
    } catch {
      /* lock release is best-effort; leases should expire */
    }
  }
}

async function attemptLoop(
  opts: SyncOptions,
  now: () => Date,
  newId: () => string,
  recoveryIds: string[],
  setSeenVersion: (v: number | null) => void,
): Promise<SyncResult> {
  const { adapter, cloud, local } = opts;
  const maxAttempts = opts.maxAttempts ?? 3;
  const config = opts.config ?? DEFAULT_MERGE_CONFIG;
  const deviceId = await local.deviceId();
  const deviceLabel = await local.deviceLabel();

  const cloudCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      throw new SyncError('network', MESSAGES.network);
    }
  };
  const localCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError('local-storage', MESSAGES['local-storage']);
    }
  };

  let preSyncSaved = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const head = await cloudCall(() => cloud.getHead());
    setSeenVersion(head?.version ?? null);
    const localBytes = await localCall(() => local.readLocalArchive());
    const base = await localCall(() => local.getBase());

    // Preserve the original local backup before anything else happens.
    if (localBytes && !preSyncSaved) {
      recoveryIds.push(await localCall(() => local.saveRecovery('pre-sync', localBytes)));
      preSyncSaved = true;
    }

    // Local files come straight from JW Library, whose own backups can carry a
    // manifest hash mismatch, so they are parsed leniently and normalized (rebuilt
    // with a correct hash) before anything is uploaded.
    const localArch = localBytes ? await validateArchive(adapter, localBytes, false) : null;
    const localFp = localArch ? await contentFingerprint(adapter, localArch.database) : null;

    // ── Nothing in the cloud yet ──
    if (!head) {
      if (!localBytes || !localArch || !localFp) {
        return { outcome: 'no-changes', action: 'none', version: null, conflicts: [] };
      }
      const normalized = await normalize(adapter, localArch);
      const published = await uploadAndPublish(normalized, localFp, null);
      if (published === 'conflict') continue;
      return { outcome: 'success', action: 'uploaded', version: published.version, conflicts: [] };
    }

    // ── Download and verify the cloud head ──
    const remoteBytes = await cloudCall(() => cloud.getSnapshot(head.snapshotId));
    if ((await adapter.hashSHA256(remoteBytes)) !== head.hash) {
      throw new SyncError('download-corrupt', MESSAGES['download-corrupt']);
    }
    const remoteArch = await validateArchive(adapter, remoteBytes);
    const remoteFp = await contentFingerprint(adapter, remoteArch.database);
    if (remoteFp !== head.fingerprint) {
      throw new SyncError('download-corrupt', MESSAGES['download-corrupt']);
    }
    const headBase: BaseRecord = {
      version: head.version,
      snapshotId: head.snapshotId,
      hash: head.hash,
      fingerprint: head.fingerprint,
    };

    // ── This device has nothing: adopt the cloud copy ──
    if (!localArch || !localFp) {
      await localCall(() => local.commitSynced({ archive: remoteBytes, base: headBase }));
      return { outcome: 'success', action: 'downloaded', version: head.version, conflicts: [] };
    }

    // ── Same content already: just record the base ──
    if (localFp === remoteFp) {
      if (base?.snapshotId !== head.snapshotId) {
        await localCall(() => local.commitSynced({ archive: remoteBytes, base: headBase }));
      }
      return { outcome: 'no-changes', action: 'none', version: head.version, conflicts: [] };
    }

    const remoteUnchangedSinceBase = base?.snapshotId === head.snapshotId;
    const localUnchangedSinceBase = base !== null && localFp === base.fingerprint;

    // ── Only local changed: upload local as-is ──
    if (remoteUnchangedSinceBase) {
      // Uploading local replaces the cloud content, so a wiped/reset device must
      // not silently erase everyone else's data.
      const baseBytes = await localCall(() => local.readBaseArchive());
      if (baseBytes && !opts.allowMassDeletion) {
        const baseDb = (await validateArchive(adapter, baseBytes)).database;
        const { report } = reconcile(baseDb, localArch.database, remoteArch.database);
        if (report.massDeletion.length > 0) {
          throw new SyncError('needs-confirmation', MESSAGES['needs-confirmation']);
        }
      }
      const normalized = await normalize(adapter, localArch);
      const published = await uploadAndPublish(normalized, localFp, head);
      if (published === 'conflict') continue;
      return { outcome: 'success', action: 'uploaded', version: published.version, conflicts: [] };
    }

    // ── Only remote changed: fast-forward to the cloud copy ──
    if (localUnchangedSinceBase) {
      await localCall(() => local.commitSynced({ archive: remoteBytes, base: headBase }));
      return { outcome: 'success', action: 'downloaded', version: head.version, conflicts: [] };
    }

    // ── Both changed (or no base yet): reconcile and merge ──
    let baseDb: DatabaseContents | null = null;
    if (base) {
      const baseBytes = await localCall(() => local.readBaseArchive());
      if (baseBytes) baseDb = (await validateArchive(adapter, baseBytes)).database;
    }

    let a = localArch.database;
    let b = remoteArch.database;
    let conflicts: SyncConflict[] = [];
    if (baseDb) {
      const rec = reconcile(baseDb, a, b);
      if (rec.report.massDeletion.length > 0 && !opts.allowMassDeletion) {
        throw new SyncError('needs-confirmation', MESSAGES['needs-confirmation']);
      }
      a = rec.local;
      b = rec.remote;
      conflicts = rec.report.conflicts;
    }

    const { contents, mediaFiles } = mergeAll(a, b, {
      config,
      deviceNameA: deviceLabel,
      deviceNameB: head.updatedByLabel,
      mediaA: localArch.mediaFiles,
      mediaB: remoteArch.mediaFiles,
    });

    let mergedBytes: Uint8Array;
    try {
      mergedBytes = await buildArchive(adapter, contents, { mediaFiles });
    } catch {
      throw new SyncError('validation-failed', MESSAGES['validation-failed']);
    }
    const mergedFp = await validateMerged(adapter, mergedBytes, contents, [a, b]);

    recoveryIds.push(await localCall(() => local.saveRecovery('merged', mergedBytes)));

    const published = await uploadAndPublish(mergedBytes, mergedFp, head);
    if (published === 'conflict') continue;
    return { outcome: 'success', action: 'merged', version: published.version, conflicts };
  }

  throw new SyncError('head-conflict', MESSAGES['head-conflict']);

  // ── upload → verify → publish → commit locally ──
  async function uploadAndPublish(
    bytes: Uint8Array,
    fingerprint: string,
    current: SyncHead | null,
  ): Promise<SyncHead | 'conflict'> {
    const hash = await adapter.hashSHA256(bytes);
    const snapshotId = `snap-${newId()}`;
    await cloudCall(() => cloud.putSnapshot(snapshotId, bytes));

    // Read back what the cloud actually stored; never trust the write alone.
    const back = await cloudCall(() => cloud.getSnapshot(snapshotId));
    if ((await adapter.hashSHA256(back)) !== hash) {
      await cleanup(snapshotId);
      throw new SyncError('upload-verify-failed', MESSAGES['upload-verify-failed']);
    }

    const head: SyncHead = {
      formatVersion: 1,
      version: (current?.version ?? 0) + 1,
      snapshotId,
      hash,
      fingerprint,
      sizeBytes: bytes.byteLength,
      updatedAt: now().toISOString(),
      updatedByDevice: deviceId,
      updatedByLabel: deviceLabel,
    };
    const outcome = await cloudCall(() => cloud.publishHead(head));
    if (outcome === 'conflict') {
      await cleanup(snapshotId);
      return 'conflict';
    }

    // Cloud is now authoritative and verified. Commit locally (atomic).
    await localCall(() =>
      local.commitSynced({
        archive: bytes,
        base: { version: head.version, snapshotId, hash, fingerprint },
      }),
    );
    return head;
  }

  async function cleanup(snapshotId: string): Promise<void> {
    try {
      await cloud.deleteSnapshot(snapshotId);
    } catch {
      /* orphaned snapshots are harmless and can be garbage collected later */
    }
  }
}

// ── validation ───────────────────────────────────────────────

/** Strict validation of an archive: structure, manifest hash, schema, parseable. */
export async function validateArchive(
  adapter: PlatformAdapter,
  bytes: Uint8Array,
  strictHash = true,
): Promise<JWLibraryArchive> {
  try {
    const archive = await parseJWLibrary(adapter, bytes);
    if (strictHash) {
      // parseJWLibrary only warns on a hash mismatch (real-world files). Anything
      // we download or generate must have integrity, so damage is rejected here.
      const zip = await adapter.extractZip(bytes);
      const dbBytes = zip.files.get(archive.manifest.userDataBackup.databaseName);
      if (!dbBytes || (await adapter.hashSHA256(dbBytes)) !== archive.manifest.userDataBackup.hash) {
        throw new Error('hash');
      }
    }
    return archive;
  } catch {
    throw new SyncError('invalid-archive', MESSAGES['invalid-archive']);
  }
}

/** Rebuild an archive from parsed contents so it has a correct hash and full v14 schema. */
async function normalize(adapter: PlatformAdapter, arch: JWLibraryArchive): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await buildArchive(adapter, arch.database, { mediaFiles: arch.mediaFiles });
  } catch {
    throw new SyncError('validation-failed', MESSAGES['validation-failed']);
  }
  await validateMerged(adapter, bytes, arch.database, [arch.database]);
  return bytes;
}

/**
 * Validate a freshly built merge result: it must parse, pass the strict checks,
 * round-trip to the same content it was built from, and contain every item that
 * was present on either side after reconciliation (no silent loss).
 */
async function validateMerged(
  adapter: PlatformAdapter,
  bytes: Uint8Array,
  expected: DatabaseContents,
  inputs: DatabaseContents[],
): Promise<string> {
  try {
    const reparsed = await validateArchive(adapter, bytes);
    const fp = await contentFingerprint(adapter, reparsed.database);
    if (fp !== (await contentFingerprint(adapter, expected))) throw new Error('round-trip');

    const out = reparsed.database;
    const outNotes = new Set(out.notes.map((n) => n.Guid));
    const outMarks = new Set(out.userMarks.map((m) => m.UserMarkGuid));
    const outTags = new Set(out.tags.map(tagKey));
    const outKeys = locKeys(out);
    const outBookmarks = new Set(out.bookmarks.map((x) => bookmarkKey(x, outKeys)));
    for (const input of inputs) {
      const keys = locKeys(input);
      if (input.notes.some((n) => !outNotes.has(n.Guid))) throw new Error('note lost');
      if (input.userMarks.some((m) => !outMarks.has(m.UserMarkGuid))) throw new Error('highlight lost');
      if (input.tags.some((t) => !outTags.has(tagKey(t)))) throw new Error('tag lost');
      if (input.bookmarks.some((x) => !outBookmarks.has(bookmarkKey(x, keys)))) throw new Error('bookmark lost');
    }
    return fp;
  } catch {
    throw new SyncError('validation-failed', MESSAGES['validation-failed']);
  }
}
