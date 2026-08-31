-- Convert the mirrored catalog into sparse Commonwax identity/provenance bindings.
-- Only rows referenced by Commonwax-owned state survive this migration.

-- Canonical paths are temporary upload-to-scan provenance, not a current path
-- registry. Completed imports no longer need them for retry.
UPDATE "UploadFile" AS upload_file
SET "canonicalPath" = NULL
FROM "UploadBatch" AS upload_batch
WHERE upload_batch."id" = upload_file."uploadBatchId"
  AND upload_batch."status" = 'IMPORTED';

ALTER TABLE "Album"
  ADD COLUMN "musicBrainzId" TEXT,
  ADD COLUMN "lastKnownArtist" TEXT;

UPDATE "Album" AS album
SET
  "lastKnownArtist" = artist."name"
FROM "Artist" AS artist
WHERE artist."id" = album."artistId";

ALTER TABLE "Album"
  ALTER COLUMN "lastKnownArtist" SET NOT NULL,
  ALTER COLUMN "navidromeId" DROP NOT NULL;

ALTER TABLE "Track"
  ADD COLUMN "musicBrainzId" TEXT,
  ADD COLUMN "isrcs" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "lastKnownArtist" TEXT;

UPDATE "Track" AS track
SET
  "lastKnownArtist" = artist."name"
FROM "Artist" AS artist
WHERE artist."id" = track."artistId";

ALTER TABLE "Track"
  ALTER COLUMN "lastKnownArtist" SET NOT NULL,
  ALTER COLUMN "isrcs" SET NOT NULL,
  ALTER COLUMN "navidromeId" DROP NOT NULL;

-- Track bindings exist only to carry track-scoped Commonwax state.
DELETE FROM "Track" AS track
WHERE NOT EXISTS (
  SELECT 1 FROM "ContributionTrack" AS contribution_track
  WHERE contribution_track."trackId" = track."id"
);

-- Album bindings remain only where attribution, fulfillment, hiding, or a retained
-- track binding needs a stable Commonwax identity.
DELETE FROM "Album" AS album
WHERE NOT EXISTS (SELECT 1 FROM "Contribution" WHERE "albumId" = album."id")
  AND NOT EXISTS (SELECT 1 FROM "MusicRequest" WHERE "fulfilledAlbumId" = album."id")
  AND NOT EXISTS (SELECT 1 FROM "HiddenAlbum" WHERE "albumId" = album."id")
  AND NOT EXISTS (SELECT 1 FROM "Track" WHERE "albumId" = album."id");

ALTER TABLE "Album" DROP CONSTRAINT "Album_artistId_fkey";
ALTER TABLE "Track" DROP CONSTRAINT "Track_artistId_fkey";
DROP INDEX "Album_artistId_idx";
DROP INDEX "Album_libraryId_title_idx";
DROP INDEX "Track_libraryId_title_idx";

ALTER TABLE "Album"
  DROP COLUMN "artistId",
  DROP COLUMN "genre",
  DROP COLUMN "songCount",
  DROP COLUMN "duration",
  DROP COLUMN "coverArt",
  DROP COLUMN "navidromeAdded";

ALTER TABLE "Track"
  DROP COLUMN "artistId",
  DROP COLUMN "duration",
  DROP COLUMN "suffix",
  DROP COLUMN "contentType",
  DROP COLUMN "bitRate",
  DROP COLUMN "path";

DROP TABLE "Artist";

CREATE INDEX "Album_libraryId_musicBrainzId_idx" ON "Album"("libraryId", "musicBrainzId");
CREATE INDEX "Track_libraryId_musicBrainzId_idx" ON "Track"("libraryId", "musicBrainzId");
