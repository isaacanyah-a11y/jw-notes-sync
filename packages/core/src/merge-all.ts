/**
 * Full-database merge: runs every table merge in dependency order.
 *
 * This is the single orchestration shared by the sync engine. (The web and
 * mobile apps currently carry their own copy for the manual merge screens;
 * they should migrate to this function so the logic cannot drift.)
 */
import { IdMap } from './id-map.js';
import { mergeLocations } from './merge-locations.js';
import { mergeUserMarks, mergeBlockRanges } from './merge-usermarks.js';
import { mergeNotes } from './merge-notes.js';
import { mergeBookmarks } from './merge-bookmarks.js';
import { mergeTags, mergeTagMaps } from './merge-tags.js';
import { mergeInputFields } from './merge-input-fields.js';
import {
  mergeIndependentMedia,
  mergePlaylistItemAccuracy,
  mergePlaylistItems,
  mergePlaylistItemMarkers,
  mergePlaylistItemLocationMaps,
  mergePlaylistItemIndependentMediaMaps,
  mergePlaylistItemMarkerBibleVerseMaps,
  mergePlaylistItemMarkerParagraphMaps,
} from './merge-playlists.js';
import { DEFAULT_MERGE_CONFIG, type MergeConfig } from './merge-config.js';
import type { DatabaseContents } from './models.js';

export interface MergeAllOptions {
  config?: MergeConfig;
  deviceNameA: string;
  deviceNameB: string;
  mediaA?: Map<string, Uint8Array>;
  mediaB?: Map<string, Uint8Array>;
}

export interface MergeAllResult {
  contents: DatabaseContents;
  mediaFiles: Map<string, Uint8Array>;
}

export function mergeAll(a: DatabaseContents, b: DatabaseContents, options: MergeAllOptions): MergeAllResult {
  const config = options.config ?? DEFAULT_MERGE_CONFIG;
  const { deviceNameA, deviceNameB } = options;
  const idMapA = new IdMap();
  const idMapB = new IdMap();

  const locations = mergeLocations(a.locations, b.locations, idMapA, idMapB);
  const { merged: userMarks, winners } = mergeUserMarks(a.userMarks, b.userMarks, idMapA, idMapB, {
    strategy: config.highlights,
  });
  const blockRanges = mergeBlockRanges(a.blockRanges, b.blockRanges, idMapA, idMapB, winners);
  const notes = mergeNotes(a.notes, b.notes, idMapA, idMapB, { deviceNameA, deviceNameB, strategy: config.notes });
  const bookmarks = mergeBookmarks(a.bookmarks, b.bookmarks, idMapA, idMapB);

  // Playlists must precede TagMaps (TagMap references PlaylistItemId).
  const independentMedia = mergeIndependentMedia(a.independentMedia, b.independentMedia, idMapA, idMapB);
  const playlistItemAccuracies = mergePlaylistItemAccuracy(a.playlistItemAccuracies, b.playlistItemAccuracies, idMapA, idMapB);
  const playlistItems = mergePlaylistItems(a.playlistItems, b.playlistItems, idMapA, idMapB);
  const playlistItemMarkers = mergePlaylistItemMarkers(a.playlistItemMarkers, b.playlistItemMarkers, idMapA, idMapB);
  const playlistItemLocationMaps = mergePlaylistItemLocationMaps(a.playlistItemLocationMaps, b.playlistItemLocationMaps, idMapA, idMapB);
  const playlistItemIndependentMediaMaps = mergePlaylistItemIndependentMediaMaps(a.playlistItemIndependentMediaMaps, b.playlistItemIndependentMediaMaps, idMapA, idMapB);
  const playlistItemMarkerBibleVerseMaps = mergePlaylistItemMarkerBibleVerseMaps(a.playlistItemMarkerBibleVerseMaps, b.playlistItemMarkerBibleVerseMaps, idMapA, idMapB);
  const playlistItemMarkerParagraphMaps = mergePlaylistItemMarkerParagraphMaps(a.playlistItemMarkerParagraphMaps, b.playlistItemMarkerParagraphMaps, idMapA, idMapB);

  const tags = mergeTags(a.tags, b.tags, idMapA, idMapB);
  const tagMaps = mergeTagMaps(a.tagMaps, b.tagMaps, idMapA, idMapB);
  const inputFields = mergeInputFields(a.inputFields, b.inputFields, idMapA, idMapB, {
    deviceNameA,
    deviceNameB,
    strategy: config.inputFields,
  });

  const mediaFiles = new Map<string, Uint8Array>(options.mediaA ?? []);
  for (const [path, data] of options.mediaB ?? []) {
    if (!mediaFiles.has(path)) mediaFiles.set(path, data);
  }

  return {
    contents: {
      locations,
      notes,
      userMarks,
      blockRanges,
      bookmarks,
      tags,
      tagMaps,
      inputFields,
      independentMedia,
      playlistItems,
      playlistItemAccuracies,
      playlistItemIndependentMediaMaps,
      playlistItemLocationMaps,
      playlistItemMarkers,
      playlistItemMarkerBibleVerseMaps,
      playlistItemMarkerParagraphMaps,
      lastModified: '',
      androidMetadata: a.androidMetadata ?? b.androidMetadata,
    },
    mediaFiles,
  };
}
