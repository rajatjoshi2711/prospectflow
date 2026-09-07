import { LLMCallError, parseJsonResponse, type LLMProvider } from "@/lib/ai/provider";
import {
  heuristicScore,
  type RelationshipFeatures,
} from "@/lib/relationship/features";

/**
 * Stage 2 of relationship-strength scoring: the model judges the extracted
 * features.
 *
 * Same shape as ICP match scoring (`src/lib/matching/score.ts`), for the same
 * reasons: candidates go in BATCHES so one copy of the (long) rubric covers
 * many people, batches stay small enough that a malformed response loses only a
 * handful of scores, and a failed batch degrades to the deterministic score
 * rather than throwing away the run.
 *
 * WHAT THE MODEL SEES: only the numbers in `RelationshipFeatures`, plus the
 * person's name/company/title for readability. No message bodies. A message
 * body is user-supplied content that could contain instructions; keeping it out
 * of the prompt entirely is cheaper and safer than trying to sanitise it.
 */

const BATCH_SIZE = 15;
/** ~15 people x (score + one short sentence). */
const MAX_TOKENS_PER_BATCH = 1_200;

export type RelationshipCandidate = {
  connectionId: string;
  name: string;
  company: string | null;
  position: string | null;
  features: RelationshipFeatures;
};

export type RelationshipScoreResult = {
  connectionId: string;
  score: number;
  rationale: string;
  reasons: string[];
  basis: "ai" | "heuristic";
};

const SYSTEM_PROMPT = [
  "You rate how strong a professional relationship is, from the interaction statistics of a LinkedIn network export.",
  "",
  "You are given only counts and dates — never message text. Judge from those alone.",
  "",
  "Rubric (score is an integer 0-100):",
  "- 80-100: a real working relationship. Sustained two-way conversation, recent contact, or a live call/meeting was arranged.",
  "- 55-79: a genuine but lighter relationship. Some two-way exchange, or a solid exchange that has gone quiet.",
  "- 30-54: minimal contact. One-sided messages, or an old exchange with no reply.",
  "- 0-29: barely a relationship beyond being connected.",
  "",
  "Weighting guidance:",
  "- twoWay and callScheduled matter far more than raw message volume.",
  "- Recency matters: daysSinceLastMessage under 90 is strong, over 730 is weak.",
  "- replyRatio null means direction is unknown, NOT that they never replied. Do not penalise it as if it were zero.",
  "- Long connectionTenureDays with no messages is a weak relationship, not a strong one.",
  "",
  "rationale: ONE sentence, at most 22 words, naming the concrete evidence. Never restate the number. Never invent an event that is not in the statistics.",
  "",
  'Reply with JSON only, in exactly this shape: {"results":[{"id":"<candidate id>","score":<int>,"rationale":"<one sentence>"}]}',
  "Include every candidate id you were given, exactly once.",
].join("\n");

function featureLine(candidate: RelationshipCandidate): string {
  const f = candidate.features;
  const parts = [
    `id: ${candidate.connectionId}`,
    `name: ${candidate.name || "unknown"}`,
    `title: ${candidate.position ?? "unknown"}`,
    `company: ${candidate.company ?? "unknown"}`,
    `messagesFromThem: ${f.inboundMessages}`,
    `messagesFromUser: ${f.outboundMessages}`,
    `messagesDirectionUnknown: ${f.undirectedMessages}`,
    `threads: ${f.threadCount}`,
    `replyRatio: ${f.replyRatio === null ? "unknown" : f.replyRatio}`,
    `twoWay: ${f.twoWay}`,
    `daysSinceLastMessage: ${f.daysSinceLastMessage ?? "unknown"}`,
    `daysSinceFirstMessage: ${f.daysSinceFirstMessage ?? "unknown"}`,
    `connectionTenureDays: ${f.connectionTenureDays ?? "unknown"}`,
    `invitationNote: ${f.hasInvitationNote}`,
    `callScheduled: ${f.callScheduled}${f.callSignal ? ` (${f.callSignal})` : ""}`,
  ];
  return `- ${parts.join(" | ")}`;
}

export function heuristicResult(candidate: RelationshipCandidate): RelationshipScoreResult {
  const { score, reasons } = heuristicScore(candidate.features);
  return {
    connectionId: candidate.connectionId,
    score,
    rationale: `Rule-based score (AI scoring unavailable): ${reasons.join("; ")}.`,
    reasons,
    basis: "heuristic",
  };
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
    out.set(entry.id, {
      score: Math.max(0, Math.min(100, Math.round(rawScore))),
      rationale:
        typeof entry.rationale === "string" && entry.rationale.trim().length > 0
          ? entry.rationale.trim().slice(0, 400)
          : "No rationale returned.",
    });
  }
  return out;
}

export async function scoreRelationships({
  provider,
  candidates,
  batchSize = BATCH_SIZE,
  signal,
}: {
  provider: LLMProvider | null;
  candidates: RelationshipCandidate[];
  batchSize?: number;
  signal?: AbortSignal;
}): Promise<{
  scored: RelationshipScoreResult[];
  llmCalls: number;
  degradedBatches: number;
}> {
  if (candidates.length === 0) return { scored: [], llmCalls: 0, degradedBatches: 0 };
  if (!provider) {
    return { scored: candidates.map(heuristicResult), llmCalls: 0, degradedBatches: 0 };
  }

  const scored: RelationshipScoreResult[] = [];
  let llmCalls = 0;
  let degradedBatches = 0;

  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    try {
      const completion = await provider.complete({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `PEOPLE:\n${batch.map(featureLine).join("\n")}` },
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

      for (const candidate of batch) {
        const result = parsed.get(candidate.connectionId);
        if (!result) {
          // Silently dropped by the model — keep the deterministic score rather
          // than leaving the person unscored.
          scored.push(heuristicResult(candidate));
          continue;
        }
        scored.push({
          connectionId: candidate.connectionId,
          score: result.score,
          rationale: result.rationale,
          reasons: heuristicScore(candidate.features).reasons,
          basis: "ai",
        });
      }
    } catch (error) {
      llmCalls += 1;
      degradedBatches += 1;
      if (error instanceof LLMCallError && !error.retryable) {
        // A bad key or model slug fails every remaining batch identically —
        // degrade the rest at once instead of burning the whole run against it.
        scored.push(...candidates.slice(index).map(heuristicResult));
        break;
      }
      scored.push(...batch.map(heuristicResult));
    }
  }

  return { scored, llmCalls, degradedBatches };
}
