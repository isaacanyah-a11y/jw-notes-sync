/**
 * Repeated syncing must be stable: merging the same inputs again (or merging an
 * already-merged result with an older copy of one of its parents) must not
 * grow, duplicate, or rewrite data. These regressions were found in the M1 audit.
 */
import { describe, it, expect } from 'vitest';
import { mergeBookmarks, mergeNotes, IdMap } from '../src/index.js';
import type { Bookmark, Note } from '../src/index.js';

function bm(over: Partial<Bookmark> & { BookmarkId: number }): Bookmark {
  return {
    LocationId: 1,
    PublicationLocationId: 1,
    Slot: 0,
    Title: 'Bookmark',
    Snippet: null,
    BlockType: 0,
    BlockIdentifier: null,
    ...over,
  };
}

function note(over: Partial<Note> & { NoteId: number; Guid: string }): Note {
  return {
    UserMarkId: null,
    LocationId: null,
    Title: null,
    Content: null,
    LastModified: '2026-01-01T00:00:00Z',
    Created: '2026-01-01T00:00:00Z',
    BlockType: 0,
    BlockIdentifier: null,
    ...over,
  };
}

function identityMaps(): { a: IdMap; b: IdMap } {
  const a = new IdMap();
  const b = new IdMap();
  for (const m of [a, b]) {
    m.set('Location', 1, 1);
    m.set('Location', 2, 2);
  }
  return { a, b };
}

describe('bookmark re-sync stability', () => {
  it('does not duplicate a bookmark that already exists at another slot', () => {
    // Device 1 has X@0. Device 2 has Y@0. First merge shifts Y to slot 1.
    const x = bm({ BookmarkId: 1, LocationId: 1, Title: 'X', Slot: 0 });
    const y = bm({ BookmarkId: 1, LocationId: 2, Title: 'Y', Slot: 0 });
    let maps = identityMaps();
    const first = mergeBookmarks([x], [y], maps.a, maps.b);
    expect(first).toHaveLength(2);

    // Next sync: the merged result is merged again with device 2's unchanged copy.
    maps = identityMaps();
    const second = mergeBookmarks(first, [y], maps.a, maps.b);
    expect(second).toHaveLength(2);
  });

  it('is idempotent over many repeated syncs', () => {
    const x = bm({ BookmarkId: 1, LocationId: 1, Title: 'X', Slot: 0 });
    const y = bm({ BookmarkId: 1, LocationId: 2, Title: 'Y', Slot: 0 });
    let current = [x];
    for (let i = 0; i < 5; i++) {
      const maps = identityMaps();
      current = mergeBookmarks(current, [y], maps.a, maps.b);
    }
    expect(current).toHaveLength(2);
  });
});

describe('note re-sync stability (concatenate strategy)', () => {
  const opts = { deviceNameA: 'Tablet', deviceNameB: 'Laptop', strategy: 'concatenate' as const };

  it('does not nest headers when merging a concatenated note with an original parent', () => {
    const a = note({ NoteId: 1, Guid: 'g', Content: 'from tablet', Title: 'T1' });
    const b = note({ NoteId: 1, Guid: 'g', Content: 'from laptop', Title: 'T2' });
    let maps = identityMaps();
    const first = mergeNotes([a], [b], maps.a, maps.b, opts);
    expect(first).toHaveLength(1);

    maps = identityMaps();
    const second = mergeNotes(first, [b], maps.a, maps.b, opts);
    expect(second[0]!.Content).toBe(first[0]!.Content);
    expect(second[0]!.Title).toBe(first[0]!.Title);

    maps = identityMaps();
    const third = mergeNotes(first, [a], maps.a, maps.b, opts);
    expect(third[0]!.Content).toBe(first[0]!.Content);
    expect(third[0]!.Title).toBe(first[0]!.Title);
  });

  it('keeps both texts exactly once after repeated syncs', () => {
    const a = note({ NoteId: 1, Guid: 'g', Content: 'alpha' });
    const b = note({ NoteId: 1, Guid: 'g', Content: 'beta' });
    let current = [a];
    for (let i = 0; i < 4; i++) {
      const maps = identityMaps();
      current = mergeNotes(current, [b], maps.a, maps.b, opts);
    }
    const content = current[0]!.Content!;
    expect(content.split('alpha')).toHaveLength(2);
    expect(content.split('beta')).toHaveLength(2);
  });

  it('never drops text when a third edit arrives', () => {
    const a = note({ NoteId: 1, Guid: 'g', Content: 'alpha' });
    const b = note({ NoteId: 1, Guid: 'g', Content: 'beta' });
    let maps = identityMaps();
    const merged = mergeNotes([a], [b], maps.a, maps.b, opts);
    const c = note({ NoteId: 1, Guid: 'g', Content: 'gamma' });
    maps = identityMaps();
    const next = mergeNotes(merged, [c], maps.a, maps.b, { ...opts, deviceNameB: 'Phone' });
    for (const text of ['alpha', 'beta', 'gamma']) {
      expect(next[0]!.Content).toContain(text);
    }
  });
});
