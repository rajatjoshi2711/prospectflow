-- CreateTable
CREATE TABLE "ProspectResearch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "citations" TEXT[],
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectResearch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProspectResearch_organizationId_identityKey_createdAt_idx" ON "ProspectResearch"("organizationId", "identityKey", "createdAt");

-- CreateIndex
CREATE INDEX "ProspectResearch_requestedById_idx" ON "ProspectResearch"("requestedById");

-- AddForeignKey
ALTER TABLE "ProspectResearch" ADD CONSTRAINT "ProspectResearch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectResearch" ADD CONSTRAINT "ProspectResearch_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

