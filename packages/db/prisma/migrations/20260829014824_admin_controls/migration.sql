-- DropForeignKey
ALTER TABLE "Contribution" DROP CONSTRAINT "Contribution_contributorId_fkey";

-- DropForeignKey
ALTER TABLE "Invitation" DROP CONSTRAINT "Invitation_createdById_fkey";

-- DropForeignKey
ALTER TABLE "MusicRequest" DROP CONSTRAINT "MusicRequest_requesterId_fkey";

-- DropForeignKey
ALTER TABLE "UploadBatch" DROP CONSTRAINT "UploadBatch_uploaderId_fkey";

-- AlterTable
ALTER TABLE "Contribution" ALTER COLUMN "contributorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Invitation" ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "uploadsBlockedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MusicRequest" ALTER COLUMN "requesterId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "UploadBatch" ALTER COLUMN "uploaderId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MusicRequest" ADD CONSTRAINT "MusicRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
