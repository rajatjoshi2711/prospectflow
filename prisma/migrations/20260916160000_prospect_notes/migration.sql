-- CreateTable
CREATE TABLE "ProspectNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProspectNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProspectNote_organizationId_identityKey_createdAt_idx" ON "ProspectNote"("organizationId", "identityKey", "createdAt");

-- CreateIndex
CREATE INDEX "ProspectNote_authorId_idx" ON "ProspectNote"("authorId");

-- AddForeignKey
ALTER TABLE "ProspectNote" ADD CONSTRAINT "ProspectNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectNote" ADD CONSTRAINT "ProspectNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

