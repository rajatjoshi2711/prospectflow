import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { processImport } from "@/inngest/functions/process-import";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processImport],
});
