"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Refreshes the campaign page while background work is still running.
 *
 * Detection and lead creation both happen in Inngest, so the page that renders
 * right after an upload or a confirmation has nothing to show yet. This polls
 * the campaign's own status route and re-renders the server component once the
 * status moves on, then stops. Same idea as the imports page's poll, scoped to
 * one campaign.
 */
export function CampaignStatusPoller({
  campaignId,
  currentStatus,
  intervalMs = 3000,
}: {
  campaignId: string;
  currentStatus: string;
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { campaign: { status: string } };
        if (!cancelled && data.campaign.status !== currentStatus) {
          router.refresh();
        }
      } catch {
        // Transient — the next tick retries.
      }
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [campaignId, currentStatus, intervalMs, router]);

  return null;
}
