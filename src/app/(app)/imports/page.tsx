import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ImportsManager } from "@/components/imports-manager";

export default async function ImportsPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const batches = await prisma.importBatch.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      blobUrl: true,
      fileCount: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true,
      _count: { select: { jobChangeEventsAsCurrent: true } },
    },
  });

  return (
    <div>
      <p className="ef-eyebrow mb-2">Phase 2 — ingestion</p>
      <h1 className="ef-page mb-2">Imports</h1>
      <p className="ef-lead mb-8" style={{ maxWidth: 640 }}>
        Upload your LinkedIn data export (the .zip you get from LinkedIn&apos;s
        &ldquo;Get a copy of your data&rdquo;) and browse every past import here. Each
        upload creates a new version — nothing is ever overwritten.
      </p>
      <ImportsManager
        initialBatches={batches.map((b) => ({
          id: b.id,
          status: b.status,
          fileCount: b.fileCount,
          errorMessage: b.errorMessage,
          createdAt: b.createdAt.toISOString(),
          completedAt: b.completedAt ? b.completedAt.toISOString() : null,
          jobChangeCount: b._count.jobChangeEventsAsCurrent,
        }))}
      />
    </div>
  );
}
