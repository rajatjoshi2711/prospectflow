import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { processImport } from "@/inngest/functions/process-import";
import { computeMatches } from "@/inngest/functions/compute-matches";
import {
  createCampaignLeads,
  detectCampaignColumn,
} from "@/inngest/functions/process-campaign";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processImport, computeMatches, detectCampaignColumn, createCampaignLeads],
});
