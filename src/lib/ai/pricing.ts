import { Prisma } from "@prisma/client";

/**
 * The rate card used to estimate what a model call cost.
 *
 * THESE ARE ESTIMATES, NOT BILLED AMOUNTS. Everything this module produces must
 * be reconciled against the real Groq invoice before it is treated as spend.
 * The UI says so wherever a dollar figure appears; do not remove that caveat.
 *
 * PROVENANCE OF THE SEEDED RATES
 * ------------------------------
 * `openai/gpt-oss-120b` at $0.15 per million input tokens and $0.60 per million
 * output tokens, read in SEPTEMBER 2026 from two third-party pricing trackers —
 * cloudzero.com/blog/groq-pricing and markaicode.com/pricing/groq-pricing.
 *
 * They are third-party figures because Groq's own pricing page did not expose
 * machine-readable rates at the time, so there was nothing first-party to cite.
 * That makes them plausible but unverified: they can be stale, wrong, or not
 * the tier this account is actually on. Treat a drift between this dashboard
 * and the invoice as a problem with THIS FILE first.
 *
 * WHAT WE CANNOT SEE
 * ------------------
 * `browser_search` (Groq's server-side web search, used by prospect research)
 * may carry a SEPARATE PER-SEARCH CHARGE that does not appear anywhere in the
 * completion response — there is no field to read it from. Calls that offered a
 * built-in tool are therefore flagged `usedBuiltInTools` on `AiCallLog` and are
 * known to UNDER-report: their true cost is at least the token cost below, plus
 * an unknown search fee. The research row on the dashboard says this out loud.
 *
 * OVERRIDING WITHOUT A DEPLOY
 * ---------------------------
 * `AI_MODEL_RATES` takes a JSON object keyed by model slug:
 *
 *   AI_MODEL_RATES={"openai/gpt-oss-120b":{"input":0.15,"output":0.60}}
 *
 * Entries merge over the defaults, so it can correct one model or add a new
 * one. A malformed value is IGNORED with a console warning rather than throwing
 * — a typo in an env var must not take down every AI feature in the app.
 */

export type ModelRates = {
  /** USD per million input (prompt) tokens. */
  inputPerMillionUsd: number;
  /** USD per million output (completion) tokens. */
  outputPerMillionUsd: number;
};

/** Human-readable provenance, shown in the UI beside the rate table. */
export const RATE_CARD_SOURCE =
  "Third-party trackers (cloudzero.com, markaicode.com), September 2026. Groq published no machine-readable rates.";

const DEFAULT_RATES: Record<string, ModelRates> = {
  "openai/gpt-oss-120b": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
};

/**
 * Parsed once per process. The env var cannot change under a running lambda, so
 * re-parsing per call would buy nothing and cost a JSON.parse on the hot path.
 */
let cachedRates: Record<string, ModelRates> | null = null;

function parseOverrides(raw: string): Record<string, ModelRates> {
  const out: Record<string, ModelRates> = {};
  const parsed = JSON.parse(raw) as Record<string, { input?: unknown; output?: unknown }>;
  for (const [model, value] of Object.entries(parsed ?? {})) {
    const input = typeof value?.input === "number" ? value.input : NaN;
    const output = typeof value?.output === "number" ? value.output : NaN;
    // A negative or non-finite rate would produce nonsense money, which is
    // worse than falling back to the default. Skip the entry, keep the rest.
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    out[model] = { inputPerMillionUsd: input, outputPerMillionUsd: output };
  }
  return out;
}

export function getRateCard(): Record<string, ModelRates> {
  if (cachedRates) return cachedRates;

  const raw = process.env.AI_MODEL_RATES?.trim();
  let overrides: Record<string, ModelRates> = {};
  if (raw) {
    try {
      overrides = parseOverrides(raw);
    } catch (error) {
      console.error("AI_MODEL_RATES is not valid JSON; using built-in rates only.", error);
    }
  }

  cachedRates = { ...DEFAULT_RATES, ...overrides };
  return cachedRates;
}

/** Rates for one model, or null when it is not on the card. */
/**
 * Looks up the rate card for a model slug.
 *
 * Deliberately more forgiving than an exact map hit. The slug recorded on a
 * call is whatever the PROVIDER echoed back in the response, not the string we
 * configured, and providers routinely decorate it — different casing, or a
 * build/date suffix like `openai/gpt-oss-120b-0916`. An exact lookup would then
 * miss on every single call and the whole dashboard would read "cost unknown",
 * which looks like a pricing bug rather than a slug mismatch.
 *
 * So: exact, then case-insensitive, then the longest configured slug that the
 * reported one starts with. Longest-first matters — it stops `gpt-oss-12` from
 * shadowing `gpt-oss-120b` if both were ever listed.
 *
 * Still returns null for a genuinely unknown model. A loose match is worth
 * having; a wrong one is not, so this never falls back to "some other model's
 * price looks close enough".
 */
export function getModelRates(model: string): ModelRates | null {
  const card = getRateCard();
  const exact = card[model];
  if (exact) return exact;

  const needle = model.trim().toLowerCase();
  if (!needle) return null;

  const entries = Object.entries(card).sort(([a], [b]) => b.length - a.length);
  for (const [slug, rates] of entries) {
    const known = slug.trim().toLowerCase();
    if (needle === known || needle.startsWith(known)) return rates;
  }
  return null;
}

export type CostEstimate = {
  /** NULL means UNKNOWN — an unpriced model. Never coerce this to zero. */
  costUsd: Prisma.Decimal | null;
  inputRatePerMillionUsd: Prisma.Decimal | null;
  outputRatePerMillionUsd: Prisma.Decimal | null;
};

/**
 * Prices one call.
 *
 * An unknown model returns nulls throughout rather than a zero: the tokens are
 * still recorded, and the dashboard reports the call as "cost unknown". Costing
 * it at zero would quietly understate the bill and hide the fact that a model
 * nobody has priced is in production.
 *
 * Arithmetic is in `Decimal` end to end. Rates are sub-dollar and token counts
 * are large, so a per-row float would round in the fourth decimal and then be
 * summed a hundred thousand times.
 */
export function estimateCost({
  model,
  promptTokens,
  completionTokens,
}: {
  model: string;
  promptTokens: number;
  completionTokens: number;
}): CostEstimate {
  const rates = getModelRates(model);
  if (!rates) {
    return { costUsd: null, inputRatePerMillionUsd: null, outputRatePerMillionUsd: null };
  }

  const inputRate = new Prisma.Decimal(rates.inputPerMillionUsd);
  const outputRate = new Prisma.Decimal(rates.outputPerMillionUsd);
  const million = new Prisma.Decimal(1_000_000);

  const cost = inputRate
    .mul(promptTokens)
    .div(million)
    .add(outputRate.mul(completionTokens).div(million));

  return {
    costUsd: cost,
    inputRatePerMillionUsd: inputRate,
    outputRatePerMillionUsd: outputRate,
  };
}
