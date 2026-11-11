import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  reconcile,
  runSync,
  parseJWLibrary,
  contentFingerprint,
  MemoryCloud,
  MemoryLocalStore,
  type DatabaseContents,
} from '../src/index.js';
import { nodeAdapter } from './node-adapter.js';

function db(over: Partial<DatabaseContents> = {}): DatabaseContents {
  return {
    locations: [
      { LocationId: 1, BookNumber: 1, ChapterNumber: 1, DocumentId: null, Track: null, IssueTagNumber: 0, KeySymbol: 'nwtsty', MepsLanguage: 0, Type: 0, Title: null },
    ],
    notes: [],
    userMarks: [],
    blockRanges: [],
    bookmarks: [],
    tags: [],
    tagMaps: [],
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
    androidMetadata: null,
    ...over,
  };
}

const mark = (id: number, guid: string, color: number) => ({
  UserMarkId: id, ColorIndex: color, LocationId: 1, StyleIndex: 0, UserMarkGuid: guid, Version: 1,
});
const range = (id: number, markId: number, start: number) => ({
  BlockRangeId: id, BlockType: 1, Identifier: 1, StartToken: start, EndToken: start + 3, UserMarkId: markId,
});

describe('reconcile: highlights', () => {
  const base = db({ userMarks: [mark(1, 'h1', 1), mark(2, 'h2', 2)], blockRanges: [range(1, 1, 0), range(2, 2, 10)] });

  it('propagates a highlight deleted locally when remote left it unchanged', () => {
    const local = db({ userMarks: [mark(1, 'h1', 1)], blockRanges: [range(1, 1, 0)] });
    const res = reconcile(base, local, base);
    expect(res.remote.userMarks.map((m) => m.UserMarkGuid)).toEqual(['h1']);
    expect(res.remote.blockRanges.every((r) => r.UserMarkId === 1)).toBe(true);
    expect(res.report.propagatedDeletions.fromLocal).toBe(1);
  });

  it('keeps a highlight deleted on one side but recolored on the other (edit wins)', () => {
    const local = db({ userMarks: [mark(1, 'h1', 1)], blockRanges: [range(1, 1, 0)] });
    const remote = db({ userMarks: [mark(1, 'h1', 1), mark(2, 'h2', 5)], blockRanges: [range(1, 1, 0), range(2, 2, 10)] });
    const res = reconcile(base, local, remote);
    expect(res.remote.userMarks.map((m) => m.UserMarkGuid)).toContain('h2');
    expect(res.report.conflicts).toEqual([{ kind: 'highlight-edit-vs-delete', key: 'h2', deletedOn: 'local' }]);
  });

  it('makes the unchanged side adopt a one-sided recolor and its ranges', () => {
    const remote = db({ userMarks: [mark(1, 'h1', 7), mark(2, 'h2', 2)], blockRanges: [range(1, 1, 5), range(2, 2, 10)] });
    const res = reconcile(base, base, remote);
    const adopted = res.local.userMarks.find((m) => m.UserMarkGuid === 'h1')!;
    expect(adopted.ColorIndex).toBe(7);
    expect(res.local.blockRanges.find((r) => r.UserMarkId === 1)!.StartToken).toBe(5);
    expect(res.report.conflicts).toEqual([]);
  });

  it('reports a conflict when both sides recolored differently', () => {
    const l = db({ userMarks: [mark(1, 'h1', 3), mark(2, 'h2', 2)], blockRanges: base.blockRanges });
    const r = db({ userMarks: [mark(1, 'h1', 4), mark(2, 'h2', 2)], blockRanges: base.blockRanges });
    expect(reconcile(base, l, r).report.conflicts.map((c) => c.kind)).toEqual(['highlight-edited-both']);
  });

  it('un-links notes from a deleted highlight instead of leaving a dangling reference', () => {
    const note = { NoteId: 1, Guid: 'n', UserMarkId: 2, LocationId: 1, Title: 't', Content: 'c', LastModified: '', Created: '', BlockType: 0, BlockIdentifier: null };
    const b = db({ ...base, notes: [note] });
    const local = db({ userMarks: [mark(1, 'h1', 1)], blockRanges: [range(1, 1, 0)], notes: [note] });
    const res = reconcile(b, local, b);
    expect(res.remote.notes[0]!.UserMarkId).toBeNull();
  });
});

describe('reconcile: tag assignments', () => {
  const note = (id: number, guid: string) => ({ NoteId: id, Guid: guid, UserMarkId: null, LocationId: 1, Title: guid, Content: guid, LastModified: '', Created: '', BlockType: 0, BlockIdentifier: null });
  const tag = { TagId: 1, Type: 1, Name: 'Study' };
  const tm = (id: number, noteId: number, pos: number) => ({ TagMapId: id, PlaylistItemId: null, LocationId: null, NoteId: noteId, TagId: 1, Position: pos });
  const base = db({ notes: [note(1, 'a'), note(2, 'b')], tags: [tag], tagMaps: [tm(1, 1, 0), tm(2, 2, 1)] });

  it('propagates removal of a single tag assignment but keeps the tag', () => {
    const local = db({ notes: base.notes, tags: [tag], tagMaps: [tm(1, 1, 0)] });
    const res = reconcile(base, local, base);
    expect(res.remote.tags).toHaveLength(1);
    expect(res.remote.tagMaps.map((t) => t.NoteId)).toEqual([1]);
  });

  it('does not delete a tag the other device added assignments to', () => {
    const local = db({ notes: base.notes, tags: [], tagMaps: [] });
    const remote = db({ notes: [...base.notes, note(3, 'c')], tags: [tag], tagMaps: [...base.tagMaps, tm(3, 3, 2)] });
    const res = reconcile(base, local, remote);
    expect(res.remote.tags).toHaveLength(1);
    expect(res.report.conflicts.map((c) => c.kind)).toEqual(['tag-edit-vs-delete']);
  });

  it('removes a note\'s tag assignments when the note itself is deleted', () => {
    const local = db({ notes: [note(2, 'b')], tags: [tag], tagMaps: [tm(2, 2, 1)] });
    const res = reconcile(base, local, base);
    expect(res.remote.notes.map((n) => n.Guid)).toEqual(['b']);
    expect(res.remote.tagMaps.every((t) => t.NoteId === 2)).toBe(true);
  });
});

describe('sync with the real sample backup', () => {
  const sample = new Uint8Array(readFileSync(resolve(__dirname, 'fixtures/sample.jwlibrary')));

  it('uploads, adopts on another device, and the content is identical', async () => {
    const cloud = new MemoryCloud();
    const a = new MemoryLocalStore('a', 'Tablet');
    const b = new MemoryLocalStore('b', 'Laptop');
    a.local = sample;
    let n = 0;
    const newId = () => `id${++n}`;
    await runSync({ adapter: nodeAdapter, cloud, local: a, newId });
    await runSync({ adapter: nodeAdapter, cloud, local: b, newId });

    const original = await contentFingerprint(nodeAdapter, (await parseJWLibrary(nodeAdapter, sample)).database);
    const onB = await contentFingerprint(nodeAdapter, (await parseJWLibrary(nodeAdapter, b.local!)).database);
    expect(onB).toBe(original);
    // And a repeat sync is a no-op.
    expect((await runSync({ adapter: nodeAdapter, cloud, local: a, newId })).outcome).toBe('no-changes');
  });
});
