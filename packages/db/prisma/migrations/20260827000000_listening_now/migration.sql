-- Listening presence for the library overview. One row per listener, replaced as
-- they move through a queue and deleted when playback stops; readers additionally
-- ignore any row that has not been refreshed recently.
CREATE TABLE "ListeningNow" (
    "userId" UUID NOT NULL,
    "libraryId" UUID NOT NULL,
    "trackReference" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListeningNow_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "ListeningNow_libraryId_updatedAt_idx" ON "ListeningNow"("libraryId", "updatedAt");

ALTER TABLE "ListeningNow" ADD CONSTRAINT "ListeningNow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ListeningNow" ADD CONSTRAINT "ListeningNow_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;
