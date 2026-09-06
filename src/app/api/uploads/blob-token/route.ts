import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { handleUpload } from "@vercel/blob/client";
import type { HandleUploadBody } from "@vercel/blob/client";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { inngest } from "@/inngest/client";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB safety net (see build plan).

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
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
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

        return {
          allowedContentTypes: [
            "application/zip",
            "application/x-zip-compressed",
            "application/octet-stream",
          ],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify(clientPayload),
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
