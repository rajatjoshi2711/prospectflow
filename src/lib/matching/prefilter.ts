/**
 * Deterministic pre-filter for ICP / channel-partner matching.
 *
 * WHY THIS EXISTS
 * ---------------
 * A user can have 5,000 connections and an org can have 10 ICPs. Scoring every
 * pair with an LLM is 50,000 calls per user — minutes of latency and a bill
 * nobody wants, for a result that is overwhelmingly "no match". So the
 * pipeline is two-stage:
 *
 *   Stage 1 (this file, pure CPU, no network): score every connection against
 *   every definition with cheap string rules, hard-exclude on country, and
 *   keep only a bounded shortlist of plausible candidates.
 *
 *   Stage 2 (score.ts): the LLM sees only that shortlist, batched, and
 *   produces the final 0-100 score plus a one-sentence rationale.
 *
 * The pre-filter is deliberately GENEROUS — its job is to discard the obvious
 * no's, not to make the final call. Anything it lets through is re-judged by
 * the model; anything it rejects was rejected on an explicit, inspectable rule
 * (wrong country, or no overlap at all with the definition's vocabulary).
 *
 * The pre-filter score also doubles as the FALLBACK score when no LLM is
 * configured, so the feature degrades to a transparent rules-only mode rather
 * than to nothing.
 */

export type CandidateConnection = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  position: string | null;
  country: string | null;
};

/** Normalised, provider-agnostic view of an ICP or a channel partner. */
export type MatchDefinition = {
  id: string;
  kind: "ICP" | "CHANNEL_PARTNER";
  name: string;
  /** ICP only. Null means "any country". */
  country: string | null;
  industry: string | null;
  /** ICP only. Empty for channel partners. */
  positions: string[];
  /** ICP `description` or channel partner `criteria`. */
  description: string | null;
};

export type PrefilterHit = {
  connection: CandidateConnection;
  /** 0-100 heuristic score. Only used for ranking and as an LLM-less fallback. */
  score: number;
  /** Which rules fired, in plain English. Fed to the model as context. */
  reasons: string[];
};

/** Words too common to carry signal when extracted from free text. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "our", "are", "who", "any",
  "all", "you", "your", "they", "their", "have", "has", "will", "can", "should",
  "would", "must", "into", "over", "than", "then", "them", "was", "were", "been",
  "being", "but", "not", "out", "its", "it's", "his", "her", "she", "him", "how",
  "why", "what", "when", "where", "which", "such", "also", "more", "most", "some",
  "other", "about", "companies", "company", "people", "person", "roles", "role",
  "team", "teams", "work", "working", "looking", "ideal", "customer", "profile",
  "partner", "partners", "channel", "business", "businesses", "organisation",
  "organization", "organisations", "organizations",
]);

function normalize(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Splits free text into meaningful lowercase terms of 3+ characters. */
function terms(value: string | null | undefined): string[] {
  return normalize(value)
    .split(/[^a-z0-9+#]+/)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
}

/**
 * Weights. Tuned so a position hit alone clears the shortlist threshold (a
 * "VP of Sales" is worth looking at even if we know nothing else), while a
 * lone description keyword is not.
 */
const WEIGHT_POSITION_PHRASE = 45;
const WEIGHT_POSITION_TERM = 18;
const WEIGHT_INDUSTRY_PHRASE = 30;
const WEIGHT_INDUSTRY_TERM = 12;
const WEIGHT_DESCRIPTION_TERM = 8;
const WEIGHT_COUNTRY_MATCH = 15;
const MAX_DESCRIPTION_POINTS = 24;

/** Below this, a connection is not sent to the model at all. */
export const SHORTLIST_THRESHOLD = 18;

/**
 * Hard cap on candidates handed to the LLM per definition. At the default
 * batch size of 10 this is 12 model calls per definition per user.
 */
export const MAX_CANDIDATES_PER_DEFINITION = 120;

/** Pre-computed vocabulary for a definition, built once per matching run. */
export type DefinitionVocabulary = {
  definition: MatchDefinition;
  countryNormalized: string | null;
  positionPhrases: string[];
  positionTerms: Set<string>;
  industryPhrase: string | null;
  industryTerms: Set<string>;
  descriptionTerms: Set<string>;
  /** False when the definition is so empty nothing could ever match it. */
  hasSignal: boolean;
};

export function buildVocabulary(definition: MatchDefinition): DefinitionVocabulary {
  const positionPhrases = definition.positions
    .map(normalize)
    .filter((phrase) => phrase.length >= 3);
  const positionTerms = new Set(definition.positions.flatMap(terms));
  const industryPhrase = normalize(definition.industry) || null;
  const industryTerms = new Set(terms(definition.industry));
  const descriptionTerms = new Set(terms(definition.description));

  return {
    definition,
    countryNormalized: normalize(definition.country) || null,
    positionPhrases,
    positionTerms,
    industryPhrase,
    industryTerms,
    descriptionTerms,
    hasSignal:
      positionPhrases.length > 0 ||
      positionTerms.size > 0 ||
      industryTerms.size > 0 ||
      descriptionTerms.size > 0,
  };
}

/**
 * Scores one connection against one definition.
 *
 * Returns `null` when the connection is excluded outright:
 *   - the definition names a country and the connection is known to be
 *     elsewhere (an unknown country is NOT an exclusion — LinkedIn's
 *     Connections.csv often has no location at all);
 *   - the connection carries no company and no position, so there is nothing
 *     to judge;
 *   - the score falls below `SHORTLIST_THRESHOLD`.
 */
export function scoreCandidate(
  vocabulary: DefinitionVocabulary,
  connection: CandidateConnection,
): PrefilterHit | null {
  const position = normalize(connection.position);
  const company = normalize(connection.company);
  if (!position && !company) return null;
  if (!vocabulary.hasSignal) return null;

  const connectionCountry = normalize(connection.country);
  if (
    vocabulary.countryNormalized &&
    connectionCountry &&
    !connectionCountry.includes(vocabulary.countryNormalized) &&
    !vocabulary.countryNormalized.includes(connectionCountry)
  ) {
    return null;
  }

  const haystack = `${position} ${company}`;
  const haystackTerms = new Set([...terms(position), ...terms(company)]);
  const reasons: string[] = [];
  let score = 0;

  const matchedPhrase = vocabulary.positionPhrases.find((phrase) => position.includes(phrase));
  if (matchedPhrase) {
    score += WEIGHT_POSITION_PHRASE;
    reasons.push(`Title contains the target role "${matchedPhrase}"`);
  } else {
    const overlap = [...vocabulary.positionTerms].filter((term) => haystackTerms.has(term));
    if (overlap.length > 0) {
      score += Math.min(WEIGHT_POSITION_PHRASE, overlap.length * WEIGHT_POSITION_TERM);
      reasons.push(`Title overlaps the target roles on: ${overlap.slice(0, 4).join(", ")}`);
    }
  }

  if (vocabulary.industryPhrase && haystack.includes(vocabulary.industryPhrase)) {
    score += WEIGHT_INDUSTRY_PHRASE;
    reasons.push(`Title or company names the industry "${vocabulary.industryPhrase}"`);
  } else {
    const overlap = [...vocabulary.industryTerms].filter((term) => haystackTerms.has(term));
    if (overlap.length > 0) {
      score += Math.min(WEIGHT_INDUSTRY_PHRASE, overlap.length * WEIGHT_INDUSTRY_TERM);
      reasons.push(`Industry keyword match: ${overlap.slice(0, 4).join(", ")}`);
    }
  }

  const descriptionOverlap = [...vocabulary.descriptionTerms].filter((term) =>
    haystackTerms.has(term),
  );
  if (descriptionOverlap.length > 0) {
    score += Math.min(MAX_DESCRIPTION_POINTS, descriptionOverlap.length * WEIGHT_DESCRIPTION_TERM);
    reasons.push(`Matches the definition's wording on: ${descriptionOverlap.slice(0, 4).join(", ")}`);
  }

  if (vocabulary.countryNormalized && connectionCountry) {
    score += WEIGHT_COUNTRY_MATCH;
    reasons.push(`Based in ${connection.country}`);
  }

  if (score < SHORTLIST_THRESHOLD) return null;

  return {
    connection,
    score: Math.min(100, Math.round(score)),
    reasons,
  };
}

/**
 * Builds the bounded, ranked shortlist for one definition.
 *
 * Runs entirely in memory over the connection rows already fetched for the
 * batch, so the whole pre-filter costs one query per user regardless of how
 * many definitions the org has.
 */
export function shortlist(
  vocabulary: DefinitionVocabulary,
  connections: CandidateConnection[],
  limit: number = MAX_CANDIDATES_PER_DEFINITION,
): PrefilterHit[] {
  const hits: PrefilterHit[] = [];
  for (const connection of connections) {
    const hit = scoreCandidate(vocabulary, connection);
    if (hit) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
