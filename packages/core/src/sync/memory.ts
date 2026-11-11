/**
 * In-memory CloudProvider and LocalStore with failure injection.
 * Used by tests and handy for app-level tests; not for production use.
 */
import type { BaseRecord, CloudProvider, LocalStore, SyncHead, SyncHistoryEntry } from './types.js';

export class MemoryCloud implements CloudProvider {
  head: SyncHead | null = null;
  snapshots = new Map<string, Uint8Array>();

  /** Fail the next call to the named method with an error. */
  failNext: Partial<Record<'getHead' | 'putSnapshot' | 'getSnapshot' | 'publishHead', boolean>> = {};
  /** Corrupt the bytes returned by the next getSnapshot (simulates a damaged download). */
  corruptNextDownload = false;
  /** Store truncated bytes on the next putSnapshot (simulates an interrupted upload). */
  truncateNextUpload = false;
  /** Runs just before publishHead is evaluated (simulates another device racing us). */
  beforePublish: (() => Promise<void>) | null = null;

  private maybeFail(name: keyof MemoryCloud['failNext']): void {
    if (this.failNext[name]) {
      this.failNext[name] = false;
      throw new Error('simulated network failure');
    }
  }

  async getHead(): Promise<SyncHead | null> {
    this.maybeFail('getHead');
    return this.head ? { ...this.head } : null;
  }

  async putSnapshot(id: string, bytes: Uint8Array): Promise<void> {
    this.maybeFail('putSnapshot');
    const stored = this.truncateNextUpload ? bytes.slice(0, Math.floor(bytes.length / 2)) : bytes.slice();
    this.truncateNextUpload = false;
    this.snapshots.set(id, stored);
  }

  async getSnapshot(id: string): Promise<Uint8Array> {
    this.maybeFail('getSnapshot');
    const data = this.snapshots.get(id);
    if (!data) throw new Error('not found');
    const out = data.slice();
    if (this.corruptNextDownload) {
      this.corruptNextDownload = false;
      const i = Math.floor(out.length / 2);
      out[i] = (out[i] ?? 0) ^ 0xff;
    }
    return out;
  }

  async publishHead(head: SyncHead): Promise<'published' | 'conflict'> {
    if (this.beforePublish) {
      const hook = this.beforePublish;
      this.beforePublish = null;
      await hook();
    }
    this.maybeFail('publishHead');
    const current = this.head?.version ?? 0;
    if (head.version !== current + 1) return 'conflict';
    this.head = { ...head };
    return 'published';
  }

  async listSnapshots(): Promise<string[]> {
    return [...this.snapshots.keys()];
  }

  async deleteSnapshot(id: string): Promise<void> {
    this.snapshots.delete(id);
  }
}

export class MemoryLocalStore implements LocalStore {
  local: Uint8Array | null = null;
  base: BaseRecord | null = null;
  baseArchive: Uint8Array | null = null;
  recoveries: { id: string; label: string; bytes: Uint8Array }[] = [];
  history: SyncHistoryEntry[] = [];
  locked = false;
  /** Make the next commitSynced throw before changing anything (atomic failure). */
  failNextCommit = false;

  constructor(
    private readonly id: string,
    private readonly label: string,
  ) {}

  async deviceId(): Promise<string> {
    return this.id;
  }
  async deviceLabel(): Promise<string> {
    return this.label;
  }

  async tryLock(): Promise<(() => Promise<void>) | null> {
    if (this.locked) return null;
    this.locked = true;
    return async () => {
      this.locked = false;
    };
  }

  async getBase(): Promise<BaseRecord | null> {
    return this.base ? { ...this.base } : null;
  }
  async readBaseArchive(): Promise<Uint8Array | null> {
    return this.baseArchive ? this.baseArchive.slice() : null;
  }
  async readLocalArchive(): Promise<Uint8Array | null> {
    return this.local ? this.local.slice() : null;
  }

  async saveRecovery(label: string, bytes: Uint8Array): Promise<string> {
    const id = `rec-${this.recoveries.length + 1}`;
    this.recoveries.push({ id, label, bytes: bytes.slice() });
    return id;
  }

  async commitSynced(args: { archive: Uint8Array; base: BaseRecord }): Promise<void> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error('simulated disk failure');
    }
    // Keep the replaced archive recoverable before swapping.
    if (this.local) await this.saveRecovery('replaced-by-sync', this.local);
    this.local = args.archive.slice();
    this.baseArchive = args.archive.slice();
    this.base = { ...args.base };
  }

  async appendHistory(entry: SyncHistoryEntry): Promise<void> {
    this.history.unshift(entry);
  }
}
