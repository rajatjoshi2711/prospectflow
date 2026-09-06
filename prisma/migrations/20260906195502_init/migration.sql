-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignLeadStatus" AS ENUM ('REQUEST_PENDING', 'REQUEST_ACCEPTED', 'FIRST_MESSAGE_SENT', 'CONVERSATION_ONGOING');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailDomain" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "organizationId" TEXT NOT NULL,
    "lastImportAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "blobUrl" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "linkedinUrl" TEXT,
    "email" TEXT,
    "company" TEXT,
    "position" TEXT,
    "connectedOn" TIMESTAMP(3),
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "companyName" TEXT,
    "title" TEXT,
    "location" TEXT,
    "startedOn" TIMESTAMP(3),
    "finishedOn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "direction" TEXT,
    "from" TEXT,
    "to" TEXT,
    "sentAt" TIMESTAMP(3),
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageRecord" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "conversationId" TEXT,
    "from" TEXT,
    "to" TEXT,
    "sentAt" TIMESTAMP(3),
    "content" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawCsvRow" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "sourceFilename" TEXT NOT NULL,
    "rowData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawCsvRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobChangeEvent" (
    "id" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "previousBatchId" TEXT NOT NULL,
    "currentBatchId" TEXT NOT NULL,
    "previousTitle" TEXT,
    "previousCompany" TEXT,
    "newTitle" TEXT,
    "newCompany" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ICP" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "industry" TEXT,
    "positions" TEXT[],
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ICP_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelPartner" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "criteria" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectMatch" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "icpId" TEXT,
    "channelPartnerId" TEXT,
    "score" INTEGER NOT NULL,
    "rationale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProspectMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceFileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLead" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "connectionId" TEXT,
    "linkedinUrl" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "company" TEXT,
    "status" "CampaignLeadStatus" NOT NULL DEFAULT 'REQUEST_PENDING',
    "rawRow" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelationshipStrengthScore" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "factors" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RelationshipStrengthScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickSuggestion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_emailDomain_key" ON "Organization"("emailDomain");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE INDEX "ImportBatch_userId_idx" ON "ImportBatch"("userId");

-- CreateIndex
CREATE INDEX "ImportBatch_userId_status_completedAt_idx" ON "ImportBatch"("userId", "status", "completedAt");

-- CreateIndex
CREATE INDEX "Connection_importBatchId_idx" ON "Connection"("importBatchId");

-- CreateIndex
CREATE INDEX "Connection_identityKey_idx" ON "Connection"("identityKey");

-- CreateIndex
CREATE INDEX "Position_importBatchId_idx" ON "Position"("importBatchId");

-- CreateIndex
CREATE INDEX "Position_identityKey_idx" ON "Position"("identityKey");

-- CreateIndex
CREATE INDEX "Invitation_importBatchId_idx" ON "Invitation"("importBatchId");

-- CreateIndex
CREATE INDEX "Invitation_identityKey_idx" ON "Invitation"("identityKey");

-- CreateIndex
CREATE INDEX "MessageRecord_importBatchId_idx" ON "MessageRecord"("importBatchId");

-- CreateIndex
CREATE INDEX "MessageRecord_identityKey_idx" ON "MessageRecord"("identityKey");

-- CreateIndex
CREATE INDEX "MessageRecord_conversationId_idx" ON "MessageRecord"("conversationId");

-- CreateIndex
CREATE INDEX "RawCsvRow_importBatchId_idx" ON "RawCsvRow"("importBatchId");

-- CreateIndex
CREATE INDEX "RawCsvRow_sourceFilename_idx" ON "RawCsvRow"("sourceFilename");

-- CreateIndex
CREATE INDEX "JobChangeEvent_identityKey_idx" ON "JobChangeEvent"("identityKey");

-- CreateIndex
CREATE INDEX "JobChangeEvent_currentBatchId_idx" ON "JobChangeEvent"("currentBatchId");

-- CreateIndex
CREATE INDEX "ICP_organizationId_idx" ON "ICP"("organizationId");

-- CreateIndex
CREATE INDEX "ChannelPartner_organizationId_idx" ON "ChannelPartner"("organizationId");

-- CreateIndex
CREATE INDEX "ProspectMatch_connectionId_idx" ON "ProspectMatch"("connectionId");

-- CreateIndex
CREATE INDEX "ProspectMatch_icpId_idx" ON "ProspectMatch"("icpId");

-- CreateIndex
CREATE INDEX "ProspectMatch_channelPartnerId_idx" ON "ProspectMatch"("channelPartnerId");

-- CreateIndex
CREATE INDEX "Campaign_userId_idx" ON "Campaign"("userId");

-- CreateIndex
CREATE INDEX "CampaignLead_campaignId_idx" ON "CampaignLead"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignLead_connectionId_idx" ON "CampaignLead"("connectionId");

-- CreateIndex
CREATE INDEX "RelationshipStrengthScore_userId_idx" ON "RelationshipStrengthScore"("userId");

-- CreateIndex
CREATE INDEX "RelationshipStrengthScore_connectionId_idx" ON "RelationshipStrengthScore"("connectionId");

-- CreateIndex
CREATE INDEX "QuickSuggestion_organizationId_idx" ON "QuickSuggestion"("organizationId");

-- CreateIndex
CREATE INDEX "ChatMessage_userId_idx" ON "ChatMessage"("userId");

-- CreateIndex
CREATE INDEX "ChatMessage_conversationId_idx" ON "ChatMessage"("conversationId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRecord" ADD CONSTRAINT "MessageRecord_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawCsvRow" ADD CONSTRAINT "RawCsvRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobChangeEvent" ADD CONSTRAINT "JobChangeEvent_previousBatchId_fkey" FOREIGN KEY ("previousBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobChangeEvent" ADD CONSTRAINT "JobChangeEvent_currentBatchId_fkey" FOREIGN KEY ("currentBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ICP" ADD CONSTRAINT "ICP_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelPartner" ADD CONSTRAINT "ChannelPartner_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectMatch" ADD CONSTRAINT "ProspectMatch_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectMatch" ADD CONSTRAINT "ProspectMatch_icpId_fkey" FOREIGN KEY ("icpId") REFERENCES "ICP"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectMatch" ADD CONSTRAINT "ProspectMatch_channelPartnerId_fkey" FOREIGN KEY ("channelPartnerId") REFERENCES "ChannelPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipStrengthScore" ADD CONSTRAINT "RelationshipStrengthScore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelationshipStrengthScore" ADD CONSTRAINT "RelationshipStrengthScore_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickSuggestion" ADD CONSTRAINT "QuickSuggestion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

