import OpenAI from "openai";
import {
  LLMCallError,
  LLMConfigurationError,
  type LLMCompleteOptions,
  type LLMCompletion,
  type LLMMessage,
  type LLMProvider,
  type LLMExecutedTool,
  type LLMToolCall,
} from "@/lib/ai/provider";
import { classifyError, recordAiCall } from "@/lib/ai/usage-log";

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

/**
 * Used when the primary model cannot serve a request because the account is
 * out of credits, over quota, or rate limited.
 *
 * `gpt-oss-20b` is the right stand-in specifically: it is half the price, it
 * supports the same `browser_search` built-in the research feature depends on,
 * and it has its own capacity — so a 120b limit does not imply a 20b one. It is
 * a weaker model, which is why it is a fallback and not the default: a cheaper
 * answer beats an error, but it does not beat the better answer.
 *
 * Set `GROQ_FALLBACK_MODEL=""` to disable the fallback and let failures surface.
 */
export const GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";

/**
 * True when the provider could not serve the request for a capacity reason.
 *
 * Deliberately narrow. A 402 or `insufficient_quota` is the credits case the
 * fallback exists for; a 429 is included because the effect on the caller is
 * identical — the primary is unavailable right now — and the fallback is
 * strictly cheaper, so covering for it costs less than failing.
 *
 * Everything else is excluded on purpose. A 400, a 401, or a content refusal
 * would fail the same way on the smaller model, so retrying would spend a
 * second call to arrive at the same error.
 */
function isCapacityError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 402 || status === 429) return true;

  const code = (error as { code?: string })?.code?.toLowerCase() ?? "";
  if (code.includes("insufficient_quota") || code.includes("rate_limit")) return true;

  // Some gateways only say it in prose, so the message is a last resort rather
  // than the primary signal.
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    message.includes("insufficient_quota") ||
    message.includes("out of credits") ||
    message.includes("exceeded your current quota")
  );
}

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
  // `?? ` not `||`: an explicitly empty GROQ_FALLBACK_MODEL means "no fallback",
  // which an `||` default would silently override.
  const fallbackModel = (process.env.GROQ_FALLBACK_MODEL ?? GROQ_FALLBACK_MODEL).trim();

  const client = new OpenAI({
    apiKey,
    baseURL: GROQ_BASE_URL,
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
  });

  /**
   * One attempt against one model.
   *
   * Parameterised by model so the credit fallback can re-run the identical
   * request on a different one. Each attempt records its OWN audit row: a
   * failed primary call still burned whatever it generated, and the dashboard
   * should show both the failure and the cheaper retry that covered for it
   * rather than a single row that hides the switch.
   */
  async function attempt(
    activeModel: string,
    options: LLMCompleteOptions,
  ): Promise<LLMCompletion> {
    // Started before the request is even built, so a slow serialization of a
    // large batch shows up in latency rather than hiding in it.
    const startedAt = Date.now();
    const usedBuiltInTools = (options.builtInTools ?? []).length > 0;
    // Function tools and Groq's server-side built-ins share one `tools` array
    // on the wire. A built-in entry is just `{ type: "<name>" }` — it carries
    // no schema, because we never execute it.
    const wireTools = [
      ...(options.tools ?? []).map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      ...(options.builtInTools ?? []).map((name) => ({ type: name })),
    ];

    // Hoisted out of the `try` so the failure path can still log whatever the
    // provider told us before things went wrong. An empty completion, for
    // instance, is an error that has already generated (and been billed for)
    // its prompt tokens.
    let observedModel = activeModel;
    let observedUsage: { promptTokens: number; completionTokens: number } | null = null;

    try {
      const response = await client.chat.completions.create(
        {
          model: activeModel,
          messages: options.messages.map(toApiMessage),
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 1024,
          ...(options.responseFormat === "json_object"
            ? { response_format: { type: "json_object" as const } }
            : {}),
          ...(wireTools.length > 0
            ? {
                // Groq accepts built-in tool entries the OpenAI SDK's own
                // union does not know about, so this one field is cast rather
                // than loosening the typing of the whole request.
                tools: wireTools as OpenAI.Chat.ChatCompletionTool[],
                tool_choice: options.toolChoice ?? ("auto" as const),
              }
            : {}),
        },
        {
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: options.signal,
        },
      );

      observedModel = response.model ?? activeModel;
      // `usage` is optional in the SDK's response type and Groq is not
      // contractually obliged to send it, so every field is read
      // defensively. `total_tokens` is not stored as reported — it is
      // recomputed from the two parts, which is the only way the column and
      // its components can never disagree.
      const rawUsage = response.usage;
      observedUsage = rawUsage
        ? {
            promptTokens: typeof rawUsage.prompt_tokens === "number" ? rawUsage.prompt_tokens : 0,
            completionTokens:
              typeof rawUsage.completion_tokens === "number" ? rawUsage.completion_tokens : 0,
          }
        : null;

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

      // Groq reports its server-side tool runs here. Not in the SDK's types,
      // and its `output` is free text, so it is read defensively and kept for
      // observability only — never parsed for facts.
      const rawExecuted = (
        response as unknown as {
          executed_tools?: { index?: number; type?: string; arguments?: string; output?: string }[];
        }
      ).executed_tools;
      const executedTools: LLMExecutedTool[] = Array.isArray(rawExecuted)
        ? rawExecuted.map((tool, position) => ({
            index: typeof tool.index === "number" ? tool.index : position,
            type: typeof tool.type === "string" ? tool.type : "unknown",
            arguments: typeof tool.arguments === "string" ? tool.arguments : undefined,
            output: typeof tool.output === "string" ? tool.output : undefined,
          }))
        : [];

      // Awaited, not fire-and-forget: on Vercel a floating promise can be
      // cut off when the lambda freezes after the response is returned, which
      // would drop rows non-deterministically. `recordAiCall` never throws
      // and never retries, so the wait is one short insert.
      await recordAiCall({
        organizationId: options.context.organizationId,
        userId: options.context.userId,
        useCase: options.context.useCase,
        provider: "groq",
        model: observedModel,
        status: "OK",
        promptTokens: observedUsage?.promptTokens ?? 0,
        completionTokens: observedUsage?.completionTokens ?? 0,
        usageReported: observedUsage !== null,
        usedBuiltInTools,
        latencyMs: Date.now() - startedAt,
      });

      return {
        content,
        toolCalls,
        executedTools,
        model: observedModel,
        usage: observedUsage ?? undefined,
      };
    } catch (error) {
      const callError = error instanceof LLMCallError ? error : toCallError(error);

      // A 4xx means WE sent something the provider rejected — a bad parameter,
      // a malformed tool schema, a broken tool-call sequence. The provider's
      // own message names the offending field; ours ("http_400") only names
      // the class. Without this line a 400 is undiagnosable from the outside,
      // which is exactly the position a live 400 left us in.
      //
      // Runtime logs, NOT the audit table: the message can echo a fragment of
      // the request, so it belongs in an ephemeral operator-only stream rather
      // than a durable row. Truncated for the same reason. 5xx and timeouts
      // are the provider's problem and already legible from `errorKind`, so
      // they are left out to keep this signal rare and meaningful.
      const status = callError.status;
      if (status !== undefined && status >= 400 && status < 500) {
        console.error(
          `[groq] ${status} rejected a ${options.context.useCase} call on ${activeModel}: ` +
            `${callError.message.slice(0, 500)}`,
        );
      }
      // A failed call still costs whatever the provider generated before it
      // gave up, and an ERROR row is the debugging record. Logged before the
      // rethrow so no failure path can skip it.
      await recordAiCall({
        organizationId: options.context.organizationId,
        userId: options.context.userId,
        useCase: options.context.useCase,
        provider: "groq",
        model: observedModel,
        status: "ERROR",
        errorKind: classifyError(callError),
        promptTokens: observedUsage?.promptTokens ?? 0,
        completionTokens: observedUsage?.completionTokens ?? 0,
        usageReported: observedUsage !== null,
        usedBuiltInTools,
        latencyMs: Date.now() - startedAt,
      });
      throw callError;
    }
  }

  return {
    id: "groq",
    model,

    async complete(options: LLMCompleteOptions): Promise<LLMCompletion> {
      try {
        return await attempt(model, options);
      } catch (error) {
        // Fall back to the smaller model only when the primary could not
        // serve the request at all — out of credits, over quota, or rate
        // limited. Anything else (a malformed request, a bad key, a content
        // refusal) would fail identically on the fallback, so retrying would
        // just spend twice to reach the same error.
        if (!fallbackModel || fallbackModel === model || !isCapacityError(error)) {
          throw error;
        }
        return await attempt(fallbackModel, options);
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
