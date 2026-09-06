import { Readable } from "node:stream";
import Papa from "papaparse";
import yauzl from "yauzl";
import { NonRetriableError } from "inngest";
import { Prisma } from "@prisma/client";
import { inngest, type ImportBatchCreatedEvent } from "@/inngest/client";
import { prisma } from "@/lib/prisma";
import { computeIdentityKey } from "@/lib/ingestion/identity-key";

const CHUNK_SIZE = 500;

type ParsedRow = Record<string, string>;

/** Case-insensitive lookup across a set of possible header spellings. */
function getField(row: ParsedRow, candidates: string[]): string | null {
  const lowerMap = new Map<string, string>();
  for (const key of Object.keys(row)) {
    lowerMap.set(key.trim().toLowerCase(), row[key]);
  }
  for (const candidate of candidates) {
    const value = lowerMap.get(candidate.toLowerCase());
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

function toDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function flush<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    await insert(rows.slice(i, i + CHUNK_SIZE));
  }
  rows.length = 0;
}

/** Parses a readable CSV stream and hands each row to `onRow`. */
function parseCsvStream(stream: Readable, onRow: (row: ParsedRow) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    Papa.parse<ParsedRow>(stream, {
      header: true,
      skipEmptyLines: true,
      step: (result) => {
        onRow(result.data);
      },
      complete: () => resolve(),
      error: (err: Error) => reject(err),
    });
  });
}

async function processEntry(
  entryPath: string,
  entry: Readable,
  importBatchId: string,
): Promise<void> {
  const baseName = entryPath.split("/").pop() ?? entryPath;
  const lowerBase = baseName.toLowerCase();
  const underMessagesFolder = entryPath.toLowerCase().includes("messages/");

  if (lowerBase === "connections.csv") {
    const rows: Prisma.ConnectionCreateManyInput[] = [];
    await parseCsvStream(entry, (row) => {
      const firstName = getField(row, ["First Name"]);
      const lastName = getField(row, ["Last Name"]);
      const linkedinUrl = getField(row, ["URL", "Profile URL"]);
      const company = getField(row, ["Company"]);
      rows.push({
        importBatchId,
        identityKey: computeIdentityKey({ linkedinUrl, firstName, lastName, company }),
        firstName,
        lastName,
        linkedinUrl,
        email: getField(row, ["Email Address", "Email"]),
        company,
        position: getField(row, ["Position", "Title"]),
        connectedOn: toDate(getField(row, ["Connected On"])),
      });
    });
    await flush(rows, (chunk) => prisma.connection.createMany({ data: chunk }));
    return;
  }

  if (lowerBase === "positions.csv") {
    const rows: Prisma.PositionCreateManyInput[] = [];
    await parseCsvStream(entry, (row) => {
      const firstName = getField(row, ["First Name"]);
      const lastName = getField(row, ["Last Name"]);
      const companyName = getField(row, ["Company Name", "Company"]);
      const linkedinUrl = getField(row, ["URL", "Profile URL"]);
      rows.push({
        importBatchId,
        identityKey: computeIdentityKey({ linkedinUrl, firstName, lastName, company: companyName }),
        companyName,
        title: getField(row, ["Title"]),
        location: getField(row, ["Location"]),
        startedOn: toDate(getField(row, ["Started On"])),
        finishedOn: toDate(getField(row, ["Finished On"])),
      });
    });
    await flush(rows, (chunk) => prisma.position.createMany({ data: chunk }));
    return;
  }

  if (lowerBase === "invitations.csv") {
    const rows: Prisma.InvitationCreateManyInput[] = [];
    await parseCsvStream(entry, (row) => {
      const from = getField(row, ["From"]);
      const to = getField(row, ["To"]);
      const direction = getField(row, ["Direction"]);
      rows.push({
        importBatchId,
        identityKey: computeIdentityKey({
          firstName: direction?.toLowerCase() === "outgoing" ? to : from,
          lastName: null,
          company: null,
          linkedinUrl: null,
        }),
        direction,
        from,
        to,
        sentAt: toDate(getField(row, ["Sent At", "Sent At (Optional)"])),
        message: getField(row, ["Message"]),
      });
    });
    await flush(rows, (chunk) => prisma.invitation.createMany({ data: chunk }));
    return;
  }

  if (lowerBase === "messages.csv" || underMessagesFolder) {
    const rows: Prisma.MessageRecordCreateManyInput[] = [];
    await parseCsvStream(entry, (row) => {
      const from = getField(row, ["From", "Sender", "Author"]);
      const to = getField(row, ["To", "Recipient"]);
      rows.push({
        importBatchId,
        identityKey: computeIdentityKey({ firstName: from, lastName: null, company: null, linkedinUrl: null }),
        conversationId: getField(row, ["Conversation ID", "Conversation Id"]),
        from,
        to,
        sentAt: toDate(getField(row, ["Date", "Sent At"])),
        content: getField(row, ["Content", "Message"]),
      });
    });
    await flush(rows, (chunk) => prisma.messageRecord.createMany({ data: chunk }));
    return;
  }

  // Anything unrecognized: capture every row verbatim so nothing is lost.
  const rawRows: Prisma.RawCsvRowCreateManyInput[] = [];
  await parseCsvStream(entry, (row) => {
    rawRows.push({
      importBatchId,
      sourceFilename: entryPath,
      rowData: row,
    });
  });
  await flush(rawRows, (chunk) => prisma.rawCsvRow.createMany({ data: chunk }));
}

/**
 * Streams a zip buffer entry-by-entry (yauzl, `lazyEntries: true`, so the
 * whole archive is never buffered as decompressed entries at once), and
 * feeds every `.csv` file it finds to `processEntry`. Returns the number of
 * CSV files processed.
 */
function countAndProcessCsvEntries(buffer: Buffer, importBatchId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("Failed to open zip archive."));
        return;
      }

      zipfile.on("error", reject);
      zipfile.on("end", () => resolve(count));

      zipfile.on("entry", (entry) => {
        const isDirectory = /\/$/.test(entry.fileName);
        const lowerBase = (entry.fileName.split("/").pop() ?? entry.fileName).toLowerCase();

        if (isDirectory || !lowerBase.endsWith(".csv")) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            reject(streamErr ?? new Error(`Failed to read zip entry ${entry.fileName}`));
            return;
          }

          count += 1;
          processEntry(entry.fileName, readStream, importBatchId)
            .then(() => zipfile.readEntry())
            .catch(reject);
        });
      });

      zipfile.readEntry();
    });
  });
}

export const processImport = inngest.createFunction(
  { id: "process-import", retries: 2, triggers: [{ event: "import/batch.created" }] },
  async ({ event, step }: { event: ImportBatchCreatedEvent; step: import("inngest").GetStepTools<typeof inngest> }) => {
    const { importBatchId } = event.data;

    const batch = await step.run("load-batch", async () => {
      const found = await prisma.importBatch.findUnique({ where: { id: importBatchId } });
      if (!found) {
        throw new NonRetriableError(`ImportBatch ${importBatchId} not found`);
      }
      return found;
    });

    await step.run("mark-processing", async () => {
      await prisma.importBatch.update({
        where: { id: importBatchId },
        data: { status: "PROCESSING" },
      });
    });

    try {
      const fileCount = await step.run("unzip-and-ingest", async () => {
        const response = await fetch(batch.blobUrl);
        if (!response.ok || !response.body) {
          throw new Error(`Failed to download blob: ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        return countAndProcessCsvEntries(buffer, importBatchId);
      });

      await step.run("mark-complete", async () => {
        await prisma.$transaction([
          prisma.importBatch.update({
            where: { id: importBatchId },
            data: { status: "COMPLETE", completedAt: new Date(), fileCount },
          }),
          prisma.user.update({
            where: { id: batch.userId },
            data: { lastImportAt: new Date() },
          }),
        ]);
      });
    } catch (error) {
      await step.run("mark-failed", async () => {
        await prisma.importBatch.update({
          where: { id: importBatchId },
          data: {
            status: "FAILED",
            errorMessage: error instanceof Error ? error.message : "Unknown error during import processing.",
          },
        });
      });
      // Re-throw so Inngest records the run as failed and applies its retry
      // policy; mark-failed above has already made this visible in the UI.
      throw error;
    }

    await step.run("diff-job-changes", async () => {
      await diffJobChanges(batch.userId, importBatchId);
    });

    // TODO(Phase 6): trigger relationship-strength recompute and
    // quick-suggestion regeneration for this user/org here once the AI
    // pipeline lands (see build plan, phase 6 — "AI depth").

    return { importBatchId, status: "COMPLETE" };
  },
);

/**
 * Compares the two most recent COMPLETE import batches for this user by
 * identityKey + current position (title, company) and writes a
 * JobChangeEvent for every real change. First-appearances (no prior
 * position on record for that identityKey) are not treated as changes.
 */
async function diffJobChanges(userId: string, currentBatchId: string) {
  const completedBatches = await prisma.importBatch.findMany({
    where: { userId, status: "COMPLETE" },
    orderBy: { completedAt: "desc" },
    take: 2,
    select: { id: true },
  });

  if (completedBatches.length < 2) return; // nothing to diff against yet
  const [current, previous] = completedBatches;
  if (current.id !== currentBatchId) return; // stale/out-of-order run

  const [currentPositions, previousPositions] = await Promise.all([
    prisma.position.findMany({ where: { importBatchId: current.id } }),
    prisma.position.findMany({ where: { importBatchId: previous.id } }),
  ]);

  const latestByIdentity = new Map<string, (typeof currentPositions)[number]>();
  for (const position of currentPositions) {
    // Positions.csv has no reliable ordering guarantee; keep the last seen.
    latestByIdentity.set(position.identityKey, position);
  }
  const previousByIdentity = new Map<string, (typeof previousPositions)[number]>();
  for (const position of previousPositions) {
    previousByIdentity.set(position.identityKey, position);
  }

  const events: Prisma.JobChangeEventCreateManyInput[] = [];
  for (const [identityKey, currentPosition] of latestByIdentity) {
    const previousPosition = previousByIdentity.get(identityKey);
    if (!previousPosition) continue; // first appearance, not a change

    const titleChanged = (previousPosition.title ?? null) !== (currentPosition.title ?? null);
    const companyChanged =
      (previousPosition.companyName ?? null) !== (currentPosition.companyName ?? null);
    if (!titleChanged && !companyChanged) continue;

    events.push({
      identityKey,
      previousBatchId: previous.id,
      currentBatchId: current.id,
      previousTitle: previousPosition.title,
      previousCompany: previousPosition.companyName,
      newTitle: currentPosition.title,
      newCompany: currentPosition.companyName,
    });
  }

  if (events.length > 0) {
    await prisma.jobChangeEvent.createMany({ data: events });
  }
}
