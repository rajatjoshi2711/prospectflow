import OpenAI from "openai";
import {
  LLMCallError,
  LLMConfigurationError,
  type LLMCompleteOptions,
  type LLMCompletion,
  type LLMMessage,
  type LLMProvider,
  type LLMToolCall,
} from "@/lib/ai/provider";

/**
 * Groq implementation of `LLMProvider`.
 *
 * Groq exposes an OpenAI-compatible API, so we reuse the `openai` SDK pointed
 * at `https://api.groq.com/openai/v1`. The default model is Groq's hosted
 * GPT-OSS-120B, whose slug is `openai/gpt-oss-120b` (the `openai/` prefix is
 * part of the Groq model id — it is not a vendor switch).
 *
 * RETRY / BACKOFF POLICY
 * ----------------------
 * This code runs inside Inngest functions, which themselves retry a failing
 * step. Two independent retry layers multiply, so the SDK's own retries are
 * kept deliberately small:
 *
 *   - SDK: `maxRetries: 1` (so at most 2 attempts) with the SDK's built-in
 *     exponential backoff + jitter, honouring `Retry-After` on 429s.
 *   - Inngest: `retries: 1` on the matching function.
 *   - Callers: a single batch that still fails is SKIPPED, not retried, and
 *     the job continues with the remaining batches. A partial result is worth
 *     far more than a failed run, and the next recompute picks up the gap.
 *
 * Worst case is therefore 2 (SDK) x 2 (Inngest) = 4 attempts per call, not the
 * 9+ you get from stacking default policies.
 *
 * The client is constructed lazily, per call site, inside `createGroqProvider`
 * — never at module scope. A missing `GROQ_API_KEY` must surface as a handled
 * `LLMConfigurationError` at the moment AI is actually needed, not as a
 * module-initialisation crash that takes down every route importing this file.
 */

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";

/** Wall-clock budget for a single completion, including SDK retries. */
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RETRIES = 1;

export function createGroqProvider(): LLMProvider {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new LLMConfigurationError(
      "GROQ_API_KEY is not set. Add it to your environment (see .env.example) to enable AI features.",
    );
  }

  const model = process.env.GROQ_MODEL?.trim() || GROQ_DEFAULT_MODEL;

  const client = new OpenAI({
    apiKey,
    baseURL: GROQ_BASE_URL,
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
  });

  return {
    id: "groq",
    model,

    async complete(options: LLMCompleteOptions): Promise<LLMCompletion> {
      try {
        const response = await client.chat.completions.create(
          {
            model,
            messages: options.messages.map(toApiMessage),
            temperature: options.temperature ?? 0.2,
            max_tokens: options.maxTokens ?? 1024,
            ...(options.responseFormat === "json_object"
              ? { response_format: { type: "json_object" as const } }
              : {}),
            ...(options.tools && options.tools.length > 0
              ? {
                  tools: options.tools.map((tool) => ({
                    type: "function" as const,
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    },
                  })),
                  tool_choice: options.toolChoice ?? ("auto" as const),
                }
              : {}),
          },
          {
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            signal: options.signal,
          },
        );

        const choice = response.choices?.[0]?.message;
        const content = choice?.content ?? "";
        // The SDK's union covers custom (non-function) tool calls too; we only
        // ever send function tools, so anything without a function name is
        // ignored rather than trusted.
        const rawToolCalls = (choice?.tool_calls ?? []) as {
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
        const toolCalls: LLMToolCall[] = rawToolCalls
          .filter((call) => typeof call.function?.name === "string")
          .map((call) => ({
            id: call.id ?? "",
            name: call.function!.name as string,
            arguments: call.function!.arguments ?? "{}",
          }));

        // A tool-calling turn legitimately returns no prose, so "empty" only
        // counts as a failure when the model asked for nothing either.
        if (!content && toolCalls.length === 0) {
          throw new LLMCallError("Groq returned an empty completion.", { retryable: true });
        }

        return {
          content,
          toolCalls,
          model: response.model ?? model,
          usage: response.usage
            ? {
                promptTokens: response.usage.prompt_tokens ?? 0,
                completionTokens: response.usage.completion_tokens ?? 0,
              }
            : undefined,
        };
      } catch (error) {
        if (error instanceof LLMCallError) throw error;
        throw toCallError(error);
      }
    },
  };
}

/** Normalises SDK/network errors, marking which are worth another attempt. */
function toCallError(error: unknown): LLMCallError {
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    // 408/409/429 and 5xx are transient; 400/401/403/404/422 are not.
    const retryable =
      status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
    return new LLMCallError(`Groq request failed (${status ?? "no status"}): ${error.message}`, {
      status,
      retryable,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new LLMCallError("Groq request was aborted or timed out.", { retryable: true });
  }
  return new LLMCallError(
    error instanceof Error ? error.message : "Unknown error calling Groq.",
    { retryable: true },
  );
}

/**
 * Maps our provider-agnostic message onto the OpenAI wire shape.
 *
 * A `tool` message must carry the `tool_call_id` it answers, and an assistant
 * message that requested tools must carry those requests back verbatim —
 * otherwise the API rejects the whole conversation on the next turn.
 */
function toApiMessage(message: LLMMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? "",
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content } as OpenAI.Chat.ChatCompletionMessageParam;
}
