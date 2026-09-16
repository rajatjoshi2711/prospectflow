-- CreateEnum
CREATE TYPE "AiUseCase" AS ENUM ('ICP_MATCHING', 'CHANNEL_PARTNER_MATCHING', 'RELATIONSHIP_SCORING', 'QUICK_SUGGESTIONS', 'PROSPECT_ASK', 'CAMPAIGN_COLUMN_DETECTION', 'PROSPECT_RESEARCH');

-- CreateEnum
CREATE TYPE "AiCallStatus" AS ENUM ('OK', 'ERROR');

-- CreateTable
CREATE TABLE "AiCallLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "useCase" "AiUseCase" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "AiCallStatus" NOT NULL,
    "errorKind" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "usageReported" BOOLEAN NOT NULL DEFAULT false,
    "usedBuiltInTools" BOOLEAN NOT NULL DEFAULT false,
    "inputRatePerMillionUsd" DECIMAL(12,6),
    "outputRatePerMillionUsd" DECIMAL(12,6),
    "costUsd" DECIMAL(18,10),
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCallLog_organizationId_createdAt_idx" ON "AiCallLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCallLog_organizationId_userId_createdAt_idx" ON "AiCallLog"("organizationId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCallLog_organizationId_useCase_createdAt_idx" ON "AiCallLog"("organizationId", "useCase", "createdAt");

-- CreateIndex
CREATE INDEX "AiCallLog_organizationId_model_createdAt_idx" ON "AiCallLog"("organizationId", "model", "createdAt");

-- AddForeignKey
ALTER TABLE "AiCallLog" ADD CONSTRAINT "AiCallLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallLog" ADD CONSTRAINT "AiCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

