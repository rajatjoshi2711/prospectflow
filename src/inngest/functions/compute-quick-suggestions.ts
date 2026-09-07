import { NonRetriableError } from "inngest";
import { inngest, type QuickSuggestionsRecomputeEvent } from "@/inngest/client";
import { computeQuickSuggestionsForOrg } from "@/lib/suggestions/run";

/**
 * Regenerates an organization's `QuickSuggestion` rows.
 *
 * TRIGGERS
 *   - after any member's import completes (their new snapshot changes who the
 *     org collectively knows);
 *   - nightly, from the Vercel Cron route at
 *     `src/app/api/cron/quick-suggestions/route.ts`. Suggestions span the whole
 *     org graph rather than one import, and their inputs (relationship recency,
 *     match scores, other members' imports) drift with time, so a sweep is the
 *     only way they stay current between uploads.
 *
 * COST
 *   One model call per org per run — the digest is capped at 60 candidates and
 *   the output at 8 suggestions, so this is flat in org size.
 *
 * CONCURRENCY
 *   One run per org. Two concurrent runs would each prune the other's freshly
 *   written suggestions.
 */
export const computeQuickSuggestions = inngest.createFunction(
  {
    id: "compute-quick-suggestions",
    retries: 1,
    concurrency: { key: "event.data.organizationId", limit: 1 },
    triggers: [{ event: "suggestions/recompute.requested" }],
  },
  async ({
    event,
    step,
    logger,
  }: {
    event: QuickSuggestionsRecomputeEvent;
    step: import("inngest").GetStepTools<typeof inngest>;
    logger: { info: (...args: unknown[]) => void };
  }) => {
    const { organizationId } = event.data;
    if (!organizationId) {
      throw new NonRetriableError(
        "suggestions/recompute.requested requires organizationId",
      );
    }

    const summary = await step.run("generate", async () =>
      computeQuickSuggestionsForOrg(organizationId),
    );
    logger.info("quick suggestions run", summary);
    return summary;
  },
);
