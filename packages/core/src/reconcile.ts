/**
 * Three-way reconciliation against the last synced snapshot ("base").
 *
 * The plain merge engine is a two-way union: it cannot tell "deleted on this
 * device" from "never existed here", so deletions would always be resurrected,
 * and a one-sided edit could not be told apart from a conflict.
 *
 * `reconcile(base, local, remote)` fixes that WITHOUT changing the merge engine.
 * It returns adjusted copies of `local` and `remote` such that the existing
 * union merge produces the right result:
 *
 *  - Deleted on one side, unchanged on the other  -> removed from the other side.
 *  - Deleted on one side, EDITED on the other     -> kept (edit wins; reported as a conflict).
 *  - Edited on one side only                      -> the other side adopts the edit.
 *  - Edited on both sides differently             -> left alone; the merge strategy resolves it
 *                                                    non-destructively; reported as a conflict.
 *
 * Entities are matched by stable identity (GUIDs / natural keys), never by
 * row IDs or timestamps. Covered: notes, highlights (+ranges), bookmarks, tags,
 * tag assignments for notes and locations. Playlists and input fields are
 * union-only for now (deletions there do not propagate).
 *
 * Safety: if a side appears to have deleted a large share of its data (e.g. a
 * freshly reset device), `massDeletion` is reported so the caller can refuse to
 * propagate it without explicit confirmation.
 */
import type { BlockRange, DatabaseContents, Note, Tag, TagMap, UserMark } from './models.js';
import { locationNaturalKey } from './merge-locations.js';

export type Side = 'local' | 'remote';

export interface SyncConflict {
  kind:
    | 'note-edited-both'
    | 'note-edit-vs-delete'
    | 'highlight-edited-both'
    | 'highlight-edit-vs-delete'
    | 'tag-edit-vs-delete';
  /** Stable identity (GUID or natural key) of the entity. */
  key: string;
  /** Side that deleted it, for edit-vs-delete conflicts. */
  deletedOn?: Side;
}

export interface MassDeletion {
  /** The side whose deletions would be propagated to the other side. */
  side: Side;
  entity: 'notes' | 'highlights' | 'bookmarks' | 'tags';
  count: number;
  baseCount: number;
}

export interface ReconcileReport {
  conflicts: SyncConflict[];
  massDeletion: MassDeletion[];
  /** Entities removed from `remote` because `local` deleted them, and vice versa. */
  propagatedDeletions: { fromLocal: number; fromRemote: number };
}

export interface ReconcileResult {
  local: DatabaseContents;
  remote: DatabaseContents;
  report: ReconcileReport;
}

/** Thresholds for flagging a suspicious mass deletion. */
export const MASS_DELETION_MIN_COUNT = 10;
export const MASS_DELETION_MIN_RATIO = 0.5;

// ── helpers ──────────────────────────────────────────────────

export function locKeys(db: DatabaseContents): Map<number, string> {
  return new Map(db.locations.map((l) => [l.LocationId, locationNaturalKey(l)]));
}

function cloneContents(db: DatabaseContents): DatabaseContents {
  return {
    ...db,
    notes: db.notes.map((n) => ({ ...n })),
    userMarks: db.userMarks.map((m) => ({ ...m })),
    blockRanges: db.blockRanges.map((r) => ({ ...r })),
    bookmarks: db.bookmarks.map((b) => ({ ...b })),
    tags: db.tags.map((t) => ({ ...t })),
    tagMaps: db.tagMaps.map((t) => ({ ...t })),
  };
}

const noteSig = (n: Note): string => JSON.stringify([n.Title, n.Content]);
const markSig = (m: UserMark, ranges: BlockRange[]): string =>
  JSON.stringify([
    m.ColorIndex,
    m.StyleIndex,
    m.Version,
    ranges
      .map((r) => [r.BlockType, r.Identifier, r.StartToken, r.EndToken])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);

export const tagKey = (t: Tag): string => `${t.Type}|${t.Name}`;

function rangesByMark(db: DatabaseContents): Map<number, BlockRange[]> {
  const map = new Map<number, BlockRange[]>();
  for (const r of db.blockRanges) {
    const list = map.get(r.UserMarkId);
    if (list) list.push(r);
    else map.set(r.UserMarkId, [r]);
  }
  return map;
}

/** Identity of a bookmark independent of its slot and row IDs. */
export function bookmarkKey(b: DatabaseContents['bookmarks'][number], keys: Map<number, string>): string {
  return JSON.stringify([
    keys.get(b.PublicationLocationId) ?? `?${b.PublicationLocationId}`,
    keys.get(b.LocationId) ?? `?${b.LocationId}`,
    b.Title,
    b.Snippet,
    b.BlockType,
    b.BlockIdentifier,
  ]);
}

/** Identity of a tag assignment to a note or location (playlist targets are not tracked). */
export function tagMapKey(
  tm: TagMap,
  tags: Map<number, Tag>,
  noteGuids: Map<number, string>,
  keys: Map<number, string>,
): string | null {
  const tag = tags.get(tm.TagId);
  if (!tag) return null;
  if (tm.NoteId !== null) {
    const g = noteGuids.get(tm.NoteId);
    return g ? `${tagKey(tag)}#note:${g}` : null;
  }
  if (tm.LocationId !== null) {
    const k = keys.get(tm.LocationId);
    return k ? `${tagKey(tag)}#loc:${k}` : null;
  }
  return null;
}

// ── main ─────────────────────────────────────────────────────

export function reconcile(
  base: DatabaseContents,
  localIn: DatabaseContents,
  remoteIn: DatabaseContents,
): ReconcileResult {
  const local = cloneContents(localIn);
  const remote = cloneContents(remoteIn);
  const conflicts: SyncConflict[] = [];
  const massDeletion: MassDeletion[] = [];
  const propagated = { fromLocal: 0, fromRemote: 0 };

  const sides: Record<Side, DatabaseContents> = { local, remote };
  const otherOf = (s: Side): Side => (s === 'local' ? 'remote' : 'local');

  // Removal sets, applied once at the end so lookups stay consistent.
  const removeNotes: Record<Side, Set<string>> = { local: new Set(), remote: new Set() };
  const removeMarks: Record<Side, Set<string>> = { local: new Set(), remote: new Set() };
  const removeBookmarks: Record<Side, Set<string>> = { local: new Set(), remote: new Set() };
  const removeTags: Record<Side, Set<string>> = { local: new Set(), remote: new Set() };
  const removeTagMaps: Record<Side, Set<string>> = { local: new Set(), remote: new Set() };

  const note = (db: DatabaseContents) => new Map(db.notes.map((n) => [n.Guid, n]));
  const mark = (db: DatabaseContents) => new Map(db.userMarks.map((m) => [m.UserMarkGuid, m]));

  // ── Notes ──
  {
    const b = note(base);
    const m: Record<Side, Map<string, Note>> = { local: note(local), remote: note(remote) };
    const deletedBy: Record<Side, number> = { local: 0, remote: 0 };
    for (const [guid, baseNote] of b) {
      const bs = noteSig(baseNote);
      const l = m.local.get(guid);
      const r = m.remote.get(guid);
      for (const side of ['local', 'remote'] as Side[]) {
        const mine = m[side].get(guid);
        const theirs = m[otherOf(side)].get(guid);
        if (mine || !theirs) continue; // not deleted on `side`, or deleted on both
        if (noteSig(theirs) === bs) {
          removeNotes[otherOf(side)].add(guid);
          deletedBy[side]++;
        } else {
          conflicts.push({ kind: 'note-edit-vs-delete', key: guid, deletedOn: side });
        }
      }
      if (l && r) {
        const lc = noteSig(l) !== bs;
        const rc = noteSig(r) !== bs;
        if (lc && !rc) Object.assign(r, { Title: l.Title, Content: l.Content, LastModified: l.LastModified });
        else if (rc && !lc) Object.assign(l, { Title: r.Title, Content: r.Content, LastModified: r.LastModified });
        else if (lc && rc && noteSig(l) !== noteSig(r)) conflicts.push({ kind: 'note-edited-both', key: guid });
      }
    }
    for (const side of ['local', 'remote'] as Side[]) {
      flagMass(massDeletion, side, 'notes', deletedBy[side], b.size);
    }
  }

  // ── Highlights ──
  {
    const bm = mark(base);
    const br = rangesByMark(base);
    const m: Record<Side, Map<string, UserMark>> = { local: mark(local), remote: mark(remote) };
    const rr: Record<Side, Map<number, BlockRange[]>> = { local: rangesByMark(local), remote: rangesByMark(remote) };
    const deletedBy: Record<Side, number> = { local: 0, remote: 0 };
    for (const [guid, baseMark] of bm) {
      const bs = markSig(baseMark, br.get(baseMark.UserMarkId) ?? []);
      const sigOf = (side: Side, mk: UserMark) => markSig(mk, rr[side].get(mk.UserMarkId) ?? []);
      for (const side of ['local', 'remote'] as Side[]) {
        const mine = m[side].get(guid);
        const theirs = m[otherOf(side)].get(guid);
        if (mine || !theirs) continue;
        if (sigOf(otherOf(side), theirs) === bs) {
          removeMarks[otherOf(side)].add(guid);
          deletedBy[side]++;
        } else {
          conflicts.push({ kind: 'highlight-edit-vs-delete', key: guid, deletedOn: side });
        }
      }
      const l = m.local.get(guid);
      const r = m.remote.get(guid);
      if (l && r) {
        const lc = sigOf('local', l) !== bs;
        const rc = sigOf('remote', r) !== bs;
        const adopt = (from: Side, src: UserMark, dst: UserMark) => {
          const to = otherOf(from);
          Object.assign(dst, { ColorIndex: src.ColorIndex, StyleIndex: src.StyleIndex, Version: src.Version });
          const dstDb = sides[to];
          dstDb.blockRanges = dstDb.blockRanges.filter((x) => x.UserMarkId !== dst.UserMarkId);
          let nextId = dstDb.blockRanges.reduce((mx, x) => Math.max(mx, x.BlockRangeId), 0) + 1;
          for (const range of rr[from].get(src.UserMarkId) ?? []) {
            dstDb.blockRanges.push({ ...range, BlockRangeId: nextId++, UserMarkId: dst.UserMarkId });
          }
        };
        if (lc && !rc) adopt('local', l, r);
        else if (rc && !lc) adopt('remote', r, l);
        else if (lc && rc && sigOf('local', l) !== sigOf('remote', r)) conflicts.push({ kind: 'highlight-edited-both', key: guid });
      }
    }
    for (const side of ['local', 'remote'] as Side[]) {
      flagMass(massDeletion, side, 'highlights', deletedBy[side], bm.size);
    }
  }

  // ── Bookmarks ──
  {
    const baseKeys = locKeys(base);
    const keysOf: Record<Side, Map<number, string>> = { local: locKeys(local), remote: locKeys(remote) };
    const bset = new Set(base.bookmarks.map((x) => bookmarkKey(x, baseKeys)));
    const present: Record<Side, Set<string>> = {
      local: new Set(local.bookmarks.map((x) => bookmarkKey(x, keysOf.local))),
      remote: new Set(remote.bookmarks.map((x) => bookmarkKey(x, keysOf.remote))),
    };
    const deletedBy: Record<Side, number> = { local: 0, remote: 0 };
    for (const key of bset) {
      for (const side of ['local', 'remote'] as Side[]) {
        if (!present[side].has(key) && present[otherOf(side)].has(key)) {
          removeBookmarks[otherOf(side)].add(key);
          deletedBy[side]++;
        }
      }
    }
    for (const side of ['local', 'remote'] as Side[]) {
      flagMass(massDeletion, side, 'bookmarks', deletedBy[side], bset.size);
    }
  }

  // ── Tags and tag assignments ──
  {
    const tagsOf = (db: DatabaseContents) => new Map(db.tags.map((t) => [t.TagId, t]));
    const guidsOf = (db: DatabaseContents) => new Map(db.notes.map((n) => [n.NoteId, n.Guid]));
    const mapKeys = (db: DatabaseContents): Set<string> => {
      const tags = tagsOf(db);
      const g = guidsOf(db);
      const k = locKeys(db);
      const out = new Set<string>();
      for (const tm of db.tagMaps) {
        const key = tagMapKey(tm, tags, g, k);
        if (key) out.add(key);
      }
      return out;
    };
    const bTags = new Set(base.tags.map(tagKey));
    const present: Record<Side, Set<string>> = {
      local: new Set(local.tags.map(tagKey)),
      remote: new Set(remote.tags.map(tagKey)),
    };
    const bMapKeys = mapKeys(base);
    const sideMapKeys: Record<Side, Set<string>> = { local: mapKeys(local), remote: mapKeys(remote) };
    const deletedBy: Record<Side, number> = { local: 0, remote: 0 };

    for (const key of bTags) {
      for (const side of ['local', 'remote'] as Side[]) {
        const other = otherOf(side);
        if (present[side].has(key) || !present[other].has(key)) continue;
        // Tag deleted on `side`. Propagate only if `other` did not add assignments to it.
        const added = [...sideMapKeys[other]].some((k) => k.startsWith(`${key}#`) && !bMapKeys.has(k));
        if (added) {
          conflicts.push({ kind: 'tag-edit-vs-delete', key, deletedOn: side });
        } else {
          removeTags[other].add(key);
          deletedBy[side]++;
        }
      }
    }
    // Assignment removals (tag itself still exists on both sides).
    for (const key of bMapKeys) {
      for (const side of ['local', 'remote'] as Side[]) {
        const other = otherOf(side);
        const tagOfKey = key.slice(0, key.indexOf('#'));
        if (removeTags[other].has(tagOfKey)) continue;
        if (!sideMapKeys[side].has(key) && sideMapKeys[other].has(key) && present[side].has(tagOfKey)) {
          removeTagMaps[other].add(key);
        }
      }
    }
    for (const side of ['local', 'remote'] as Side[]) {
      flagMass(massDeletion, side, 'tags', deletedBy[side], bTags.size);
    }
  }

  // ── Apply removals ──
  for (const side of ['local', 'remote'] as Side[]) {
    const db = sides[side];
    const keys = locKeys(db);

    // Tag assignments first (needs original tag/note ids).
    {
      const tags = new Map(db.tags.map((t) => [t.TagId, t]));
      const guids = new Map(db.notes.map((n) => [n.NoteId, n.Guid]));
      db.tagMaps = db.tagMaps.filter((tm) => {
        const key = tagMapKey(tm, tags, guids, keys);
        return !(key && removeTagMaps[side].has(key));
      });
    }
    // Tags.
    if (removeTags[side].size > 0) {
      const dead = new Set(db.tags.filter((t) => removeTags[side].has(tagKey(t))).map((t) => t.TagId));
      db.tags = db.tags.filter((t) => !dead.has(t.TagId));
      db.tagMaps = db.tagMaps.filter((tm) => !dead.has(tm.TagId));
    }
    // Bookmarks.
    if (removeBookmarks[side].size > 0) {
      db.bookmarks = db.bookmarks.filter((b) => !removeBookmarks[side].has(bookmarkKey(b, keys)));
    }
    // Notes (and their tag assignments).
    if (removeNotes[side].size > 0) {
      const dead = new Set(db.notes.filter((n) => removeNotes[side].has(n.Guid)).map((n) => n.NoteId));
      db.notes = db.notes.filter((n) => !dead.has(n.NoteId));
      db.tagMaps = db.tagMaps.filter((tm) => tm.NoteId === null || !dead.has(tm.NoteId));
    }
    // Highlights (their ranges; notes keep existing but lose the link).
    if (removeMarks[side].size > 0) {
      const dead = new Set(db.userMarks.filter((m) => removeMarks[side].has(m.UserMarkGuid)).map((m) => m.UserMarkId));
      db.userMarks = db.userMarks.filter((m) => !dead.has(m.UserMarkId));
      db.blockRanges = db.blockRanges.filter((r) => !dead.has(r.UserMarkId));
      db.notes = db.notes.map((n) => (n.UserMarkId !== null && dead.has(n.UserMarkId) ? { ...n, UserMarkId: null } : n));
    }
  }

  propagated.fromLocal =
    removeNotes.remote.size + removeMarks.remote.size + removeBookmarks.remote.size + removeTags.remote.size;
  propagated.fromRemote =
    removeNotes.local.size + removeMarks.local.size + removeBookmarks.local.size + removeTags.local.size;

  return { local, remote, report: { conflicts, massDeletion, propagatedDeletions: propagated } };
}

function flagMass(
  out: MassDeletion[],
  side: Side,
  entity: MassDeletion['entity'],
  count: number,
  baseCount: number,
): void {
  const large = count >= MASS_DELETION_MIN_COUNT && count / baseCount >= MASS_DELETION_MIN_RATIO;
  // Small libraries: wiping everything (e.g. a reset device) is always suspicious.
  const wipe = baseCount >= 3 && count === baseCount;
  if (large || wipe) {
    out.push({ side, entity, count, baseCount });
  }
}
