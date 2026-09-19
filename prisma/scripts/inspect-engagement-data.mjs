/**
 * Read-only feasibility check for the engagement analytics (list C, #6).
 *
 * The question it answers: do Reactions.csv and Comments.csv identify WHOSE
 * post was reacted to or commented on? If they only carry an opaque activity
 * URL with no author, engagement cannot be attributed to a connection and the
 * feature is not buildable from an export — the same trap country fell into.
 *
 * Also checks Invitations.csv, since "invitation acceptance rate" depends on
 * being able to tell a sent invitation from a received one.
 *
 * Run with:  node prisma/scripts/inspect-engagement-data.mjs
 *
 * SELECTs only. Prints column names and a REDACTED sample (long values are
 * truncated) so no full message bodies land in your terminal.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const FILES_OF_INTEREST = [
  "Reactions",
  "Comments",
  "Shares",
  "Invitations",
  "Company Follows",
  "Member_Follows",
  "Events",
  "Recommendations_Received",
  "Recommendations_Given",
];

function redact(value) {
  if (value === null || value === undefined) return String(value);
  const text = String(value);
  if (text.length <= 80) return text;
  return `${text.slice(0, 80)}… (${text.length} chars)`;
}

const batch = await prisma.importBatch.findFirst({
  where: { status: "COMPLETE" },
  orderBy: { completedAt: "desc" },
  select: { id: true, completedAt: true },
});

if (!batch) {
  console.log("No completed import found.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Latest completed import: ${batch.completedAt?.toISOString()}\n`);

const files = await prisma.rawCsvRow.groupBy({
  by: ["sourceFilename"],
  where: { importBatchId: batch.id },
  _count: true,
});

for (const name of FILES_OF_INTEREST) {
  const matches = files.filter((f) =>
    f.sourceFilename.toLowerCase().includes(name.toLowerCase()),
  );
  if (matches.length === 0) {
    console.log(`--- ${name}: NOT PRESENT in this export`);
    continue;
  }
  for (const match of matches) {
    console.log(`--- ${match.sourceFilename}  (${match._count} rows)`);
    const sample = await prisma.rawCsvRow.findFirst({
      where: { importBatchId: batch.id, sourceFilename: match.sourceFilename },
      select: { rowData: true },
    });
    const row = sample?.rowData ?? {};
    console.log(`    columns: ${Object.keys(row).join(" | ")}`);
    for (const [key, value] of Object.entries(row)) {
      console.log(`      ${key} = ${redact(value)}`);
    }
    console.log("");
  }
}

// Invitations are modelled, not raw — check what actually landed.
const invitationSample = await prisma.invitation.findFirst({
  where: { importBatchId: batch.id },
  select: {
    direction: true,
    counterpartyName: true,
    identityKey: true,
    nameKey: true,
    sentAt: true,
    message: true,
  },
});
console.log("--- Invitation (modelled table) sample:");
console.log(
  JSON.stringify(
    invitationSample
      ? { ...invitationSample, message: redact(invitationSample.message) }
      : null,
    null,
    2,
  ),
);

const [sent, received] = await Promise.all([
  prisma.invitation.count({ where: { importBatchId: batch.id, direction: "SENT" } }),
  prisma.invitation.count({ where: { importBatchId: batch.id, direction: "RECEIVED" } }),
]);
console.log(`\ninvitations: SENT=${sent} RECEIVED=${received}`);

// Message direction coverage drives reply-rate and response-latency accuracy.
const [total, outbound, inbound, unknown] = await Promise.all([
  prisma.messageRecord.count({ where: { importBatchId: batch.id } }),
  prisma.messageRecord.count({ where: { importBatchId: batch.id, senderIsUser: true } }),
  prisma.messageRecord.count({ where: { importBatchId: batch.id, senderIsUser: false } }),
  prisma.messageRecord.count({ where: { importBatchId: batch.id, senderIsUser: null } }),
]);
console.log(
  `messages: total=${total} outbound=${outbound} inbound=${inbound} directionUnknown=${unknown}`,
);

const withConnectedOn = await prisma.connection.count({
  where: { importBatchId: batch.id, connectedOn: { not: null } },
});
const withCompany = await prisma.connection.count({
  where: { importBatchId: batch.id, company: { not: null } },
});
const connections = await prisma.connection.count({ where: { importBatchId: batch.id } });
console.log(
  `connections: total=${connections} withCompany=${withCompany} withConnectedOn=${withConnectedOn}`,
);

await prisma.$disconnect();
