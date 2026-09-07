import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned } from "@vercel/blob/client";
import type { HandleUploadPresignedBody } from "@vercel/blob/client";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { inngest } from "@/inngest/client";
import {
  MAX_SPREADSHEET_BYTES,
  SPREADSHEET_CONTENT_TYPES,
  hasSpreadsheetExtension,
} from "@/lib/blob";

/**
 * Presigned upload for a campaign lead list (Phase 5).
 *
 * Identical OIDC flow to `api/uploads/blob-token` (the LinkedIn export upload):
 * `handleUploadPresigned` + `issueSignedToken`, session authenticated at
 * token-mint time, the verified `tokenPayload` re-checked in the completion
 * webhook, and the DB row created there. No static BLOB_READ_WRITE_TOKEN.
 *
 * The only differences are the accepted extensions, the smaller size cap, and
 * that the row it creates is a `Campaign` rather than an `ImportBatch`.
 */

const TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Threaded through the direct-to-blob upload so the completion webhook (which
 * runs without request cookies) knows whose campaign this is. Built from the
 * REAL session at token-generation time — a client-supplied userId is never
 * trusted. `name` is user-typed text and is validated here before it is stored.
 */
type CampaignUploadPayload = {
  userId: string;
  organizationId: string;
  name: string;
  fileName: string;
};

const MAX_NAME_LENGTH = 120;

export async function POST(request: NextRequest) {
  const body = (await request.json()) as HandleUploadPresignedBody;

  try {
    const jsonResponse = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async (pathname, clientPayload) => {
        const session = await getSession();
        if (!session) {
          throw new Error("Unauthorized");
        }
        if (!hasSpreadsheetExtension(pathname)) {
          throw new Error("Upload an .xlsx, .xlsm or .csv file.");
        }

        // The client sends only the campaign NAME. Everything identifying comes
        // from the session below it.
        let name = "";
        if (typeof clientPayload === "string" && clientPayload.length > 0) {
          try {
            const parsed = JSON.parse(clientPayload) as { name?: unknown };
            if (typeof parsed.name === "string") name = parsed.name.trim();
          } catch {
            throw new Error("Invalid upload payload.");
          }
        }
        if (!name) {
          // Fall back to the file's own name rather than rejecting the upload.
          name = pathname.split("/").pop()?.replace(/\.[^.]+$/, "") || "Untitled campaign";
        }
        if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH);

        const payload: CampaignUploadPayload = {
          userId: session.userId,
          organizationId: session.organizationId,
          name,
          fileName: pathname.split("/").pop() ?? pathname,
        };

        const validUntil = Date.now() + TOKEN_TTL_MS;

        const token = await issueSignedToken({
          pathname,
          operations: ["put"],
          allowedContentTypes: SPREADSHEET_CONTENT_TYPES,
          maximumSizeInBytes: MAX_SPREADSHEET_BYTES,
          validUntil,
        });

        return {
          token,
          urlOptions: {
            allowedContentTypes: SPREADSHEET_CONTENT_TYPES,
            maximumSizeInBytes: MAX_SPREADSHEET_BYTES,
            validUntil,
            addRandomSuffix: true,
            allowOverwrite: false,
            tokenPayload: JSON.stringify(payload),
          },
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        if (!tokenPayload) {
          throw new Error("Missing upload token payload.");
        }
        const { userId, organizationId, name, fileName } = JSON.parse(
          tokenPayload,
        ) as CampaignUploadPayload;

        // Re-verify rather than trusting the payload blindly, as the import
        // upload does.
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.organizationId !== organizationId) {
          throw new Error("Upload rejected: user/org mismatch.");
        }

        const campaign = await prisma.campaign.create({
          data: {
            userId: user.id,
            name,
            sourceFileName: fileName,
            status: "PENDING",
            blobUrl: blob.url,
          },
        });

        await inngest.send({
          name: "campaign/file.uploaded",
          data: { campaignId: campaign.id },
        });
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 },
    );
  }
}
