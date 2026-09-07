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
 * PHASE 5 (campaigns) wires this up: `fetchCampaignLeadPage` passes every
 * lead's stored `CampaignLead.status` as `storedStatus`, so a campaign lead
 * always shows what the user set, and derivation only ever applies to plain
 * connections. The campaign path routes through here rather than reading the
 * column directly so status semantics stay in one file.
 *
 * NOT DONE, deliberately: the connections/ICP dashboards do NOT look up whether
 * a connection also appears in some campaign. A campaign is one user's outreach
 * push against one list; letting it rewrite the status shown on the whole
 * network view would make "where does this relationship stand" depend on which
 * campaign happened to touch the person last. Phase 6 can revisit that with
 * ProspectAsk's cross-entity view if the need turns out to be real.
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
