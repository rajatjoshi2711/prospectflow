import { tryGetLLMProvider, parseJsonResponse } from "@/lib/ai";
import type { SpreadsheetRow } from "@/lib/campaigns/parse-spreadsheet";
import type { ColumnDetection } from "@/lib/campaigns/detection-types";

export type { ColumnDetection } from "@/lib/campaigns/detection-types";
export { DETECTION_METHOD_LABEL } from "@/lib/campaigns/detection-types";

/**
 * Works out which spreadsheet column holds LinkedIn profile URLs.
 *
 * ORDER OF ATTEMPTS (cheap first — the LLM is the exception, not the rule)
 * -----------------------------------------------------------------------
 * 1. HEURISTIC. For every column, the fraction of NON-EMPTY sampled cells that
 *    look like a `linkedin.com/in/` URL. Any column at or above
 *    `CONFIDENT_THRESHOLD` (0.6) wins outright and NO model is called. On a
 *    normal lead list this is every case, including one where the header is
 *    named something unhelpful — the heuristic reads the data, not the header.
 * 2. LLM FALLBACK, only when no column clears the threshold. Header row plus
 *    the sampled rows go to the configured provider in JSON mode, asking for
 *    `{ "columnName": string|null, "confidence": number }`. Its answer is
 *    validated against the real header list before it is trusted.
 * 3. WEAK HEURISTIC. If the model is unavailable (no `GROQ_API_KEY`) or fails
 *    or answers with a column that does not exist, fall back to the best
 *    non-zero column, reported honestly as `heuristic-weak`.
 * 4. NONE. Nothing looked like a profile URL anywhere. The user picks a column
 *    by hand.
 *
 * In every case the result is a PROPOSAL. `Campaign.linkedinColumn` is only
 * written once a human confirms it in the UI, because this single choice drives
 * all downstream connection matching.
 */

export const CONFIDENT_THRESHOLD = 0.6;

/**
 * Matches a LinkedIn member profile anywhere in the cell, so a full URL, a
 * bare `linkedin.com/in/jane-doe`, and a URL with tracking params all count.
 * `/in/` is required: `linkedin.com/company/...` is not a person.
 */
const LINKEDIN_PROFILE_PATTERN = /(?:^|[^\w.])(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s,;|]+/i;

export function looksLikeLinkedinProfile(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return LINKEDIN_PROFILE_PATTERN.test(` ${trimmed}`);
}

/** Per-column match fractions over the sample, highest first. */
export function scoreColumns(
  headers: string[],
  rows: SpreadsheetRow[],
): { column: string; fraction: number; matches: number; populated: number }[] {
  return headers
    .map((column) => {
      let populated = 0;
      let matches = 0;
      for (const row of rows) {
        const value = (row[column] ?? "").trim();
        if (!value) continue;
        populated += 1;
        if (looksLikeLinkedinProfile(value)) matches += 1;
      }
      // A column the header itself names as a LinkedIn/profile URL counts as
      // one extra "match" worth of evidence — enough to break a tie on a
      // sparse sample, never enough to carry a column whose data disagrees.
      const headerBonus = /linked\s*in|profile\s*url/i.test(column) && matches > 0 ? 1 : 0;
      return {
        column,
        populated,
        matches,
        fraction: populated === 0 ? 0 : Math.min(1, (matches + headerBonus) / populated),
      };
    })
    .sort((a, b) => b.fraction - a.fraction || b.matches - a.matches);
}

/** Step 1 only. Returns null when no column clears the threshold. */
export function detectByHeuristic(
  headers: string[],
  rows: SpreadsheetRow[],
): ColumnDetection | null {
  const best = scoreColumns(headers, rows)[0];
  if (!best || best.matches === 0 || best.fraction < CONFIDENT_THRESHOLD) return null;
  return { column: best.column, confidence: best.fraction, method: "heuristic" };
}

function buildPrompt(headers: string[], rows: SpreadsheetRow[]) {
  // Send the sample as compact JSON records rather than a pasted CSV: the model
  // then never has to guess where one column ends and the next begins.
  const sample = rows.slice(0, 12).map((row) => {
    const trimmed: Record<string, string> = {};
    for (const header of headers) {
      const value = (row[header] ?? "").trim();
      trimmed[header] = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    }
    return trimmed;
  });

  return [
    {
      role: "system" as const,
      content:
        "You identify which column of a spreadsheet holds LinkedIn personal profile URLs " +
        "(links of the form linkedin.com/in/<slug>). Company pages (linkedin.com/company/...) " +
        "do not count. Reply with a single JSON object and nothing else, shaped exactly as " +
        '{"columnName": string | null, "confidence": number}. `columnName` MUST be copied ' +
        "verbatim from the provided column list, or be null if no column holds profile URLs. " +
        "`confidence` is between 0 and 1. Do not invent a column name.",
    },
    {
      role: "user" as const,
      content: `Columns: ${JSON.stringify(headers)}\n\nSample rows:\n${JSON.stringify(sample, null, 1)}`,
    },
  ];
}

/**
 * Full detection: heuristic, then LLM only if needed, then weak heuristic.
 *
 * Never throws. Every failure path degrades to a lower-confidence proposal, in
 * keeping with the rest of the codebase: AI being unavailable must not break a
 * feature that has a working deterministic path.
 */
export async function detectLinkedinColumn(
  headers: string[],
  rows: SpreadsheetRow[],
): Promise<ColumnDetection> {
  const confident = detectByHeuristic(headers, rows);
  if (confident) return confident;

  const ranked = scoreColumns(headers, rows);
  const weak = ranked.find((entry) => entry.matches > 0);
  const weakResult: ColumnDetection = weak
    ? { column: weak.column, confidence: weak.fraction, method: "heuristic-weak" }
    : { column: null, confidence: 0, method: "none" };

  const provider = tryGetLLMProvider();
  if (!provider || rows.length === 0) return weakResult;

  try {
    const completion = await provider.complete({
      messages: buildPrompt(headers, rows),
      responseFormat: "json_object",
      temperature: 0,
      maxTokens: 200,
      timeoutMs: 20_000,
    });

    const parsed = parseJsonResponse<{ columnName?: unknown; confidence?: unknown }>(
      completion.content,
    );
    const name = typeof parsed?.columnName === "string" ? parsed.columnName.trim() : null;
    // Only accept a header that actually exists — a hallucinated column would
    // otherwise silently produce a campaign with zero usable URLs.
    const match = name ? headers.find((header) => header === name) : undefined;
    if (!match) return weakResult;

    const rawConfidence = typeof parsed?.confidence === "number" ? parsed.confidence : 0.5;
    return {
      column: match,
      confidence: Math.max(0, Math.min(1, rawConfidence)),
      method: "llm",
    };
  } catch {
    // Timeout, rate limit, malformed reply — the deterministic proposal stands.
    return weakResult;
  }
}
