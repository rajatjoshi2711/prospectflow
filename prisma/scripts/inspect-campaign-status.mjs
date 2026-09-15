/**
 * Read-only diagnostic for campaign lead status.
 *
 * Answers, in one pass, why a campaign's status chips might all read
 * "Connection request pending": is there an import to link against at all, did
 * the leads resolve to connections in it, and does the stored status column
 * match what the chips are counting?
 *
 * Run with:  node prisma/scripts/inspect-campaign-status.mjs
 *
 * Performs SELECTs only — no writes, no schema changes.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const batches = await prisma.importBatch.findMany({
  orderBy: { createdAt: "desc" },
  take: 3,
  select: { id: true, status: true, createdAt: true, completedAt: true, userId: true },
});

console.log("=== imports ===");
if (batches.length === 0) {
  console.log("  NONE. Leads cannot link to a network that has not been imported,");
  console.log("  so every lead stays REQUEST_PENDING. Upload an export first.");
}
for (const b of batches) {
  const connections = await prisma.connection.count({ where: { importBatchId: b.id } });
  const messages = await prisma.messageRecord.count({ where: { importBatchId: b.id } });
  const invitations = await prisma.invitation.count({ where: { importBatchId: b.id } });
  console.log(
    `  ${b.createdAt.toISOString()}  ${b.status}  connections=${connections} messages=${messages} invitations=${invitations}`,
  );
}

console.log("\n=== campaigns ===");
const campaigns = await prisma.campaign.findMany({
  orderBy: { createdAt: "desc" },
  select: { id: true, name: true, status: true, createdAt: true, userId: true },
});
if (campaigns.length === 0) console.log("  none");

for (const campaign of campaigns) {
  const total = await prisma.campaignLead.count({ where: { campaignId: campaign.id } });
  const linked = await prisma.campaignLead.count({
    where: { campaignId: campaign.id, connectionId: { not: null } },
  });
  const handSet = await prisma.campaignLead.count({
    where: { campaignId: campaign.id, statusSetAt: { not: null } },
  });
  const grouped = await prisma.campaignLead.groupBy({
    by: ["status"],
    where: { campaignId: campaign.id },
    _count: true,
  });

  // The campaign was built before its owner had any import to link against,
  // which is the most common reason statuses look stuck.
  const latestImport = await prisma.importBatch.findFirst({
    where: { userId: campaign.userId, status: "COMPLETE" },
    orderBy: { completedAt: "desc" },
    select: { completedAt: true },
  });

  console.log(`\n  "${campaign.name}" (${campaign.status}) created ${campaign.createdAt.toISOString()}`);
  console.log(`    leads=${total} linked=${linked} handSetStatus=${handSet}`);
  console.log(`    stored status counts: ${grouped.map((g) => `${g.status}=${g._count}`).join(" ") || "none"}`);
  if (!latestImport) {
    console.log("    !! owner has no COMPLETE import — nothing to link against");
  } else if (latestImport.completedAt && latestImport.completedAt > campaign.createdAt) {
    console.log("    note: an import completed AFTER this campaign was built,");
    console.log("          which should have re-linked and re-statused it.");
  }
}

await prisma.$disconnect();
