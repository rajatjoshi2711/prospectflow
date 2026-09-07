"use client";

import { uploadPresigned } from "@vercel/blob/client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  BLOB_ACCESS,
  MAX_SPREADSHEET_BYTES,
  SPREADSHEET_EXTENSIONS,
  hasSpreadsheetExtension,
} from "@/lib/blob";

/**
 * Step 1 of the campaign flow: name it, upload the lead list.
 *
 * The `Campaign` row is created server-side by the Blob completion webhook, so
 * this never learns the id from the upload call itself. It polls
 * `/api/campaigns?blobUrl=` — scoped to the session user — with the URL
 * `uploadPresigned` returned, then hands off to the campaign page, which runs
 * the confirmation step.
 */

const POLL_INTERVAL_MS = 1200;
const POLL_ATTEMPTS = 25;
const ACCEPT = SPREADSHEET_EXTENSIONS.join(",");

async function findCampaignByBlob(blobUrl: string): Promise<string | null> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`/api/campaigns?blobUrl=${encodeURIComponent(blobUrl)}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { campaigns: { id: string }[] };
        if (data.campaigns.length > 0) return data.campaigns[0].id;
      }
    } catch {
      // Transient — keep polling until the attempt budget runs out.
    }
  }
  return null;
}

export function CampaignUploader() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "waiting">("idle");
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const busy = phase !== "idle";

  function chooseFile(next: File) {
    setError(null);
    if (!hasSpreadsheetExtension(next.name)) {
      setError(
        next.name.toLowerCase().endsWith(".xls")
          ? "The old .xls format is not supported. Re-save the file as .xlsx and try again."
          : "Choose an .xlsx, .xlsm or .csv file.",
      );
      return;
    }
    if (next.size > MAX_SPREADSHEET_BYTES) {
      setError("That file is larger than the 10MB limit.");
      return;
    }
    setFile(next);
    if (!name.trim()) setName(next.name.replace(/\.[^.]+$/, ""));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("Choose a lead list to upload.");
      return;
    }

    setError(null);
    setPhase("uploading");
    try {
      const blob = await uploadPresigned(file.name, file, {
        access: BLOB_ACCESS,
        handleUploadUrl: "/api/uploads/campaign-blob-token",
        clientPayload: JSON.stringify({ name: name.trim() }),
      });

      setPhase("waiting");
      const campaignId = await findCampaignByBlob(blob.url);
      if (!campaignId) {
        setError(
          "The file uploaded, but the campaign is taking longer than usual to appear. Check the campaigns list in a moment.",
        );
        setPhase("idle");
        return;
      }
      router.push(`/campaigns/${campaignId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Try again.");
      setPhase("idle");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" style={{ maxWidth: 620 }}>
      <div className="ef-card ef-rise">
        <label className="ef-label" htmlFor="campaign-name">
          Campaign name
        </label>
        <input
          id="campaign-name"
          className="ef-input"
          value={name}
          maxLength={120}
          disabled={busy}
          placeholder="Q3 outbound — fintech founders"
          onChange={(event) => setName(event.target.value)}
        />
        <p className="ef-caption mt-2">
          Campaigns are yours alone. Nobody else in the org sees this list.
        </p>
      </div>

      <div className="ef-card">
        <p className="ef-subhead mb-1">Lead list</p>
        <p className="ef-small mb-4" style={{ color: "var(--text-secondary)" }}>
          An .xlsx, .xlsm or .csv file with one lead per row and a header row on
          top. Max 10MB. The column holding LinkedIn profile URLs is detected
          for you — you confirm it on the next screen.
        </p>
        <div className="flex items-center gap-3">
          <label className={`ef-btn ${busy ? "ef-btn-disabled" : "ef-btn-secondary"}`} style={{ cursor: busy ? "default" : "pointer" }}>
            {file ? "Choose a different file" : "Choose file"}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              hidden
              disabled={busy}
              onChange={(event) => {
                const next = event.target.files?.[0];
                if (next) chooseFile(next);
              }}
            />
          </label>
          {file ? (
            <span className="ef-small" style={{ color: "var(--text-secondary)" }}>
              {file.name}
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div
          className="ef-small rounded-[10px] px-4 py-3"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button type="submit" className="ef-btn ef-btn-primary" disabled={busy || !file}>
          {phase === "uploading"
            ? "Uploading…"
            : phase === "waiting"
              ? "Reading your file…"
              : "Upload and detect column"}
        </button>
        {phase === "waiting" ? (
          <span className="ef-caption">
            Finding the LinkedIn URL column. This usually takes a few seconds.
          </span>
        ) : null}
      </div>
    </form>
  );
}
