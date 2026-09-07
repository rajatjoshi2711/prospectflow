import { z } from "zod";
import { CampaignLeadStatus } from "@prisma/client";

/** The confirmed (or overridden) LinkedIn-URL column. */
export const confirmColumnSchema = z.object({
  column: z.string().trim().min(1, "Pick a column.").max(300),
});

/**
 * Derived from the Prisma enum rather than hand-listed, so adding a status to
 * the schema can never leave this validator silently out of date.
 */
export const leadStatusSchema = z.object({
  status: z.enum(
    Object.values(CampaignLeadStatus) as [CampaignLeadStatus, ...CampaignLeadStatus[]],
  ),
});

export const campaignNameSchema = z.string().trim().min(1).max(120);

export type ConfirmColumnInput = z.output<typeof confirmColumnSchema>;
export type LeadStatusInput = z.output<typeof leadStatusSchema>;
