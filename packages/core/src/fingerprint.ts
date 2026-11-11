/**
 * Content fingerprint: a hash of the user's data that is independent of row IDs,
 * row order, bookmark slots, timestamps, and the zip/manifest wrapper.
 *
 * Two archives with the same fingerprint contain the same personal data, even if
 * their bytes differ. Used to detect "changed since last sync" (instead of file
 * timestamps) and to verify that a built archive round-trips without loss.
 */
import type { PlatformAdapter } from './platform.js';
import type { DatabaseContents } from './models.js';
import { bookmarkKey, locKeys, tagKey, tagMapKey } from './reconcile.js';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalContent(db: DatabaseContents): string {
  const keys = locKeys(db);
  const loc = (id: number | null): string | null => (id === null ? null : (keys.get(id) ?? `?${id}`));
  const markGuid = new Map(db.userMarks.map((m) => [m.UserMarkId, m.UserMarkGuid]));
  const noteGuid = new Map(db.notes.map((n) => [n.NoteId, n.Guid]));
  const tagById = new Map(db.tags.map((t) => [t.TagId, t]));
  const playlistLabel = new Map(db.playlistItems.map((p) => [p.PlaylistItemId, p.Label]));

  const ranges = new Map<number, string[]>();
  for (const r of db.blockRanges) {
    const list = ranges.get(r.UserMarkId) ?? [];
    list.push(JSON.stringify([r.BlockType, r.Identifier, r.StartToken, r.EndToken]));
    ranges.set(r.UserMarkId, list);
  }

  const sorted = (items: string[]): string[] => items.sort(cmp);

  const parts = {
    notes: sorted(
      db.notes.map((n) =>
        JSON.stringify([n.Guid, n.Title, n.Content, loc(n.LocationId), n.UserMarkId === null ? null : (markGuid.get(n.UserMarkId) ?? '?'), n.BlockType, n.BlockIdentifier]),
      ),
    ),
    highlights: sorted(
      db.userMarks.map((m) =>
        JSON.stringify([m.UserMarkGuid, m.ColorIndex, m.StyleIndex, m.Version, loc(m.LocationId), (ranges.get(m.UserMarkId) ?? []).sort(cmp)]),
      ),
    ),
    bookmarks: sorted(db.bookmarks.map((b) => bookmarkKey(b, keys))),
    tags: sorted(db.tags.map(tagKey)),
    tagMaps: sorted(
      db.tagMaps.map((tm) => {
        const k = tagMapKey(tm, tagById, noteGuid, keys);
        if (k) return k;
        const tag = tagById.get(tm.TagId);
        const label = tm.PlaylistItemId === null ? '' : (playlistLabel.get(tm.PlaylistItemId) ?? '?');
        return `${tag ? tagKey(tag) : '?'}#playlist:${label}`;
      }),
    ),
    inputFields: sorted(db.inputFields.map((f) => JSON.stringify([loc(f.LocationId), f.TextTag, f.Value]))),
    playlistItems: sorted(
      db.playlistItems.map((p) => JSON.stringify([p.Label, p.StartTrimOffsetTicks, p.EndTrimOffsetTicks, p.Accuracy, p.EndAction])),
    ),
    media: sorted(db.independentMedia.map((m) => m.Hash)),
  };
  return JSON.stringify(parts);
}

export async function contentFingerprint(adapter: PlatformAdapter, db: DatabaseContents): Promise<string> {
  return adapter.hashSHA256(new TextEncoder().encode(canonicalContent(db)));
}
