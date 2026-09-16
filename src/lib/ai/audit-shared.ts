import type { AiCallStatus, AiUseCase } from "@prisma/client";

/**
 * The parts of the AI audit model that BOTH the server and the browser need.
 *
 * Kept in its own module because `src/lib/ai/audit.ts` is `server-only` (it
 * touches Prisma) and `src/lib/ai/pricing.ts` pulls in `Prisma.Decimal` for its
 * arithmetic — importing either from the transaction table, which is a client
 * component, would drag the database client into the browser bundle. Only
 * labels, row shapes and formatting live here; nothing that reads data.
 */

export type AiCallSortKey = "createdAt" | "totalTokens" | "costUsd" | "latencyMs";

export type AiCallRow = {
  id: string;
  createdAt: string;
  model: string;
  useCase: AiUseCase;
  userName: string;
  status: AiCallStatus;
  errorKind: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Null = cost unknown (unpriced model, or a failure with no usage). */
  costUsd: number | null;
  usageReported: boolean;
  usedBuiltInTools: boolean;
  latencyMs: number;
};

export type AiAuditFilters = {
  useCase: AiUseCase | null;
  model: string | null;
  userId: string | null;
  status: AiCallStatus | null;
};

export const USE_CASES: AiUseCase[] = [
  "ICP_MATCHING",
  "CHANNEL_PARTNER_MATCHING",
  "RELATIONSHIP_SCORING",
  "QUICK_SUGGESTIONS",
  "PROSPECT_ASK",
  "CAMPAIGN_COLUMN_DETECTION",
  "PROSPECT_RESEARCH",
];

export const USE_CASE_LABELS: Record<AiUseCase, string> = {
  ICP_MATCHING: "ICP matching",
  CHANNEL_PARTNER_MATCHING: "Channel partner matching",
  RELATIONSHIP_SCORING: "Relationship scoring",
  QUICK_SUGGESTIONS: "Quick suggestions",
  PROSPECT_ASK: "ProspectAsk",
  CAMPAIGN_COLUMN_DETECTION: "Campaign column detection",
  PROSPECT_RESEARCH: "Prospect research",
};

/**
 * Formats a USD amount for display, or the honest unknown marker.
 *
 * `null` is UNKNOWN and prints as such. It must never be coerced to 0 — an
 * unpriced model showing "$0.00" is the exact failure this dashboard exists to
 * avoid.
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  // Sub-cent totals are normal here: a single matching batch costs ~$0.0004.
  // Rounding those to $0.00 would make every per-call figure read as free.
  if (value !== 0 && Math.abs(value) < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(2)}`;
}
