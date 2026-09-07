"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
// From `detection-types`, not `detect-column`: the latter imports the LLM
// provider and would drag the OpenAI SDK into this client bundle.
import { DETECTION_METHOD_LABEL, type ColumnDetection } from "@/lib/campaigns/detection-types";

/**
 * Step 2: show the detected LinkedIn-URL column with real values from the
 * user's own file, and let them override it before any lead is created.
 *
 * This screen exists because the column choice drives every lead-to-connection
 * match. A wrong guess accepted silently produces a campaign that matches
 * nobody, with no obvious symptom, so the flow always stops here — even when
 * the heuristic is certain.
 */

export type ColumnConfirmProps = {
  campaignId: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  detection: ColumnDetection;
};

const PREVIEW_ROWS = 5;

export function CampaignColumnConfirm({
  campaignId,
  headers,
  sampleRows,
  detection,
}: ColumnConfirmProps) {
  const router = useRouter();
  const [column, setColumn] = useState(detection.column ?? headers[0] ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overridden = detection.column !== null && column !== detection.column;
  const preview = sampleRows.slice(0, PREVIEW_ROWS);

  async function confirm() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ column }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Could not confirm that column.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="ef-card ef-rise">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span
            className={`ef-badge ${
              detection.method === "heuristic"
                ? "ef-badge-success"
                : detection.method === "none"
                  ? "ef-badge-warning"
                  : "ef-badge-info"
            }`}
          >
            {detection.method === "none"
              ? "No column detected"
              : detection.method === "llm"
                ? "AI suggestion"
                : `${Math.round(detection.confidence * 100)}% of sampled cells matched`}
          </span>
          <span className="ef-caption">{DETECTION_METHOD_LABEL[detection.method]}</span>
        </div>

        <p className="ef-subhead mb-1">Which column holds the LinkedIn profile URLs?</p>
        <p className="ef-small mb-4" style={{ color: "var(--text-secondary)" }}>
          This column is how leads are matched against your own network, so it
          is worth a second look. Not right? Pick a different one.
        </p>

        <label className="ef-label" htmlFor="linkedin-column">
          LinkedIn URL column
        </label>
        <select
          id="linkedin-column"
          className="ef-input"
          style={{ maxWidth: 360 }}
          value={column}
          disabled={submitting}
          onChange={(event) => setColumn(event.target.value)}
        >
          {headers.map((header) => (
            <option key={header} value={header}>
              {header}
              {header === detection.column ? " (detected)" : ""}
            </option>
          ))}
        </select>
        {overridden ? (
          <p className="ef-caption mt-2" style={{ color: "var(--blue-500)" }}>
            Overriding the detected column &ldquo;{detection.column}&rdquo;.
          </p>
        ) : null}

        {error ? (
          <div
            className="ef-small mt-4 rounded-[10px] px-4 py-3"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            className="ef-btn ef-btn-primary"
            disabled={submitting || !column}
            onClick={() => void confirm()}
          >
            {submitting ? "Creating leads…" : "Confirm and create leads"}
          </button>
          <span className="ef-caption">
            {preview.length > 0
              ? `Previewing the first ${preview.length} of ${sampleRows.length} sampled rows.`
              : null}
          </span>
        </div>
      </div>

      {preview.length > 0 ? (
        <div className="ef-card overflow-x-auto p-0">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr style={{ background: "var(--bg-subtle)" }}>
                {headers.map((header) => (
                  <th
                    key={header}
                    className="ef-small whitespace-nowrap px-4 py-3"
                    style={{
                      fontWeight: 700,
                      color: header === column ? "var(--blue-500)" : "var(--text-primary)",
                      background: header === column ? "var(--blue-50)" : undefined,
                    }}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((row, index) => (
                <tr
                  key={index}
                  className="border-t"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  {headers.map((header) => (
                    <td
                      key={header}
                      className="ef-small px-4 py-2"
                      style={{
                        maxWidth: 280,
                        background: header === column ? "var(--blue-50)" : undefined,
                        color:
                          header === column ? "var(--text-primary)" : "var(--text-secondary)",
                      }}
                    >
                      <span className="block truncate">{row[header] || "—"}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
