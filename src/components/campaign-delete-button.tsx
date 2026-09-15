"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Delete control for a campaign row.
 *
 * Deleting is irreversible and takes every lead with it, so this is a
 * two-step: the first click swaps the button for an inline confirmation that
 * names the campaign and its lead count, and only the second click calls the
 * API. An inline confirm is used rather than `window.confirm` so the wording
 * can actually say what is about to be lost.
 *
 * The lead list itself is reproducible — the user still has the spreadsheet —
 * but any outreach status they set by hand is not, which is what the
 * confirmation calls out.
 */
export function CampaignDeleteButton({
  campaignId,
  campaignName,
  leadCount,
}: {
  campaignId: string;
  campaignName: string;
  leadCount: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Could not delete that campaign.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that campaign.");
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="ef-caption" style={{ color: "var(--danger)" }}>
          {error}
        </span>
        <button type="button" className="ef-btn ef-btn-text" onClick={() => setError(null)}>
          Try again
        </button>
      </div>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="ef-btn ef-btn-text"
        style={{ padding: "4px 10px", fontSize: "var(--fs-small)" }}
        onClick={() => setConfirming(true)}
        aria-label={`Delete campaign ${campaignName}`}
      >
        Delete
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="ef-caption" style={{ color: "var(--text-secondary)" }}>
        {leadCount > 0
          ? `Delete ${leadCount.toLocaleString()} leads and any status you set?`
          : "Delete this campaign?"}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className="ef-btn ef-btn-secondary"
          style={{ padding: "4px 10px", fontSize: "var(--fs-small)" }}
          disabled={deleting}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ef-btn ef-btn-danger"
          style={{ padding: "4px 10px", fontSize: "var(--fs-small)" }}
          disabled={deleting}
          onClick={() => void handleDelete()}
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}
