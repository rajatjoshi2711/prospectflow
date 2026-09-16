import type { AiCallStatus, AiUseCase } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { estimateCost } from "@/lib/ai/pricing";
import { LLMCallError } from "@/lib/ai/provider";

/**
 * Writes one `AiCallLog` row per model call.
 *
 * Called only from the provider (`src/lib/ai/groq.ts`), which is the single
 * choke point every AI feature goes through. Putting it there rather than at
 * the seven call sites means a new feature is instrumented the moment it is
 * written, with nothing to remember.
 *
 * NEVER FAILS THE CALL IT IS LOGGING. Accounting is strictly less important
 * than the work: an answer the user paid for must not be thrown away because a
 * bookkeeping insert timed out. Every error is swallowed and logged. The
 * consequence — a cost row can be missing — is accepted and is why the UI
 * frames these totals as estimates to reconcile against the invoice.
 *
 * NO PROMPT OR RESPONSE CONTENT IS PASSED IN OR STORED. See `AiCallLog`.
 */

export type RecordAiCallInput = {
  organizationId: string;
  userId: string | null;
  useCase: AiUseCase;
  provider: string;
  model: string;
  status: AiCallStatus;
  errorKind?: string | null;
  promptTokens: number;
  completionTokens: number;
  /** False when the provider returned no `usage` block at all. */
  usageReported: boolean;
  usedBuiltInTools: boolean;
  latencyMs: number;
};

/**
 * Coarse, content-free failure class.
 *
 * Deliberately NOT the provider's message: those quote request detail back at
 * you, which is exactly the prompt content this table must never hold. A
 * bucketed kind is also what you actually group by when asking "are we being
 * rate limited?".
 */
export function classifyError(error: unknown): string {
  if (error instanceof LLMCallError) {
    if (error.status !== undefined) return `http_${error.status}`;
    if (/abort|timed out/i.test(error.message)) return "timeout";
    if (/empty completion/i.test(error.message)) return "empty_completion";
    return "call_failed";
  }
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "unknown";
}

export async function recordAiCall(input: RecordAiCallInput): Promise<void> {
  try {
    // A failed call reports no usage, so it is priced at nothing rather than
    // being costed off zero tokens — `usageReported: false` keeps "we don't
    // know" distinguishable from "it was free".
    const { costUsd, inputRatePerMillionUsd, outputRatePerMillionUsd } = input.usageReported
      ? estimateCost({
          model: input.model,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
        })
      : { costUsd: null, inputRatePerMillionUsd: null, outputRatePerMillionUsd: null };

    await prisma.aiCallLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        useCase: input.useCase,
        provider: input.provider,
        model: input.model,
        status: input.status,
        errorKind: input.errorKind ?? null,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: input.promptTokens + input.completionTokens,
        usageReported: input.usageReported,
        usedBuiltInTools: input.usedBuiltInTools,
        inputRatePerMillionUsd,
        outputRatePerMillionUsd,
        costUsd,
        latencyMs: input.latencyMs,
      },
    });
  } catch (error) {
    // Swallowed on purpose. See the header.
    console.error("Failed to write AiCallLog row; the AI call itself was unaffected.", error);
  }
}
