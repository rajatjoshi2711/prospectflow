"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Delete control for a campaign row.
 *
 * Deleting is irreversible and takes every lead with it, so this is a
 * two-step: the first click swaps the icon for an inline "Are you sure?" that
 * also names what is about to be lost, and only the second click calls the
 * API. An inline confirm is used rather than `window.confirm` so the wording
 * can be specific about the consequence.
 *
 * The lead list itself is reproducible — the user still has the spreadsheet —
 * but any outreach status they set by hand is not, which is what the
 * confirmation calls out.
 *
 * The trigger is an icon, so it carries an `aria-label` and a `title`: a bare
 * glyph has no accessible name, and the row it sits in gives no context to a
 * screen reader beyond "button".
 */
function TrashIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}
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
        style={{
          padding: 6,
          lineHeight: 0,
          color: "var(--text-secondary)",
          display: "inline-flex",
        }}
        onClick={() => setConfirming(true)}
        aria-label={`Delete campaign ${campaignName}`}
        title={`Delete campaign ${campaignName}`}
      >
        <TrashIcon />
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <span className="ef-small" style={{ fontWeight: 600 }}>
        Are you sure?
      </span>
      <span className="ef-caption" style={{ color: "var(--text-secondary)" }}>
        {leadCount > 0
          ? `This deletes ${leadCount.toLocaleString()} leads and any status you set.`
          : "This cannot be undone."}
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
