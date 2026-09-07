/**
 * Provider-agnostic LLM interface.
 *
 * Everything in ProspectFlow that talks to a model goes through this
 * interface, never through a vendor SDK directly. Swapping Groq for another
 * OpenAI-compatible endpoint (or a completely different vendor) is a change to
 * `src/lib/ai/index.ts` plus one new implementation file — no caller changes.
 */

export type LLMRole = "system" | "user" | "assistant";

export type LLMMessage = {
  role: LLMRole;
  content: string;
};

export type LLMCompleteOptions = {
  messages: LLMMessage[];
  /**
   * `json_object` asks the model to emit a single valid JSON object. Groq
   * supports OpenAI's `response_format`, so this maps straight through.
   * Always describe the exact shape you want in the system prompt as well —
   * JSON mode guarantees valid JSON, not the schema you had in mind.
   */
  responseFormat?: "text" | "json_object";
  temperature?: number;
  maxTokens?: number;
  /** Hard wall-clock budget for the call, including internal retries. */
  timeoutMs?: number;
  /** Abort signal, so a caller (or Inngest step) can cancel in flight. */
  signal?: AbortSignal;
};

export type LLMCompletion = {
  content: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
};

export interface LLMProvider {
  /** Stable identifier, e.g. `"groq"`. */
  readonly id: string;
  /** Model slug this provider instance is pinned to. */
  readonly model: string;
  complete(options: LLMCompleteOptions): Promise<LLMCompletion>;
}

/**
 * Thrown when the provider cannot be used at all — missing API key, unknown
 * provider name. Distinct from a transient call failure so callers can degrade
 * gracefully (skip AI scoring, keep the deterministic path) instead of failing
 * the whole job.
 *
 * IMPORTANT: this is thrown from `getLLMProvider()` at CALL time, never at
 * module load. A missing `GROQ_API_KEY` must never break an unrelated route
 * just because it imported a module that transitively imports this one.
 */
export class LLMConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMConfigurationError";
  }
}

/** Thrown when a call was attempted but failed (timeout, 5xx, rate limit). */
export class LLMCallError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable: boolean }) {
    super(message);
    this.name = "LLMCallError";
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

/**
 * Parses a JSON-mode response defensively.
 *
 * Even in JSON mode a model can wrap output in a ```json fence or prepend a
 * sentence, so we strip fences and fall back to the outermost {...} span
 * before giving up. Returns `null` rather than throwing: a malformed batch of
 * scores should be skipped, not crash a job that has already done real work.
 */
export function parseJsonResponse<T>(content: string): T | null {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const attempt = (text: string): T | null => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  };

  const direct = attempt(cleaned);
  if (direct !== null) return direct;

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return attempt(cleaned.slice(start, end + 1));
  }
  return null;
}
