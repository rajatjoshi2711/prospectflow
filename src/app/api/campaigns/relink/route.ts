import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guards";
import { relinkUserCampaignLeads } from "@/lib/campaigns/link";

/**
 * "Refresh from my network" — re-links the signed-in user's campaign leads
 * against their current import snapshot and re-materializes lead status.
 *
 * WHY THIS EXISTS
 * ---------------
 * The same pass runs automatically at campaign creation and after every
 * import, which covers the normal flow. It does not cover the gap between
 * those two events: a campaign built before its owner imported anything, or
 * one built before a change to the linking or status rules shipped, keeps
 * whatever it resolved to at the time. Without a manual trigger the only way
 * to refresh was to re-upload a LinkedIn export, which is a heavy answer to
 * "recompute something you already have the data for".
 *
 * SCOPING
 *   `userId` comes from the session and is never accepted from the body, so
 *   there is no id to tamper with. The underlying function is scoped to that
 *   user's own campaigns.
 *
 * COST
 *   No AI, so this is deliberately NOT on the `consumeAiQuota` buckets. It is
 *   plain database work: one indexed read of the user's leads, one of their
 *   current snapshot, and an update only for rows that actually changed.
 *   Re-running it changes nothing, so a double click is harmless.
 *
 *   A hand-set status (`statusSetAt`) is never overwritten.
 */

export const runtime = "nodejs";

export async function POST() {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;

  const result = await relinkUserCampaignLeads(guard.session.userId);

  return NextResponse.json({
    ok: true,
    examined: result.examined,
    relinked: result.relinked,
    restatused: result.restatused,
  });
}
