import type { CampaignLeadStatus } from "@prisma/client";
import { getSignal, type InteractionSignalMap } from "@/lib/insights/signals";

/**
 * Outreach status for a person.
 *
 * `CampaignLeadStatus` is stored on `CampaignLead` (Phase 5). A plain
 * `Connection` has no stored status, so for the connections/dashboard views we
 * DERIVE one from what the LinkedIn export actually contains. The rules, in
 * order:
 *
 *   1. They messaged us, or messages went both ways  -> CONVERSATION_ONGOING
 *   2. We messaged them and they never replied       -> FIRST_MESSAGE_SENT
 *   3. They are in Connections.csv (so we are        -> REQUEST_ACCEPTED
 *      connected) with no message history
 *   4. Only an invitation record exists              -> REQUEST_PENDING
 *
 * Nothing here is invented: every branch is backed by an ingested row. When a
 * lead has a real stored `CampaignLead.status`, pass it as `storedStatus` and
 * it always wins.
 *
 * TODO(Phase 5): once campaigns exist, prefer the stored CampaignLead status
 * for any connection that appears in one of the user's campaigns.
 */
export function deriveLeadStatus({
  isConnected,
  signals,
  identityKey,
  storedStatus,
}: {
  /** True when the person has a row in the current batch's Connections.csv. */
  isConnected: boolean;
  signals: InteractionSignalMap;
  /** The connection's `identityKey` (see `toPersonRef`). */
  identityKey: string;
  storedStatus?: CampaignLeadStatus | null;
}): CampaignLeadStatus {
  if (storedStatus) return storedStatus;

  const signal = getSignal(signals, identityKey);

  if (signal.inboundMessages > 0) return "CONVERSATION_ONGOING";
  if (signal.outboundMessages > 0) return "FIRST_MESSAGE_SENT";
  // Direction unknown but a thread exists — a conversation happened, we just
  // cannot say who opened it.
  if (signal.undirectedMessages > 0) return "CONVERSATION_ONGOING";
  if (isConnected) return "REQUEST_ACCEPTED";
  if (signal.hasInvitation) return "REQUEST_PENDING";
  return "REQUEST_PENDING";
}

export const LEAD_STATUS_LABEL: Record<CampaignLeadStatus, string> = {
  REQUEST_PENDING: "Connection request pending",
  REQUEST_ACCEPTED: "Connection accepted",
  FIRST_MESSAGE_SENT: "First message sent",
  CONVERSATION_ONGOING: "Conversation on-going",
};

/** Maps each status onto one of the existing `ef-badge-*` utility classes. */
export const LEAD_STATUS_BADGE_CLASS: Record<CampaignLeadStatus, string> = {
  REQUEST_PENDING: "ef-badge-neutral",
  REQUEST_ACCEPTED: "ef-badge-info",
  FIRST_MESSAGE_SENT: "ef-badge-warning",
  CONVERSATION_ONGOING: "ef-badge-success",
};
