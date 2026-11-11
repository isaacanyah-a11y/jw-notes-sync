import type { Note } from './models.js';
import type { IdMap } from './id-map.js';
import type { NoteConflictStrategy } from './merge-config.js';

const SEPARATOR = '\n\n---\n\n';

/**
 * Remap a Note's foreign keys using the provided IdMap.
 */
function remapNote(note: Note, newId: number, idMap: IdMap): Note {
  return {
    ...note,
    NoteId: newId,
    LocationId: note.LocationId !== null ? idMap.get('Location', note.LocationId) : null,
    UserMarkId: note.UserMarkId !== null ? idMap.get('UserMark', note.UserMarkId) : null,
  };
}

/**
 * Format a concatenated note from two conflicting versions.
 */
interface Segment {
  header: string;
  body: string;
}

const HEADER_RE = /^\[[^\n]+ — [^\n]+\]$/;

/**
 * Split a note into segments. A previously concatenated note
 * (`[device — date]\nbody` blocks joined by SEPARATOR) yields one segment per
 * block; any other note is a single segment with a synthesized header.
 */
function toSegments(content: string | null, device: string, date: string): Segment[] {
  const text = content ?? '';
  if (text.includes(SEPARATOR)) {
    const parts = text.split(SEPARATOR);
    const segments: Segment[] = [];
    for (const part of parts) {
      const nl = part.indexOf('\n');
      const header = nl === -1 ? part : part.slice(0, nl);
      if (!HEADER_RE.test(header)) return [{ header: `[${device} — ${date}]`, body: text }];
      segments.push({ header, body: nl === -1 ? '' : part.slice(nl + 1) });
    }
    return segments;
  }
  return [{ header: `[${device} — ${date}]`, body: text }];
}

/**
 * Combine two versions of a note without ever dropping text, and without
 * growing on repeat: bodies already present are not added again, and existing
 * blocks are flattened rather than nested. If B adds nothing new, A's content
 * is returned unchanged.
 */
function concatenateContent(
  contentA: string | null,
  deviceA: string,
  dateA: string,
  contentB: string | null,
  deviceB: string,
  dateB: string,
): string | null {
  const segA = toSegments(contentA, deviceA, dateA);
  const segB = toSegments(contentB, deviceB, dateB);
  const known = new Set(segA.map((s) => s.body.trim()));
  const added = segB.filter((s) => !known.has(s.body.trim()));
  if (added.length === 0) return contentA;
  return [...segA, ...added].map((s) => `${s.header}\n${s.body}`).join(SEPARATOR);
}

const TITLE_SEPARATOR = ' / ';

/** Union of title parts, stable under repetition. */
function mergeTitles(a: string | null, b: string | null): string | null {
  if (a === b) return a;
  if (a === null) return b;
  if (b === null) return a;
  const parts = a.split(TITLE_SEPARATOR);
  for (const part of b.split(TITLE_SEPARATOR)) {
    if (!parts.includes(part)) parts.push(part);
  }
  return parts.join(TITLE_SEPARATOR);
}

export interface MergeNotesOptions {
  deviceNameA: string;
  deviceNameB: string;
  strategy?: NoteConflictStrategy;
}

/**
 * Merge Note tables from two databases.
 *
 * **Merge order: 3** — depends on Location (step 1) and UserMark (step 2).
 * Both `Location` and `UserMark` mappings must exist in idMapA/idMapB before calling.
 * Populates `Note` mappings used by TagMap (step 7).
 *
 * Strategy:
 * - Match by Guid
 * - Identical content → keep one, remap FKs from A
 * - Different content → concatenate with device/date headers
 * - Unique notes → keep as-is with remapped FKs
 * - Created = earliest of the two, LastModified = latest of the two
 */
export function mergeNotes(
  notesA: Note[],
  notesB: Note[],
  idMapA: IdMap,
  idMapB: IdMap,
  options: MergeNotesOptions,
): Note[] {
  const TABLE = 'Note';
  const merged: Note[] = [];
  let nextId = 1;

  // Index B notes by Guid
  const bByGuid = new Map<string, Note>();
  for (const note of notesB) {
    bByGuid.set(note.Guid, note);
  }

  const matchedBGuids = new Set<string>();

  // Process A notes
  for (const noteA of notesA) {
    const noteB = bByGuid.get(noteA.Guid);
    const newId = nextId++;

    if (noteB) {
      matchedBGuids.add(noteB.Guid);

      // Pick earliest Created, latest LastModified
      const created = noteA.Created <= noteB.Created ? noteA.Created : noteB.Created;
      const lastModified =
        noteA.LastModified >= noteB.LastModified ? noteA.LastModified : noteB.LastModified;

      const contentMatch =
        noteA.Content === noteB.Content && noteA.Title === noteB.Title;

      if (contentMatch) {
        // Identical — keep A's version with remapped FKs
        const remapped = remapNote(noteA, newId, idMapA);
        merged.push({ ...remapped, Created: created, LastModified: lastModified });
      } else {
        // Conflict — resolve based on strategy
        const strategy = options.strategy ?? 'concatenate';

        if (strategy === 'keepA') {
          const remapped = remapNote(noteA, newId, idMapA);
          merged.push({ ...remapped, Created: created, LastModified: lastModified });
        } else if (strategy === 'keepB') {
          const remapped = remapNote(noteB, newId, idMapB);
          merged.push({ ...remapped, Created: created, LastModified: lastModified });
        } else if (strategy === 'keepNewest') {
          const winner = noteA.LastModified >= noteB.LastModified ? noteA : noteB;
          const winnerIdMap = winner === noteA ? idMapA : idMapB;
          const remapped = remapNote(winner, newId, winnerIdMap);
          merged.push({ ...remapped, Created: created, LastModified: lastModified });
        } else {
          // 'concatenate' (default)
          const content = concatenateContent(
            noteA.Content,
            options.deviceNameA,
            noteA.LastModified,
            noteB.Content,
            options.deviceNameB,
            noteB.LastModified,
          );

          // Merge titles: prefer non-null, or union the parts if both differ
          const title = mergeTitles(noteA.Title, noteB.Title);

          const remapped = remapNote(noteA, newId, idMapA);
          merged.push({
            ...remapped,
            Title: title,
            Content: content,
            Created: created,
            LastModified: lastModified,
          });
        }
      }

      idMapA.set(TABLE, noteA.NoteId, newId);
      idMapB.set(TABLE, noteB.NoteId, newId);
    } else {
      // Unique to A
      const remapped = remapNote(noteA, newId, idMapA);
      merged.push(remapped);
      idMapA.set(TABLE, noteA.NoteId, newId);
    }
  }

  // Process B notes that didn't match
  for (const noteB of notesB) {
    if (!matchedBGuids.has(noteB.Guid)) {
      const newId = nextId++;
      const remapped = remapNote(noteB, newId, idMapB);
      merged.push(remapped);
      idMapB.set(TABLE, noteB.NoteId, newId);
    }
  }

  // Update counters
  idMapA.setCounter(TABLE, nextId);
  idMapB.setCounter(TABLE, nextId);

  return merged;
}
