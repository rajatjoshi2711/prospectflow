import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { processImport } from "@/inngest/functions/process-import";
import { computeMatches } from "@/inngest/functions/compute-matches";
import { computeRelationshipScores } from "@/inngest/functions/compute-relationship-scores";
import { computeQuickSuggestions } from "@/inngest/functions/compute-quick-suggestions";
import {
  createCampaignLeads,
  detectCampaignColumn,
} from "@/inngest/functions/process-campaign";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    processImport,
    computeMatches,
    computeRelationshipScores,
    computeQuickSuggestions,
    detectCampaignColumn,
    createCampaignLeads,
  ],
});
