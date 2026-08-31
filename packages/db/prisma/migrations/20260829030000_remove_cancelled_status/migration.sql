-- Delete any cancelled requests
DELETE FROM "MusicRequest" WHERE "status" = 'CANCELLED';

-- Remove CANCELLED from the enum
ALTER TABLE "MusicRequest" DROP CONSTRAINT IF EXISTS "MusicRequest_status_fkey";
ALTER TABLE "MusicRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "RequestStatus" RENAME TO "RequestStatus_old";
CREATE TYPE "RequestStatus" AS ENUM ('OPEN', 'CLAIMED', 'FULFILLED');
ALTER TABLE "MusicRequest" ALTER COLUMN "status" TYPE "RequestStatus" USING "status"::text::"RequestStatus";
ALTER TABLE "MusicRequest" ALTER COLUMN "status" SET DEFAULT 'OPEN'::"RequestStatus";
DROP TYPE "RequestStatus_old";

-- Drop cancelledAt column
ALTER TABLE "MusicRequest" DROP COLUMN "cancelledAt";
