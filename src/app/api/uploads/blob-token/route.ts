import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned } from "@vercel/blob/client";
import type { HandleUploadPresignedBody } from "@vercel/blob/client";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { inngest } from "@/inngest/client";
import { MAX_UPLOAD_BYTES, ZIP_CONTENT_TYPES } from "@/lib/blob";

// One hour of validity for the delegation + presigned URL, which comfortably
// covers a 50MB upload on a slow connection.
const TOKEN_TTL_MS = 60 * 60 * 1000;

// Payload we thread through the direct-to-blob upload so the
// onUploadCompleted callback (which runs server-side, without request
// cookies) knows which user/org this import belongs to. It is produced here,
// from the *actual authenticated session at token-generation time* — never
// trust a client-supplied userId/organizationId directly.
type UploadClientPayload = {
  userId: string;
  organizationId: string;
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as HandleUploadPresignedBody;

  try {
    // OIDC-compatible presigned flow: authenticates against the Blob control
    // plane with VERCEL_OIDC_TOKEN + BLOB_STORE_ID, and verifies the
    // upload-completed webhook with BLOB_WEBHOOK_PUBLIC_KEY. No static
    // BLOB_READ_WRITE_TOKEN is involved anywhere in this path.
    const jsonResponse = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async (pathname) => {
        // Validate the real session from cookies before minting an upload
        // token — this is the only trustworthy point to establish identity.
        const session = await getSession();
        if (!session) {
          throw new Error("Unauthorized");
        }
        if (!pathname.toLowerCase().endsWith(".zip")) {
          throw new Error("Only .zip files are accepted.");
        }

        const clientPayload: UploadClientPayload = {
          userId: session.userId,
          organizationId: session.organizationId,
        };

        const validUntil = Date.now() + TOKEN_TTL_MS;

        const token = await issueSignedToken({
          pathname,
          operations: ["put"],
          allowedContentTypes: ZIP_CONTENT_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          validUntil,
        });

        return {
          token,
          urlOptions: {
            allowedContentTypes: ZIP_CONTENT_TYPES,
            maximumSizeInBytes: MAX_UPLOAD_BYTES,
            validUntil,
            addRandomSuffix: true,
            allowOverwrite: false,
            tokenPayload: JSON.stringify(clientPayload),
          },
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        if (!tokenPayload) {
          throw new Error("Missing upload token payload.");
        }
        const { userId, organizationId } = JSON.parse(
          tokenPayload,
        ) as UploadClientPayload;

        // Re-verify the user still exists and still belongs to the org
        // encoded in the token, rather than trusting the payload blindly.
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || user.organizationId !== organizationId) {
          throw new Error("Upload rejected: user/org mismatch.");
        }

        const batch = await prisma.importBatch.create({
          data: {
            userId: user.id,
            status: "PENDING",
            blobUrl: blob.url,
          },
        });

        await inngest.send({
          name: "import/batch.created",
          data: { importBatchId: batch.id },
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
