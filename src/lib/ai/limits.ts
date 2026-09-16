/**
 * Cost guardrails for everything that can reach a model.
 *
 * All limits are env-configurable with defaults that are generous for a real
 * person and tight enough that no single account can run up an unbounded Groq
 * bill. Nothing here reads the database or instantiates a provider, so it is
 * safe to import from anywhere (including the client-facing config that renders
 * the limits in the UI copy).
 *
 * WHAT COSTS WHAT
 * ---------------
 *   - One ProspectAsk question  -> at most `MAX_MODEL_CALLS_PER_TURN` (5) model
 *     calls: 4 tool rounds plus one forced final answer. Enforced twice in
 *     `src/lib/prospect-ask/agent.ts` — by the loop bound and by an explicit
 *     call counter — so a change to one cannot silently lift the ceiling.
 *   - One "re-score now" press  -> one Inngest run per user, itself capped at
 *     `MAX_SCORED_PER_USER` (400) people in batches of 15, so at most 27 model
 *     calls per user, plus one call for the org's quick suggestions.
 *
 * So the worst case a single user can provoke is roughly
 *   chat_per_day * 5  +  recompute_per_day * 28
 * model calls, and the org-wide daily cap bounds the sum across members.
 */

/** Reads a positive integer env var, falling back when unset or nonsense. */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  // A misconfigured value must not silently disable the guardrail, so anything
  // that is not a positive integer falls back to the default rather than to 0
  // (which would block everything) or to Infinity (which would block nothing).
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Master switch. Set `AI_RATE_LIMIT_ENABLED=false` to turn the limiter off —
 * intended for local development, never for a deployment with a real API key.
 * Any other value (including unset) leaves it ON: the guardrail defaults to
 * protecting spend.
 */
export function isRateLimitEnabled(): boolean {
  return process.env.AI_RATE_LIMIT_ENABLED?.trim().toLowerCase() !== "false";
}

export type AiAction = "prospect-ask" | "recompute" | "prospect-research";

export type ActionLimits = {
  /** Counter bucket name, also the `AiUsageCounter.bucket` value. */
  bucket: string;
  perHour: number;
  perDay: number;
  /** Used in the "you have hit the limit" copy. */
  label: string;
};

export function getActionLimits(action: AiAction): ActionLimits {
  switch (action) {
    case "recompute":
      return {
        bucket: "recompute",
        // Re-scoring is idempotent and expensive: a second run minutes after
        // the first produces the same table. A handful a day is plenty for
        // "I just changed something, refresh it".
        perHour: readPositiveInt("AI_RECOMPUTE_LIMIT_PER_HOUR", 3),
        perDay: readPositiveInt("AI_RECOMPUTE_LIMIT_PER_DAY", 10),
        label: "re-score requests",
      };
    case "prospect-research":
      return {
        bucket: "prospect-research",
        // The most expensive single request in the app: a live web search plus
        // a generation over what it retrieved, and the result is SAVED and
        // org-visible, so a colleague reads the existing run rather than paying
        // for a duplicate. Tighter than chat on purpose — researching ten
        // people in an hour is a real session; researching the same person ten
        // times is not.
        perHour: readPositiveInt("AI_RESEARCH_LIMIT_PER_HOUR", 10),
        perDay: readPositiveInt("AI_RESEARCH_LIMIT_PER_DAY", 30),
        label: "prospect research runs",
      };
    case "prospect-ask":
    default:
      return {
        bucket: "prospect-ask",
        perHour: readPositiveInt("AI_CHAT_LIMIT_PER_HOUR", 20),
        perDay: readPositiveInt("AI_CHAT_LIMIT_PER_DAY", 100),
        label: "ProspectAsk questions",
      };
  }
}

/**
 * Org-wide daily ceiling across ALL AI-invoking requests from every member.
 *
 * Cheap to add (one more counter row on the same upsert path) and it is the
 * only limit that bounds the bill rather than one person's behaviour: ten
 * members each inside their personal limit can still add up. Set generously so
 * it is a backstop, not a day-to-day constraint.
 */
export function getOrgDailyLimit(): number {
  return readPositiveInt("AI_ORG_LIMIT_PER_DAY", 600);
}
