-- Materializes the effective relationship strength onto Connection so SQL can
-- order by it. Additive and nullable: existing rows read NULL ("not yet
-- scored") until the next scoring run populates them.

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "relationshipBasis" TEXT,
ADD COLUMN     "relationshipScore" INTEGER;

-- CreateIndex
CREATE INDEX "Connection_importBatchId_relationshipScore_idx" ON "Connection"("importBatchId", "relationshipScore");
