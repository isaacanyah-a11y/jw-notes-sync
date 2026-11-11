import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildArchive,
  parseJWLibrary,
  runSync,
  contentFingerprint,
  MemoryCloud,
  MemoryLocalStore,
  SyncError,
  type DatabaseContents,
  type Note,
} from '../src/index.js';
import { nodeAdapter } from './node-adapter.js';

// ── fixtures ────────────────────────────────────────────────

interface Spec {
  notes?: { guid: string; title?: string; content: string }[];
  bookmarks?: string[];
  tags?: string[];
  taggedNotes?: { tag: string; guid: string }[];
}

function contentsFrom(spec: Spec): DatabaseContents {
  const notes: Note[] = (spec.notes ?? []).map((n, i) => ({
    NoteId: i + 1,
    Guid: n.guid,
    UserMarkId: null,
    LocationId: 1,
    Title: n.title ?? n.guid,
    Content: n.content,
    LastModified: '2026-01-01T00:00:00Z',
    Created: '2026-01-01T00:00:00Z',
    BlockType: 0,
    BlockIdentifier: null,
  }));
  const tags = (spec.tags ?? []).map((name, i) => ({ TagId: i + 1, Type: 1, Name: name }));
  const tagMaps = (spec.taggedNotes ?? []).map((t, i) => ({
    TagMapId: i + 1,
    PlaylistItemId: null,
    LocationId: null,
    NoteId: notes.findIndex((n) => n.Guid === t.guid) + 1,
    TagId: tags.findIndex((x) => x.Name === t.tag) + 1,
    Position: i,
  }));
  return {
    locations: [
      { LocationId: 1, BookNumber: 1, ChapterNumber: 1, DocumentId: null, Track: null, IssueTagNumber: 0, KeySymbol: 'nwtsty', MepsLanguage: 0, Type: 0, Title: null },
      { LocationId: 2, BookNumber: null, ChapterNumber: null, DocumentId: null, Track: null, IssueTagNumber: 0, KeySymbol: 'nwtsty', MepsLanguage: 0, Type: 1, Title: null },
    ],
    notes,
    userMarks: [],
    blockRanges: [],
    bookmarks: (spec.bookmarks ?? []).map((title, i) => ({
      BookmarkId: i + 1, LocationId: 1, PublicationLocationId: 2, Slot: i, Title: title, Snippet: null, BlockType: 0, BlockIdentifier: null,
    })),
    tags,
    tagMaps,
    inputFields: [],
    independentMedia: [],
    playlistItems: [],
    playlistItemAccuracies: [],
    playlistItemIndependentMediaMaps: [],
    playlistItemLocationMaps: [],
    playlistItemMarkers: [],
    playlistItemMarkerBibleVerseMaps: [],
    playlistItemMarkerParagraphMaps: [],
    lastModified: '',
    androidMetadata: 'en_US',
  };
}

const build = (spec: Spec) => buildArchive(nodeAdapter, contentsFrom(spec));

async function contentOf(store: MemoryLocalStore): Promise<DatabaseContents> {
  return (await parseJWLibrary(nodeAdapter, store.local!)).database;
}
const guids = async (store: MemoryLocalStore) => (await contentOf(store)).notes.map((n) => n.Guid).sort();

async function fp(store: MemoryLocalStore) {
  return contentFingerprint(nodeAdapter, await contentOf(store));
}

let cloud: MemoryCloud;
let tablet: MemoryLocalStore;
let laptop: MemoryLocalStore;
let phone: MemoryLocalStore;
let ids = 0;

const sync = (local: MemoryLocalStore, extra: Record<string, unknown> = {}) =>
  runSync({ adapter: nodeAdapter, cloud, local, newId: () => `id${++ids}`, ...extra });

const many = (n: number, prefix = 'n') =>
  Array.from({ length: n }, (_, i) => ({ guid: `${prefix}${i}`, content: `text ${i}` }));

beforeEach(() => {
  cloud = new MemoryCloud();
  tablet = new MemoryLocalStore('dev-tablet', 'Tablet');
  laptop = new MemoryLocalStore('dev-laptop', 'Laptop');
  phone = new MemoryLocalStore('dev-phone', 'Phone');
  ids = 0;
});

// ── basics ──────────────────────────────────────────────────

describe('first sync and adoption', () => {
  it('uploads the first device, verifies it, and records base, recovery and history', async () => {
    tablet.local = await build({ notes: [{ guid: 'a', content: 'one' }] });
    const original = tablet.local.slice();

    const res = await sync(tablet);

    expect(res).toMatchObject({ outcome: 'success', action: 'uploaded', version: 1 });
    expect(cloud.head?.version).toBe(1);
    expect(tablet.base?.snapshotId).toBe(cloud.head?.snapshotId);
    expect(tablet.recoveries.some((r) => r.label === 'pre-sync' && r.bytes.length === original.length)).toBe(true);
    expect(tablet.history[0]).toMatchObject({ outcome: 'success', action: 'uploaded' });
  });

  it('lets an empty device adopt the cloud copy', async () => {
    tablet.local = await build({ notes: [{ guid: 'a', content: 'one' }] });
    await sync(tablet);
    const res = await sync(laptop);
    expect(res.action).toBe('downloaded');
    expect(await guids(laptop)).toEqual(['a']);
  });

  it('does nothing when there is neither local data nor cloud data', async () => {
    const res = await sync(tablet);
    expect(res.outcome).toBe('no-changes');
    expect(cloud.head).toBeNull();
  });
});

describe('two-way merging across devices', () => {
  it('merges different changes from two devices and converges', async () => {
    tablet.local = await build({ notes: [{ guid: 'a', content: 'one' }] });
    await sync(tablet);
    laptop.local = await build({ notes: [{ guid: 'b', content: 'two' }] });
    const res = await sync(laptop);
    expect(res.action).toBe('merged');
    await sync(tablet); // fast-forward
    expect(await guids(laptop)).toEqual(['a', 'b']);
    expect(await guids(tablet)).toEqual(['a', 'b']);
    expect(await fp(tablet)).toBe(await fp(laptop));
  });

  it('converges across three devices adding data in turn', async () => {
    tablet.local = await build({ notes: [{ guid: 't', content: 'tablet' }], bookmarks: ['bt'] });
    await sync(tablet);
    laptop.local = await build({ notes: [{ guid: 'l', content: 'laptop' }], bookmarks: ['bl'] });
    await sync(laptop);
    phone.local = await build({ notes: [{ guid: 'p', content: 'phone' }], tags: ['Study'] });
    await sync(phone);
    await sync(tablet);
    await sync(laptop);
    for (const d of [tablet, laptop, phone]) expect(await guids(d)).toEqual(['l', 'p', 't']);
    const [a, b, c] = [await fp(tablet), await fp(laptop), await fp(phone)];
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('is a fixed point: repeated syncs change nothing and do not bump the version', async () => {
    tablet.local = await build({ notes: [{ guid: 'a', content: 'x' }], bookmarks: ['bm'] });
    await sync(tablet);
    laptop.local = await build({ notes: [{ guid: 'b', content: 'y' }], bookmarks: ['other'] });
    await sync(laptop);
    await sync(tablet);
    const version = cloud.head!.version;
    const before = await fp(tablet);
    for (let i = 0; i < 4; i++) {
      for (const d of [tablet, laptop]) {
        const r = await sync(d);
        expect(r.outcome).toBe('no-changes');
      }
    }
    expect(cloud.head!.version).toBe(version);
    expect(await fp(tablet)).toBe(before);
  });

  it('keeps both versions of a note edited on two devices exactly once, stably', async () => {
    tablet.local = await build({ notes: [{ guid: 'n', content: 'original' }] });
    await sync(tablet);
    await sync(laptop);
    tablet.local = await build({ notes: [{ guid: 'n', content: 'tablet edit' }] });
    laptop.local = await build({ notes: [{ guid: 'n', content: 'laptop edit' }] });
    await sync(tablet);
    const res = await sync(laptop);
    expect(res.conflicts.map((c) => c.kind)).toEqual(['note-edited-both']);
    await sync(tablet);
    for (let i = 0; i < 3; i++) {
      await sync(laptop);
      await sync(tablet);
    }
    const note = (await contentOf(laptop)).notes[0]!;
    expect(note.Content!.split('tablet edit')).toHaveLength(2);
    expect(note.Content!.split('laptop edit')).toHaveLength(2);
    expect(await fp(tablet)).toBe(await fp(laptop));
  });

  it('applies a one-sided edit without conflict', async () => {
    tablet.local = await build({ notes: [{ guid: 'n', content: 'v1' }] });
    await sync(tablet);
    await sync(laptop);
    tablet.local = await build({ notes: [{ guid: 'n', content: 'v2' }] });
    laptop.local = await build({ notes: [{ guid: 'n', content: 'v1' }, { guid: 'extra', content: 'e' }] });
    await sync(tablet);
    const res = await sync(laptop);
    expect(res.conflicts).toEqual([]);
    const content = await contentOf(laptop);
    expect(content.notes.find((n) => n.Guid === 'n')!.Content).toBe('v2');
    expect(content.notes.some((n) => n.Guid === 'extra')).toBe(true);
  });
});

// ── deletions ───────────────────────────────────────────────

describe('deletions', () => {
  it('propagates a deletion to a device that did not change that item', async () => {
    tablet.local = await build({ notes: [{ guid: 'a', content: '1' }, { guid: 'b', content: '2' }], bookmarks: ['x', 'y'], tags: ['T'] });
    await sync(tablet);
    await sync(laptop);
    // Tablet deletes note a, bookmark x and the tag; laptop adds a new note.
    tablet.local = await build({ notes: [{ guid: 'b', content: '2' }], bookmarks: ['y'] });
    laptop.local = await build({
      notes: [{ guid: 'a', content: '1' }, { guid: 'b', content: '2' }, { guid: 'c', content: '3' }],
      bookmarks: ['x', 'y'],
      tags: ['T'],
    });
    await sync(tablet);
    await sync(laptop);
    await sync(tablet);
    const l = await contentOf(laptop);
    expect(l.notes.map((n) => n.Guid).sort()).toEqual(['b', 'c']);
    expect(l.bookmarks.map((b) => b.Title)).toEqual(['y']);
    expect(l.tags).toEqual([]);
    expect(await fp(tablet)).toBe(await fp(laptop));
  });

  it('keeps an item that was deleted on one device but edited on another, and reports it', async () => {
    tablet.local = await build({ notes: [{ guid: 'a', content: 'v1' }, { guid: 'b', content: 'keep' }] });
    await sync(tablet);
    await sync(laptop);
    tablet.local = await build({ notes: [{ guid: 'b', content: 'keep' }] }); // deleted a
    laptop.local = await build({ notes: [{ guid: 'a', content: 'v2 edited' }, { guid: 'b', content: 'keep' }] });
    await sync(tablet);
    const res = await sync(laptop);
    expect(res.conflicts.map((c) => c.kind)).toContain('note-edit-vs-delete');
    expect((await contentOf(laptop)).notes.find((n) => n.Guid === 'a')!.Content).toBe('v2 edited');
  });

  it('refuses to propagate a wiped device without confirmation, then allows it when confirmed', async () => {
    tablet.local = await build({ notes: many(12) });
    await sync(tablet);
    await sync(laptop);
    laptop.local = await build({ notes: [] }); // e.g. app data reset
    const headBefore = cloud.head!.snapshotId;

    await expect(sync(laptop)).rejects.toMatchObject({ code: 'needs-confirmation' });
    expect(cloud.head!.snapshotId).toBe(headBefore);
    expect(laptop.history[0]).toMatchObject({ outcome: 'needs-confirmation' });

    await sync(laptop, { allowMassDeletion: true });
    expect(cloud.head!.snapshotId).not.toBe(headBefore);
  });

  it('refuses a mass deletion on the merge path too', async () => {
    tablet.local = await build({ notes: many(12) });
    await sync(tablet);
    await sync(laptop);
    tablet.local = await build({ notes: [...many(12), { guid: 'new', content: 'n' }] });
    await sync(tablet);
    laptop.local = await build({ notes: [] });
    await expect(sync(laptop)).rejects.toMatchObject({ code: 'needs-confirmation' });
    expect((await guids(tablet)).length).toBe(13);
  });
});

// ── failure and recovery ────────────────────────────────────

describe('interrupted and failed syncs', () => {
  beforeEach(async () => {
    tablet.local = await build({ notes: [{ guid: 'a', content: 'one' }] });
  });

  it('a network failure changes nothing and reports a safe message', async () => {
    cloud.failNext.getHead = true;
    const err = await sync(tablet).catch((e) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err.code).toBe('network');
    expect(err.message).not.toContain('simulated');
    expect(cloud.head).toBeNull();
    expect(tablet.base).toBeNull();
    expect(tablet.history[0]).toMatchObject({ outcome: 'failed', errorCode: 'network' });
    // Retry works.
    expect((await sync(tablet)).action).toBe('uploaded');
  });

  it('a truncated upload is detected, cleaned up, never published, and retry succeeds', async () => {
    cloud.truncateNextUpload = true;
    await expect(sync(tablet)).rejects.toMatchObject({ code: 'upload-verify-failed' });
    expect(cloud.head).toBeNull();
    expect(cloud.snapshots.size).toBe(0);
    expect(tablet.base).toBeNull();
    expect((await sync(tablet)).outcome).toBe('success');
  });

  it('a failed publish leaves no half state', async () => {
    cloud.failNext.publishHead = true;
    await expect(sync(tablet)).rejects.toMatchObject({ code: 'network' });
    expect(cloud.head).toBeNull();
    expect(tablet.base).toBeNull();
  });

  it('a corrupted download is rejected and local data is untouched', async () => {
    await sync(tablet);
    cloud.corruptNextDownload = true;
    const before = laptop.local;
    await expect(sync(laptop)).rejects.toMatchObject({ code: 'download-corrupt' });
    expect(laptop.local).toBe(before);
    expect(laptop.base).toBeNull();
    expect((await sync(laptop)).action).toBe('downloaded');
  });

  it('if saving locally fails after the cloud was updated, the next sync converges without duplication', async () => {
    tablet.failNextCommit = true;
    await expect(sync(tablet)).rejects.toMatchObject({ code: 'local-storage' });
    expect(cloud.head?.version).toBe(1); // cloud is safe and valid
    const r = await sync(tablet);
    expect(r.outcome).toBe('no-changes');
    expect(cloud.head?.version).toBe(1);
    expect(tablet.base?.version).toBe(1);
  });

  it('rejects a damaged local backup without touching anything', async () => {
    tablet.local = new Uint8Array([1, 2, 3, 4]);
    await expect(sync(tablet)).rejects.toMatchObject({ code: 'invalid-archive' });
    expect(cloud.head).toBeNull();
  });

  it('refuses to run concurrently on one device', async () => {
    tablet.locked = true;
    await expect(sync(tablet)).rejects.toMatchObject({ code: 'busy' });
    expect(cloud.head).toBeNull();
  });

  it('always keeps the original local backup and the merged result as recovery copies', async () => {
    await sync(tablet);
    laptop.local = await build({ notes: [{ guid: 'b', content: 'two' }] });
    await sync(laptop);
    const labels = laptop.recoveries.map((r) => r.label);
    expect(labels).toContain('pre-sync');
    expect(labels).toContain('merged');
  });
});

// ── simultaneous devices ────────────────────────────────────

describe('simultaneous changes from different devices', () => {
  it('never overwrites a head published while we were syncing; it retries and merges both', async () => {
    tablet.local = await build({ notes: [{ guid: 'a', content: 'one' }] });
    await sync(tablet); // v1
    laptop.local = await build({ notes: [{ guid: 'l', content: 'laptop' }] });
    await sync(laptop); // v2
    await sync(tablet);

    tablet.local = await build({
      notes: [{ guid: 'a', content: 'one' }, { guid: 'l', content: 'laptop' }, { guid: 't', content: 'tablet new' }],
    });
    // While the tablet is about to publish, the phone publishes first.
    cloud.beforePublish = async () => {
      phone.local = await build({ notes: [{ guid: 'p', content: 'phone new' }] });
      await sync(phone);
    };
    const res = await sync(tablet);

    expect(res.outcome).toBe('success');
    const g = await guids(tablet);
    expect(g).toEqual(expect.arrayContaining(['a', 'l', 'p', 't']));
    await sync(phone);
    await sync(laptop);
    expect(await fp(phone)).toBe(await fp(tablet));
    expect(await fp(laptop)).toBe(await fp(tablet));
    // No orphaned snapshot from the lost race.
    expect(cloud.snapshots.size).toBe(cloud.head!.version);
  });

  it('gives up with a clear error when it keeps losing the race, changing nothing', async () => {
    tablet.local = await build({ notes: [{ guid: 'a', content: 'one' }] });
    cloud.publishHead = async () => 'conflict'; // another device always wins
    await expect(sync(tablet, { maxAttempts: 3 })).rejects.toMatchObject({ code: 'head-conflict' });
    expect(tablet.base).toBeNull();
    expect(cloud.head).toBeNull();
    expect(cloud.snapshots.size).toBe(0); // no orphaned uploads left behind
  });
});
