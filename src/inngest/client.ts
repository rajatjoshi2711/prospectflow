import { Inngest } from "inngest";

/** Event sent right after an ImportBatch row is created (blob upload
 * completed), to kick off background processing in process-import.ts. */
export type ImportBatchCreatedEvent = {
  name: "import/batch.created";
  data: {
    importBatchId: string;
  };
};

/**
 * Asks for `ProspectMatch` rows to be recomputed (Phase 4).
 *
 * - `userId` omitted  -> every user in the org (used when an admin changes a
 *   definition, since that affects everyone's connections).
 * - `userId` set      -> just that user (used after their import completes).
 * - `icpIds` / `channelPartnerIds` narrow the run to specific definitions.
 *   Omit BOTH to re-score against every definition the org has.
 */
export type MatchesRecomputeEvent = {
  name: "matches/recompute.requested";
  data: {
    organizationId: string;
    userId?: string;
    icpIds?: string[];
    channelPartnerIds?: string[];
    /** Free-text provenance for the Inngest run log. */
    reason?: string;
  };
};

/**
 * A campaign lead list finished uploading to Blob (Phase 5). Kicks off column
 * detection, which parks the campaign in `AWAITING_CONFIRMATION`.
 */
export type CampaignFileUploadedEvent = {
  name: "campaign/file.uploaded";
  data: {
    campaignId: string;
  };
};

/**
 * The user confirmed (or overrode) the LinkedIn-URL column. Kicks off the full
 * parse, lead creation and connection linking.
 */
export type CampaignLeadsRequestedEvent = {
  name: "campaign/leads.requested";
  data: {
    campaignId: string;
  };
};

/**
 * Asks for `RelationshipStrengthScore` rows to be recomputed (Phase 6).
 *
 * - `userId` set     -> just that user (sent after their import completes).
 * - `userId` omitted -> every member of the org (used by the nightly sweep).
 */
export type RelationshipRecomputeEvent = {
  name: "relationship/recompute.requested";
  data: {
    organizationId: string;
    userId?: string;
    /** Free-text provenance for the Inngest run log. */
    reason?: string;
  };
};

/**
 * Asks for the org's `QuickSuggestion` rows to be regenerated (Phase 6).
 *
 * Always org-wide: a suggestion is "who in this org should approach whom", so
 * it spans every member's graph and cannot be computed for one user in
 * isolation. Sent after any member's import completes, and nightly by cron.
 */
export type QuickSuggestionsRecomputeEvent = {
  name: "suggestions/recompute.requested";
  data: {
    organizationId: string;
    reason?: string;
  };
};

export const inngest = new Inngest({ id: "prospectflow" });
