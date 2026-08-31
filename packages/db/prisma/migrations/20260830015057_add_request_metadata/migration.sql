-- AlterTable
ALTER TABLE "MusicRequest" ADD COLUMN     "musicBrainzReleaseGroupId" VARCHAR(36),
ADD COLUMN     "year" INTEGER;

-- CreateIndex
CREATE INDEX "MusicRequest_libraryId_musicBrainzReleaseGroupId_idx" ON "MusicRequest"("libraryId", "musicBrainzReleaseGroupId");
