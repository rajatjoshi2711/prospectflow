import "server-only";

import { inngest } from "@/inngest/client";

/**
 * Requests a match recompute after an admin changes a definition.
 *
 * Deliberately best-effort: a definition must still save if Inngest is
 * unreachable (no event key configured locally, transient outage). The caller
 * gets `false` back and can tell the admin that scoring will catch up on the
 * next import, rather than seeing the save fail.
 */
export async function requestMatchRecompute(data: {
  organizationId: string;
  userId?: string;
  icpIds?: string[];
  channelPartnerIds?: string[];
  reason?: string;
}): Promise<boolean> {
  try {
    await inngest.send({ name: "matches/recompute.requested", data });
    return true;
  } catch (error) {
    console.error("Failed to enqueue match recompute", error);
    return false;
  }
}
