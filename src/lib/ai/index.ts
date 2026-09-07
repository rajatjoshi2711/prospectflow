import { createGroqProvider } from "@/lib/ai/groq";
import { LLMConfigurationError, type LLMProvider } from "@/lib/ai/provider";

/**
 * Resolves the configured LLM provider.
 *
 * `LLM_PROVIDER` selects the implementation and defaults to `groq`. Add a new
 * case here (plus its implementation file) to swap vendors — no caller
 * anywhere else in the codebase needs to change.
 *
 * Throws `LLMConfigurationError` when the provider is unknown or its API key
 * is missing. It is deliberately a CALL-time throw: nothing is instantiated at
 * module scope, so importing this file is always safe even with no AI
 * credentials configured.
 */
export function getLLMProvider(): LLMProvider {
  const name = (process.env.LLM_PROVIDER?.trim() || "groq").toLowerCase();

  switch (name) {
    case "groq":
      return createGroqProvider();
    default:
      throw new LLMConfigurationError(
        `Unknown LLM_PROVIDER "${name}". Supported values: groq.`,
      );
  }
}

/**
 * True when an LLM call would be possible right now.
 *
 * Use this to branch to a deterministic-only path rather than letting a
 * missing key surface as an error. Cheap: it only reads env vars.
 */
export function isLLMConfigured(): boolean {
  try {
    getLLMProvider();
    return true;
  } catch {
    return false;
  }
}

/** Like `getLLMProvider()` but returns null instead of throwing. */
export function tryGetLLMProvider(): LLMProvider | null {
  try {
    return getLLMProvider();
  } catch {
    return null;
  }
}

export * from "@/lib/ai/provider";
