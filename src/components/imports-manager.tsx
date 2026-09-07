"use client";

import { uploadPresigned } from "@vercel/blob/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { BLOB_ACCESS, MAX_UPLOAD_BYTES } from "@/lib/blob";

export type ImportBatchRow = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";
  fileCount: number | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  jobChangeCount: number;
};

const STATUS_BADGE: Record<ImportBatchRow["status"], { className: string; label: string }> = {
  PENDING: { className: "ef-badge-neutral", label: "Pending" },
  PROCESSING: { className: "ef-badge-warning", label: "Processing" },
  COMPLETE: { className: "ef-badge-success", label: "Complete" },
  FAILED: { className: "ef-badge-danger", label: "Failed" },
};

function hasInFlightBatch(batches: ImportBatchRow[]) {
  return batches.some((b) => b.status === "PENDING" || b.status === "PROCESSING");
}

export function ImportsManager({ initialBatches }: { initialBatches: ImportBatchRow[] }) {
  const [batches, setBatches] = useState(initialBatches);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/imports", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { batches: ImportBatchRow[] };
      setBatches(data.batches);
    } catch {
      // Silent — the manual "Refresh" button and next poll tick will retry.
    }
  }, []);

  // Auto-refresh while any batch is still PENDING/PROCESSING, so status
  // transitions become visible without a full page reload.
  useEffect(() => {
    if (!hasInFlightBatch(batches)) return;
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [batches, refresh]);

  async function handleFile(file: File) {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Only .zip files are accepted.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("File is larger than the 50MB upload limit.");
      return;
    }

    setIsUploading(true);
    try {
      await uploadPresigned(file.name, file, {
        access: BLOB_ACCESS,
        handleUploadUrl: "/api/uploads/blob-token",
      });
      // The ImportBatch row is created server-side once the blob upload
      // completes (onUploadCompleted), so give it a moment then refresh.
      setTimeout(refresh, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Try again.");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div
        className="ef-card ef-rise"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        style={{
          borderStyle: "dashed",
          borderColor: isDragging ? "var(--blue-500)" : "var(--border-subtle)",
          background: isDragging ? "var(--blue-50)" : "#fff",
        }}
      >
        <p className="ef-subhead mb-1">Upload a LinkedIn export</p>
        <p className="ef-small mb-4" style={{ color: "var(--text-secondary)" }}>
          Drag a .zip file here, or choose one from your computer. Max 50MB.
        </p>
        <div className="flex items-center gap-3">
          <label className="ef-btn ef-btn-primary" style={{ cursor: "pointer" }}>
            {isUploading ? "Uploading…" : "Choose file"}
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              hidden
              disabled={isUploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </label>
          <button
            type="button"
            className="ef-btn ef-btn-secondary"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
        {error ? (
          <div
            className="ef-small mt-4 rounded-[10px] px-4 py-3"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            {error}
          </div>
        ) : null}
      </div>

      <div>
        <p className="ef-subhead mb-3">Version history</p>
        {batches.length === 0 ? (
          <div className="ef-card">
            <p className="ef-small" style={{ color: "var(--text-secondary)" }}>
              No imports yet. Upload your first LinkedIn export above.
            </p>
          </div>
        ) : (
          <div className="ef-card overflow-hidden p-0">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr style={{ background: "var(--bg-subtle)" }}>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>Date</th>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>Status</th>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>Files</th>
                  <th className="ef-small px-5 py-3" style={{ fontWeight: 700 }}>Job changes</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => {
                  const badge = STATUS_BADGE[batch.status];
                  return (
                    <tr key={batch.id} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                      <td className="ef-small px-5 py-3">
                        {new Date(batch.createdAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3">
                        <span className={`ef-badge ${badge.className}`}>{badge.label}</span>
                        {batch.status === "FAILED" && batch.errorMessage ? (
                          <span className="ef-caption ml-2" style={{ color: "var(--danger)" }}>
                            {batch.errorMessage}
                          </span>
                        ) : null}
                      </td>
                      <td className="ef-small px-5 py-3">
                        {batch.fileCount ?? "—"}
                      </td>
                      <td className="px-5 py-3">
                        {batch.status === "COMPLETE" && batch.jobChangeCount > 0 ? (
                          <span className="ef-badge ef-badge-info">
                            {batch.jobChangeCount} job change{batch.jobChangeCount === 1 ? "" : "s"} detected
                          </span>
                        ) : (
                          <span className="ef-caption">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
