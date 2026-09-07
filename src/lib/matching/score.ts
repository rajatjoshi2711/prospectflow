import {
  LLMCallError,
  parseJsonResponse,
  type LLMProvider,
} from "@/lib/ai/provider";
import type { MatchDefinition, PrefilterHit } from "@/lib/matching/prefilter";

/**
 * Stage 2 of matching: the LLM re-judges the pre-filter's shortlist.
 *
 * Candidates go to the model in BATCHES, not one per call — a batch of ten
 * costs one round trip and one copy of the (long) definition prompt instead of
 * ten, which is where nearly all the saving comes from. Batches are kept small
 * enough that a single malformed response only loses ten scores, and small
 * enough to stay well inside the output-token budget.
 */

const BATCH_SIZE = 10;
/** Tokens per batch response: ~10 candidates x (score + one sentence). */
const MAX_TOKENS_PER_BATCH = 900;

export type ScoredCandidate = {
  connectionId: string;
  score: number;
  rationale: string;
  /** `ai` when the model produced it, `heuristic` on fallback. */
  basis: "ai" | "heuristic";
};

const SYSTEM_PROMPT = [
  "You score how well a person in someone's LinkedIn network fits a target profile.",
  "",
  "Rules:",
  "- Judge only from the information given. Never invent an employer, seniority, or location.",
  "- score is an integer 0-100. 80+ means a strong, obvious fit; 50-79 a plausible fit worth a look; below 40 a weak fit.",
  "- rationale is ONE sentence, at most 25 words, stating the concrete reason. No hedging, no restating the score.",
  "- If the person's title or company is too vague to judge, score below 40 and say so.",
  "",
  'Reply with JSON only, in exactly this shape: {"results":[{"id":"<candidate id>","score":<int>,"rationale":"<one sentence>"}]}',
  "Include every candidate id you were given, exactly once.",
].join("\n");

function definitionPrompt(definition: MatchDefinition): string {
  const lines: string[] = [];
  lines.push(
    definition.kind === "ICP"
      ? `TARGET PROFILE (Ideal Customer Profile): ${definition.name}`
      : `TARGET PROFILE (channel partner): ${definition.name}`,
  );
  if (definition.country) lines.push(`Country: ${definition.country}`);
  if (definition.industry) lines.push(`Industry: ${definition.industry}`);
  if (definition.positions.length > 0) {
    lines.push(`Target positions: ${definition.positions.join(", ")}`);
  }
  if (definition.description) {
    lines.push(
      definition.kind === "ICP"
        ? `Description: ${definition.description}`
        : `Partner criteria: ${definition.description}`,
    );
  }
  return lines.join("\n");
}

function candidatesPrompt(batch: PrefilterHit[]): string {
  return batch
    .map((hit) => {
      const name = [hit.connection.firstName, hit.connection.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      const parts = [
        `id: ${hit.connection.id}`,
        `name: ${name || "unknown"}`,
        `title: ${hit.connection.position ?? "unknown"}`,
        `company: ${hit.connection.company ?? "unknown"}`,
      ];
      if (hit.connection.country) parts.push(`country: ${hit.connection.country}`);
      if (hit.reasons.length > 0) parts.push(`keyword signals: ${hit.reasons.join("; ")}`);
      return `- ${parts.join(" | ")}`;
    })
    .join("\n");
}

type RawResult = { id?: unknown; score?: unknown; rationale?: unknown };

function coerceResults(payload: unknown): Map<string, { score: number; rationale: string }> {
  const out = new Map<string, { score: number; rationale: string }>();
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return out;

  for (const entry of results as RawResult[]) {
    if (typeof entry?.id !== "string") continue;
    const rawScore = typeof entry.score === "number" ? entry.score : Number(entry.score);
    if (!Number.isFinite(rawScore)) continue;
    const rationale =
      typeof entry.rationale === "string" && entry.rationale.trim().length > 0
        ? entry.rationale.trim().slice(0, 400)
        : "No rationale returned.";
    out.set(entry.id, {
      score: Math.max(0, Math.min(100, Math.round(rawScore))),
      rationale,
    });
  }
  return out;
}

/** The rules-only result for one candidate, used whenever the model is unavailable. */
export function heuristicResult(hit: PrefilterHit): ScoredCandidate {
  return {
    connectionId: hit.connection.id,
    score: hit.score,
    rationale:
      hit.reasons.length > 0
        ? `Keyword match (AI scoring unavailable): ${hit.reasons.join("; ")}.`
        : "Keyword match (AI scoring unavailable).",
    basis: "heuristic",
  };
}

/**
 * Scores a whole shortlist for one definition.
 *
 * FAILURE HANDLING: a batch that errors or comes back unparseable is NOT
 * retried here — the provider already retried once, and Inngest will retry the
 * step. Instead that batch falls back to its pre-filter score so the run still
 * produces usable, clearly-labelled rows. `errors` reports how many batches
 * degraded, which the caller logs.
 */
export async function scoreShortlist({
  provider,
  definition,
  hits,
  batchSize = BATCH_SIZE,
  signal,
}: {
  provider: LLMProvider | null;
  definition: MatchDefinition;
  hits: PrefilterHit[];
  batchSize?: number;
  signal?: AbortSignal;
}): Promise<{ scored: ScoredCandidate[]; llmCalls: number; degradedBatches: number }> {
  if (hits.length === 0) return { scored: [], llmCalls: 0, degradedBatches: 0 };

  if (!provider) {
    return { scored: hits.map(heuristicResult), llmCalls: 0, degradedBatches: 0 };
  }

  const scored: ScoredCandidate[] = [];
  let llmCalls = 0;
  let degradedBatches = 0;

  for (let index = 0; index < hits.length; index += batchSize) {
    const batch = hits.slice(index, index + batchSize);
    try {
      const completion = await provider.complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `${definitionPrompt(definition)}\n\nCANDIDATES:\n${candidatesPrompt(batch)}`,
          },
        ],
        responseFormat: "json_object",
        temperature: 0.1,
        maxTokens: MAX_TOKENS_PER_BATCH,
        signal,
      });
      llmCalls += 1;

      const parsed = coerceResults(parseJsonResponse<unknown>(completion.content));
      if (parsed.size === 0) {
        degradedBatches += 1;
        scored.push(...batch.map(heuristicResult));
        continue;
      }

      for (const hit of batch) {
        const result = parsed.get(hit.connection.id);
        // A candidate the model silently dropped keeps its heuristic score
        // rather than vanishing from the dashboard.
        scored.push(
          result
            ? {
                connectionId: hit.connection.id,
                score: result.score,
                rationale: result.rationale,
                basis: "ai",
              }
            : heuristicResult(hit),
        );
      }
    } catch (error) {
      llmCalls += 1;
      degradedBatches += 1;
      if (error instanceof LLMCallError && !error.retryable) {
        // A non-retryable error (bad key, bad model slug) will fail every
        // remaining batch too — degrade the rest immediately instead of
        // burning the whole shortlist against a wall.
        scored.push(...hits.slice(index).map(heuristicResult));
        break;
      }
      scored.push(...batch.map(heuristicResult));
    }
  }

  return { scored, llmCalls, degradedBatches };
}
