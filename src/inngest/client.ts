import { Inngest } from "inngest";

/** Event sent right after an ImportBatch row is created (blob upload
 * completed), to kick off background processing in process-import.ts. */
export type ImportBatchCreatedEvent = {
  name: "import/batch.created";
  data: {
    importBatchId: string;
  };
};

export const inngest = new Inngest({ id: "prospectflow" });
