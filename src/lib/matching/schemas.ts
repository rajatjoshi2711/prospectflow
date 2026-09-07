import { z } from "zod";
import { isKnownCountry } from "@/lib/matching/countries";

/** Trims, then treats an empty string as "not set". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null);

export const icpInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  country: optionalText(80).refine(
    (value) => value === null || isKnownCountry(value),
    "Pick a country from the list.",
  ),
  industry: optionalText(120),
  /**
   * Sent as an array of strings by the form. Blank entries are dropped and
   * duplicates collapsed so the pre-filter vocabulary stays clean.
   */
  positions: z
    .array(z.string().trim().max(120))
    .max(25, "At most 25 positions.")
    .optional()
    .transform((values) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const value of values ?? []) {
        const key = value.toLowerCase();
        if (value.length === 0 || seen.has(key)) continue;
        seen.add(key);
        out.push(value);
      }
      return out;
    }),
  description: optionalText(2000),
});

export const channelPartnerInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  industry: optionalText(120),
  criteria: optionalText(2000),
});

export type IcpInput = z.output<typeof icpInputSchema>;
export type ChannelPartnerInput = z.output<typeof channelPartnerInputSchema>;

/** First readable message from a Zod failure, for the API's `error` field. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid request body.";
}
