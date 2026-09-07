import { Readable } from "node:stream";
import Papa from "papaparse";
import yauzl from "yauzl";
import { NonRetriableError } from "inngest";
import { Prisma } from "@prisma/client";
import { get } from "@vercel/blob";
import { BLOB_ACCESS } from "@/lib/blob";
import { inngest, type ImportBatchCreatedEvent } from "@/inngest/client";
import { prisma } from "@/lib/prisma";
import {
  computeIdentityKey,
  computeNameKey,
  computeNameKeyFromParts,
  normalizeDisplayName,
  normalizeNameParts,
} from "@/lib/ingestion/identity-key";

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

/**
 * Who the export belongs to. Needed to work out which party in a message or
 * invitation is the COUNTERPARTY, so a conversation keys to the other person
 * whether the owner sent the message or received it.
 */
type AccountOwner = {
  name: string | null;
  /** `normalizeDisplayName(name)`, or "" when unknown. */
  normalized: string;
};

/**
 * Resolves the counterparty of a two-party row.
 *
 * Returns `senderIsUser: null` when the owner is unknown, or when the owner's
 * name matches neither side (a renamed profile, a group thread, or a
 * localized name spelling). In that case we still pick `from` as the
 * counterparty, which is correct for inbound messages — the common case for a
 * row we cannot otherwise classify — but the direction is honestly recorded
 * as unknown rather than guessed.
 */
function resolveCounterparty(
  owner: AccountOwner,
  from: string | null,
  to: string | null,
): { counterpartyName: string | null; senderIsUser: boolean | null } {
  if (!owner.normalized) {
    return { counterpartyName: from ?? to, senderIsUser: null };
  }
  if (normalizeDisplayName(from) === owner.normalized) {
    return { counterpartyName: to, senderIsUser: true };
  }
  if (normalizeDisplayName(to) === owner.normalized) {
    return { counterpartyName: from, senderIsUser: false };
  }
  return { counterpartyName: from ?? to, senderIsUser: null };
}

async function processEntry(
  entryPath: string,
  entry: Readable,
  importBatchId: string,
  owner: AccountOwner,
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
        nameKey: computeNameKeyFromParts(firstName, lastName),
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
    // Positions.csv is the ACCOUNT OWNER's own work history — it has no
    // per-person name columns because every row is the owner's. It is kept
    // as useful career context, but it is never used for connection
    // job-change detection (see `diffJobChanges`).
    const rows: Prisma.PositionCreateManyInput[] = [];
    await parseCsvStream(entry, (row) => {
      const companyName = getField(row, ["Company Name", "Company"]);
      rows.push({
        importBatchId,
        isAccountOwner: true,
        // Keyed to the owner, so all of a batch's positions group together.
        identityKey: computeNameKey(owner.name) ?? `owner:${importBatchId}`,
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
      // `Direction` is authoritative when present; otherwise fall back to
      // matching the account owner's name against the two parties.
      const lowerDirection = direction?.trim().toLowerCase();
      const counterpartyName =
        lowerDirection === "outgoing"
          ? to
          : lowerDirection === "incoming"
            ? from
            : resolveCounterparty(owner, from, to).counterpartyName;
      // Newer exports include profile URLs; when present they give an exact
      // `url:` key that joins straight onto Connection.identityKey.
      const counterpartyUrl =
        lowerDirection === "outgoing"
          ? getField(row, ["inviteeProfileUrl", "Invitee Profile URL"])
          : getField(row, ["inviterProfileUrl", "Inviter Profile URL"]);
      rows.push({
        importBatchId,
        identityKey: computeIdentityKey({
          linkedinUrl: counterpartyUrl,
          firstName: counterpartyName,
          lastName: null,
          company: null,
        }),
        nameKey: computeNameKey(counterpartyName),
        counterpartyName,
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
      const { counterpartyName, senderIsUser } = resolveCounterparty(owner, from, to);
      // Prefer the counterparty's profile URL when the export carries one:
      // that yields the same `url:` key Connections.csv produces.
      const counterpartyUrl =
        senderIsUser === true
          ? getField(row, ["RECIPIENT PROFILE URLS", "Recipient Profile Urls", "To Profile URL"])
          : senderIsUser === false
            ? getField(row, ["SENDER PROFILE URL", "Sender Profile Url", "From Profile URL"])
            : null;
      rows.push({
        importBatchId,
        identityKey: computeIdentityKey({
          // A multi-recipient cell would not parse as a URL; normalization
          // leaves it as-is and it simply never matches, which is safe.
          linkedinUrl: counterpartyUrl,
          firstName: counterpartyName,
          lastName: null,
          company: null,
        }),
        nameKey: computeNameKey(counterpartyName),
        counterpartyName,
        senderIsUser,
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
function countAndProcessCsvEntries(
  buffer: Buffer,
  importBatchId: string,
  owner: AccountOwner,
): Promise<number> {
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
          processEntry(entry.fileName, readStream, importBatchId, owner)
            .then(() => zipfile.readEntry())
            .catch(reject);
        });
      });

      zipfile.readEntry();
    });
  });
}

/**
 * Finds the account owner's display name from `Profile.csv` before the main
 * ingest pass.
 *
 * WHY A SEPARATE PASS: zip entries arrive in archive order, so `messages.csv`
 * can be read before `Profile.csv`. Counterparty resolution needs the owner's
 * name for the very first message row, so it has to be known up front. The
 * archive buffer is already in memory, and this pass decompresses only the one
 * small Profile entry, so the cost is negligible.
 *
 * WHY Profile.csv AND NOT `User.name`: the export's own profile row is the
 * name LinkedIn actually writes into the From/To columns of the same export,
 * so it matches exactly. `User.name` is whatever the person typed at signup
 * and can differ (nickname, missing middle name, different script). `User.name`
 * is used only as a fallback when the export has no Profile.csv.
 */
function findAccountOwnerName(buffer: Buffer): Promise<string | null> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("Failed to open zip archive."));
        return;
      }

      let found: string | null = null;
      zipfile.on("error", reject);
      zipfile.on("end", () => resolve(found));

      zipfile.on("entry", (entry) => {
        const lowerBase = (entry.fileName.split("/").pop() ?? entry.fileName).toLowerCase();
        if (found || lowerBase !== "profile.csv") {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            // A missing/unreadable Profile.csv is not fatal — fall back to
            // User.name rather than failing the whole import.
            zipfile.readEntry();
            return;
          }
          parseCsvStream(readStream, (row) => {
            if (found) return;
            const parts = [
              getField(row, ["First Name", "FirstName"]),
              getField(row, ["Last Name", "LastName"]),
            ]
              .filter(Boolean)
              .join(" ")
              .trim();
            // Keep the export's original casing for display; matching is done
            // on the normalized form.
            if (normalizeNameParts(parts, null)) found = parts;
          })
            .then(() => zipfile.readEntry())
            .catch(() => zipfile.readEntry());
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

    const fallbackOwnerName = await step.run("load-owner-name", async () => {
      const user = await prisma.user.findUnique({
        where: { id: batch.userId },
        select: { name: true },
      });
      return user?.name ?? null;
    });

    try {
      const fileCount = await step.run("unzip-and-ingest", async () => {
        // Use the SDK rather than a bare fetch: it authenticates server-side
        // (OIDC via VERCEL_OIDC_TOKEN + BLOB_STORE_ID), so this keeps working
        // if the Blob store is private, where an unauthenticated fetch of the
        // blob URL would 403.
        const result = await get(batch.blobUrl, { access: BLOB_ACCESS });
        if (!result?.stream) {
          throw new Error(`Failed to download blob for batch ${importBatchId}`);
        }
        const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());

        const ownerName = (await findAccountOwnerName(buffer)) ?? fallbackOwnerName;
        const owner: AccountOwner = {
          name: ownerName,
          normalized: normalizeDisplayName(ownerName),
        };

        await prisma.importBatch.update({
          where: { id: importBatchId },
          data: { ownerName: owner.name, ownerNameKey: computeNameKey(owner.name) },
        });

        return countAndProcessCsvEntries(buffer, importBatchId, owner);
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

    // Phase 4: re-score this user's fresh snapshot against the org's ICPs and
    // channel partners. Sent as an event rather than called inline so a slow
    // or failing AI provider can never hold up (or fail) an import that has
    // already been written successfully.
    await step.run("request-match-recompute", async () => {
      const user = await prisma.user.findUnique({
        where: { id: batch.userId },
        select: { organizationId: true },
      });
      if (!user) return { sent: false };
      await inngest.send({
        name: "matches/recompute.requested",
        data: {
          organizationId: user.organizationId,
          userId: batch.userId,
          reason: `import:${importBatchId}`,
        },
      });
      return { sent: true };
    });

    // TODO(Phase 6): trigger relationship-strength recompute and
    // quick-suggestion regeneration for this user/org here once the AI
    // pipeline lands (see build plan, phase 6 — "AI depth").

    return { importBatchId, status: "COMPLETE" };
  },
);

/**
 * Detects job changes among the user's CONNECTIONS.
 *
 * Compares each connection's `(position, company)` between the two most recent
 * COMPLETE import batches for the user, matched on `Connection.identityKey`
 * (the normalized LinkedIn profile URL for essentially every row, since
 * Connections.csv carries a URL column). A connection that appears for the
 * first time is not a change.
 *
 * This deliberately does NOT read the `Position` table. `Positions.csv` in a
 * LinkedIn export is the ACCOUNT OWNER's own work history, not their
 * connections' — diffing it can never surface "someone in my network moved
 * jobs", which is what this feature is for. It also has no name columns, so
 * the old key derivation collapsed every row at one company onto a single
 * identity key.
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

  const select = {
    identityKey: true,
    firstName: true,
    lastName: true,
    linkedinUrl: true,
    company: true,
    position: true,
  } as const;

  const [currentConnections, previousConnections] = await Promise.all([
    prisma.connection.findMany({ where: { importBatchId: current.id }, select }),
    prisma.connection.findMany({ where: { importBatchId: previous.id }, select }),
  ]);

  // A profile can legitimately appear twice in one export (rare duplicate
  // rows); last one wins on both sides so the comparison stays 1:1.
  const currentByIdentity = new Map<string, (typeof currentConnections)[number]>();
  for (const connection of currentConnections) {
    currentByIdentity.set(connection.identityKey, connection);
  }
  const previousByIdentity = new Map<string, (typeof previousConnections)[number]>();
  for (const connection of previousConnections) {
    previousByIdentity.set(connection.identityKey, connection);
  }

  const events: Prisma.JobChangeEventCreateManyInput[] = [];
  for (const [identityKey, currentConnection] of currentByIdentity) {
    const previousConnection = previousByIdentity.get(identityKey);
    if (!previousConnection) continue; // brand-new connection, not a change

    // Compare on the normalized value so pure formatting churn in the export
    // ("Acme Inc." vs "acme inc.") does not raise a false job-change alert.
    const titleChanged =
      normalizeDisplayName(previousConnection.position) !==
      normalizeDisplayName(currentConnection.position);
    const companyChanged =
      normalizeDisplayName(previousConnection.company) !==
      normalizeDisplayName(currentConnection.company);
    if (!titleChanged && !companyChanged) continue;

    events.push({
      identityKey,
      // Denormalized so the dashboard can name the person directly instead of
      // doing a second lookup against Connection.
      personName:
        [currentConnection.firstName, currentConnection.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() || null,
      linkedinUrl: currentConnection.linkedinUrl,
      previousBatchId: previous.id,
      currentBatchId: current.id,
      previousTitle: previousConnection.position,
      previousCompany: previousConnection.company,
      newTitle: currentConnection.position,
      newCompany: currentConnection.company,
    });
  }

  if (events.length > 0) {
    await flush(events, (chunk) => prisma.jobChangeEvent.createMany({ data: chunk }));
  }
}
