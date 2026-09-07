import {
  inngest,
  type CampaignFileUploadedEvent,
  type CampaignLeadsRequestedEvent,
} from "@/inngest/client";
import { buildCampaignLeads, detectCampaignColumns } from "@/lib/campaigns/build";

/**
 * Campaign ingestion (Phase 5), split across two runs because the flow
 * deliberately waits for a human in the middle.
 *
 * WHY BACKGROUND AT ALL
 * ---------------------
 * Same reason the LinkedIn import is: the file is already in Blob storage
 * (uploaded straight from the browser, so no request-body limit), and parsing a
 * 20k-row workbook plus writing 20k lead rows does not belong in a serverless
 * request. Both functions download the blob server-side via the SDK, since the
 * store is private.
 *
 * BOTH FUNCTIONS ARE IDEMPOTENT
 * -----------------------------
 * Detection refuses to run on a campaign that has moved past AWAITING_
 * CONFIRMATION, so it can never overwrite a column the user has confirmed.
 * Lead building deletes the campaign's existing leads before inserting, so a
 * retry (or a re-confirmation with a different column) rebuilds rather than
 * doubling. Both are therefore safe to replay.
 */

/** Serialised per campaign — two runs would fight over the same lead rows. */
const CAMPAIGN_CONCURRENCY = { key: "event.data.campaignId", limit: 1 } as const;

export const detectCampaignColumn = inngest.createFunction(
  {
    id: "detect-campaign-column",
    retries: 2,
    concurrency: CAMPAIGN_CONCURRENCY,
    triggers: [{ event: "campaign/file.uploaded" }],
  },
  async ({
    event,
    step,
  }: {
    event: CampaignFileUploadedEvent;
    step: import("inngest").GetStepTools<typeof inngest>;
  }) =>
    step.run("detect-linkedin-column", async () =>
      detectCampaignColumns(event.data.campaignId),
    ),
);

export const createCampaignLeads = inngest.createFunction(
  {
    id: "create-campaign-leads",
    retries: 2,
    concurrency: CAMPAIGN_CONCURRENCY,
    triggers: [{ event: "campaign/leads.requested" }],
  },
  async ({
    event,
    step,
  }: {
    event: CampaignLeadsRequestedEvent;
    step: import("inngest").GetStepTools<typeof inngest>;
  }) => step.run("build-leads", async () => buildCampaignLeads(event.data.campaignId)),
);
