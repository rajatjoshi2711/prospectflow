import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { processImport } from "@/inngest/functions/process-import";
import { computeMatches } from "@/inngest/functions/compute-matches";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processImport, computeMatches],
});
