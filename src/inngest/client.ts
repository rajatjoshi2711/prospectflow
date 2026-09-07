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

export const inngest = new Inngest({ id: "prospectflow" });
