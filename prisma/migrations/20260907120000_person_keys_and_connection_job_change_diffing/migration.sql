-- Phase 2 data-modelling fixes: counterparty-keyed messages/invitations, a
-- weak name key that lets those join onto Connection, an explicit marker that
-- Position rows are the account owner's own history, and denormalized display
-- details on JobChangeEvent.
--
-- Every new column is nullable (or has a default), so existing rows are
-- untouched and legacy batches keep loading. See
-- prisma/scripts/backfill-person-keys.ts for the optional backfill.

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "ownerName" TEXT,
ADD COLUMN     "ownerNameKey" TEXT;

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "nameKey" TEXT;

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "isAccountOwner" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN     "counterpartyName" TEXT,
ADD COLUMN     "nameKey" TEXT;

-- AlterTable
ALTER TABLE "MessageRecord" ADD COLUMN     "counterpartyName" TEXT,
ADD COLUMN     "nameKey" TEXT,
ADD COLUMN     "senderIsUser" BOOLEAN;

-- AlterTable
ALTER TABLE "JobChangeEvent" ADD COLUMN     "linkedinUrl" TEXT,
ADD COLUMN     "personName" TEXT;

-- CreateIndex
CREATE INDEX "Connection_nameKey_idx" ON "Connection"("nameKey");

-- CreateIndex
CREATE INDEX "Connection_importBatchId_identityKey_idx" ON "Connection"("importBatchId", "identityKey");

-- CreateIndex
CREATE INDEX "Invitation_nameKey_idx" ON "Invitation"("nameKey");

-- CreateIndex
CREATE INDEX "MessageRecord_nameKey_idx" ON "MessageRecord"("nameKey");
