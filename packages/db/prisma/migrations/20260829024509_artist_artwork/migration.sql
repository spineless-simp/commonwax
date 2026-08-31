-- CreateTable
CREATE TABLE "ArtistArtwork" (
    "id" UUID NOT NULL,
    "nameKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "musicBrainzId" TEXT,
    "logo" BYTEA,
    "logoType" TEXT,
    "background" BYTEA,
    "backgroundType" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistArtwork_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtistArtwork_nameKey_key" ON "ArtistArtwork"("nameKey");
