# Sync design

Status: engine, data model and tests implemented in `packages/core` (Milestone 2).
Not yet implemented: Google auth / Drive provider (M3), app integration and UI (M4+).

## Goals and non-negotiables

Protecting the user's study data outranks convenience. The engine:

- never overwrites a newer cloud state (compare-and-swap head),
- never reports success before the upload is read back and verified,
- keeps recoverable copies before and after every merge,
- changes local state only through one atomic commit,
- refuses to propagate what looks like a wiped device without confirmation,
- never silently drops text: unresolvable note edits are kept side by side.

## Concepts

| Term | Meaning |
|---|---|
| local archive | the `.jwlibrary` this device currently treats as its latest |
| snapshot | immutable `.jwlibrary` in the cloud; never modified after upload |
| head | small record naming the latest snapshot: `version`, `snapshotId`, `hash` (bytes), `fingerprint` (content), device, time |
| base | the last snapshot this device successfully synced, stored locally with its bytes |
| fingerprint | hash of the user's data independent of row IDs, order, bookmark slots, timestamps and zip wrapper |

"Changed since last sync" means *fingerprint differs from base*, not "file is newer".
Timestamps are never used to decide which side wins.

## Layers

```
runSync (sync/engine.ts)            platform-neutral orchestration
  ├─ CloudProvider (interface)      Drive appDataFolder (M3) | MemoryCloud (tests)
  ├─ LocalStore    (interface)      expo-file-system / OPFS+IDB (M4) | MemoryLocalStore (tests)
  ├─ reconcile (reconcile.ts)       three-way: base vs local vs remote
  ├─ mergeAll  (merge-all.ts)       existing merge engine, all tables in dependency order
  └─ buildArchive / validateArchive existing builder + strict validation
```

The existing merge functions are unchanged in behaviour except two stability
fixes (below). Reconcile adjusts its *inputs* so the union merge yields the right result.

## Algorithm (one `runSync`)

1. Take the local lock (single-flight). Busy → clear error, nothing changed.
2. Read cloud head; save a `pre-sync` recovery copy of the local archive.
3. Parse local leniently (real JW Library backups can have a manifest hash mismatch).
4. Decide:
   - no head: normalize + upload local (version 1)
   - no local data: download, verify, adopt
   - same fingerprint: record base, done (`no-changes`)
   - cloud unchanged since base: upload local (after mass-deletion check)
   - local unchanged since base: fast-forward to the cloud copy
   - both changed: download + verify (bytes hash, strict manifest hash, fingerprint) →
     `reconcile(base, local, remote)` → `mergeAll` → `buildArchive` → validate → save `merged` recovery copy
5. Upload snapshot under a fresh id, **read it back and compare the hash**.
6. `publishHead(version + 1)` by compare-and-swap. On conflict: delete the orphan snapshot and restart from step 2 (up to `maxAttempts`, default 3).
7. Only now `commitSynced` locally (atomic) and record history.

A crash anywhere before step 6 leaves the cloud head and the local archive untouched.
A crash between 6 and 7 leaves the cloud valid; the next sync sees identical content and just records the base.

## Reconcile rules

Entities are matched by stable identity (GUIDs / natural keys), never row IDs.

| Situation | Result |
|---|---|
| deleted on one side, unchanged on the other | removed from the other side |
| deleted on one side, edited on the other | **kept** (edit wins), reported as conflict |
| edited on one side only | other side adopts the edit |
| edited differently on both | merge strategy resolves, non-destructively; reported |

Covered: notes, highlights (+ranges), bookmarks, tags, tag assignments to notes and locations.
**Union-only for now (deletions do not propagate):** playlists, input fields, tag assignments on playlist items.
Without a base (first sync on a device) everything is a union; nothing is deleted.

### Mass-deletion guard

If one side's deletions would remove ≥ 10 items and ≥ 50 % of an entity type
(or wipe a type that had ≥ 3 items), the sync stops with `needs-confirmation`.
This is what protects the other devices if one is reset or restored empty.

## Stability fixes found in the M1 audit

Repeated syncing re-merges the same data many times, which exposed two growth bugs
(regression tests in `tests/resync-idempotence.test.ts`):

- **Bookmarks** were re-added at a new slot on every merge. Matching is now by
  location, title, snippet and block, independent of slot.
- **Concatenated notes** nested their headers deeper on every sync. Concatenation
  is now a set-union of text blocks and title parts; merging again adds nothing.

## Conflict handling

Conflicts never block a sync. They are returned in `SyncResult.conflicts`,
stored in the history entry, and resolved by the configured strategy. The default
(`concatenate`) keeps both texts. M5 adds the review screen.

## Cloud layout (Drive `appDataFolder`, M3)

- `snap-<uuid>.jwlibrary` — immutable snapshots.
- `head-<version>.json` — one file per published version. Drive has no reliable
  conditional update, so `publishHead` creates `head-N+1` only if `head-N` is the
  highest, re-lists afterwards, and if several devices created the same version,
  the lexicographically smallest `(deviceId)` wins deterministically; losers report `conflict`.
- Retention: keep the last N snapshots for recovery (M5).

## Known limitations

- Playlist/input-field deletions do not propagate (see above).
- Highlight "newest wins" compares `UserMark.Version`; unverified against real data
  that Version changes on edit. Reconcile handles one-sided edits regardless.
- JW Library limits bookmark slots; slot overflow is not yet capped.
- The web and mobile apps still carry their own copy of the merge orchestration for the
  manual merge screens; they should migrate to `mergeAll`.
