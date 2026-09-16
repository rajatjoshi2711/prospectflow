import "server-only";

import { get } from "@vercel/blob";
import { NonRetriableError } from "inngest";
import type { Prisma } from "@prisma/client";
import { BLOB_ACCESS } from "@/lib/blob";
import { prisma } from "@/lib/prisma";
import {
  DETECTION_SAMPLE_ROWS,
  MAX_CAMPAIGN_LEADS,
  SpreadsheetParseError,
  parseSpreadsheet,
  type SpreadsheetRow,
} from "@/lib/campaigns/parse-spreadsheet";
import { detectLinkedinColumn } from "@/lib/campaigns/detect-column";
import { extractLeadFields } from "@/lib/campaigns/fields";
import {
  buildConnectionIndex,
  relinkUserCampaignLeads,
  resolveConnectionId,
} from "@/lib/campaigns/link";
import {
  computeIdentityKey,
  computeNameKeyFromParts,
  normalizeLinkedinUrl,
} from "@/lib/ingestion/identity-key";

const CHUNK_SIZE = 500;

/**
 * Downloads an uploaded lead list from Blob storage.
 *
 * Uses the SDK's `get()` rather than a bare fetch: the store is private
 * (`BLOB_ACCESS`), so an unauthenticated fetch of the blob URL 403s. `get()`
 * authenticates server-side via OIDC, exactly as the import worker does.
 */
async function downloadCampaignFile(blobUrl: string): Promise<Buffer> {
  const result = await get(blobUrl, { access: BLOB_ACCESS });
  if (!result?.stream) {
    throw new Error("Could not download the uploaded file from storage.");
  }
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

async function markFailed(campaignId: string, error: unknown) {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: "FAILED",
      errorMessage:
        error instanceof Error ? error.message : "Unknown error while processing the lead list.",
    },
  });
}

/**
 * STEP 1 — sample the uploaded file and propose the LinkedIn-URL column.
 *
 * Writes the proposal, the header row and the sampled rows onto the Campaign
 * and parks it in `AWAITING_CONFIRMATION`. NO lead rows are created here: the
 * column choice drives every downstream match, so a human confirms it first.
 */
export async function detectCampaignColumns(campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    // The owner's org comes with the campaign so the detection call can be
    // attributed to a tenant. A Campaign is per-user and carries no
    // organizationId of its own.
    include: { user: { select: { organizationId: true } } },
  });
  if (!campaign) throw new NonRetriableError(`Campaign ${campaignId} not found`);
  if (!campaign.blobUrl) throw new NonRetriableError(`Campaign ${campaignId} has no uploaded file`);
  // Already past detection (a duplicate webhook, or a replayed run) — do not
  // clobber a column the user has since confirmed.
  if (campaign.status !== "PENDING" && campaign.status !== "DETECTING") {
    return { campaignId, skipped: true as const, status: campaign.status };
  }

  await prisma.campaign.update({ where: { id: campaignId }, data: { status: "DETECTING" } });

  try {
    const buffer = await downloadCampaignFile(campaign.blobUrl);
    const { headers, rows } = await parseSpreadsheet(
      buffer,
      campaign.sourceFileName ?? "upload.xlsx",
      { maxRows: DETECTION_SAMPLE_ROWS },
    );

    if (rows.length === 0) {
      throw new SpreadsheetParseError("That file has a header row but no data rows.");
    }

    const detection = await detectLinkedinColumn(headers, rows, {
      organizationId: campaign.user.organizationId,
      userId: campaign.userId,
      useCase: "CAMPAIGN_COLUMN_DETECTION",
    });

    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: "AWAITING_CONFIRMATION",
        columnHeaders: headers,
        sampleRows: rows as unknown as Prisma.InputJsonValue,
        detectedColumn: detection.column,
        detectionConfidence: detection.confidence,
        detectionMethod: detection.method,
      },
    });

    return { campaignId, skipped: false as const, detection };
  } catch (error) {
    await markFailed(campaignId, error);
    // A bad file is the user's to fix, not something a retry can help with.
    if (error instanceof SpreadsheetParseError) {
      throw new NonRetriableError(error.message);
    }
    throw error;
  }
}

/**
 * STEP 2 — the user confirmed a column; create the leads and link them.
 *
 * Idempotent by construction: it deletes any leads already attached to the
 * campaign before inserting, so an Inngest replay (or a user re-confirming with
 * a different column) rebuilds cleanly instead of doubling every row.
 */
export async function buildCampaignLeads(campaignId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new NonRetriableError(`Campaign ${campaignId} not found`);
  if (!campaign.blobUrl) throw new NonRetriableError(`Campaign ${campaignId} has no uploaded file`);
  if (campaign.status === "COMPLETE") {
    return { campaignId, skipped: true as const, leadCount: campaign.leadCount ?? 0 };
  }
  if (!campaign.linkedinColumn) {
    throw new NonRetriableError(`Campaign ${campaignId} has no confirmed LinkedIn column`);
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: "PROCESSING", errorMessage: null },
  });

  try {
    const buffer = await downloadCampaignFile(campaign.blobUrl);
    const { headers, rows, truncated } = await parseSpreadsheet(
      buffer,
      campaign.sourceFileName ?? "upload.xlsx",
      { maxRows: MAX_CAMPAIGN_LEADS },
    );

    const urlColumn = headers.includes(campaign.linkedinColumn) ? campaign.linkedinColumn : null;
    if (!urlColumn) {
      throw new SpreadsheetParseError(
        `The file no longer has a column called "${campaign.linkedinColumn}".`,
      );
    }

    const { byIdentity, byName } = await buildConnectionIndex(campaign.userId);

    const leads: Prisma.CampaignLeadCreateManyInput[] = [];
    let matched = 0;

    for (const row of rows as SpreadsheetRow[]) {
      const fields = extractLeadFields(row);
      const rawUrl = (row[urlColumn] ?? "").trim();
      const normalizedUrl = normalizeLinkedinUrl(rawUrl);
      // Store the canonical `https://<host><path>` form so every lead's link
      // opens correctly even when the sheet held a bare `linkedin.com/in/x`.
      const linkedinUrl = normalizedUrl ? `https://${normalizedUrl}` : null;

      const identityKey = computeIdentityKey({
        linkedinUrl: rawUrl || null,
        firstName: fields.firstName,
        lastName: fields.lastName,
        company: fields.company,
      });
      const nameKey = computeNameKeyFromParts(fields.firstName, fields.lastName);

      const connectionId = resolveConnectionId({ byIdentity, byName }, identityKey, nameKey);
      if (connectionId) matched += 1;

      leads.push({
        campaignId,
        connectionId,
        linkedinUrl,
        firstName: fields.firstName,
        lastName: fields.lastName,
        company: fields.company,
        position: fields.position,
        identityKey,
        nameKey,
        // The original row, verbatim — nothing the importer failed to map is
        // lost, and the detail table can show real context from the sheet.
        rawRow: row as unknown as Prisma.InputJsonValue,
      });
    }

    await prisma.campaignLead.deleteMany({ where: { campaignId } });
    for (let index = 0; index < leads.length; index += CHUNK_SIZE) {
      await prisma.campaignLead.createMany({ data: leads.slice(index, index + CHUNK_SIZE) });
    }

    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: "COMPLETE",
        completedAt: new Date(),
        leadCount: leads.length,
        matchedLeadCount: matched,
        errorMessage: truncated
          ? `Only the first ${MAX_CAMPAIGN_LEADS.toLocaleString()} rows were imported — the file had more.`
          : null,
      },
    });

    // Leads are inserted with `status` at its column default. Materialize the
    // real status now, so a brand-new campaign is correct immediately instead
    // of waiting for the next import to run the same pass.
    await relinkUserCampaignLeads(campaign.userId);

    return { campaignId, skipped: false as const, leadCount: leads.length, matched };
  } catch (error) {
    await markFailed(campaignId, error);
    if (error instanceof SpreadsheetParseError) {
      throw new NonRetriableError(error.message);
    }
    throw error;
  }
}
