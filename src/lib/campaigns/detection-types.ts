/**
 * The column-detection RESULT shape and its display copy.
 *
 * Deliberately separate from `detect-column.ts`, which performs detection and
 * therefore imports `@/lib/ai` (and through it the OpenAI SDK). The
 * confirmation UI is a client component and needs only the type and the labels,
 * so pulling them from here keeps a model SDK out of the browser bundle.
 */

/** Column-detection outcome. `column` is null when nothing was proposed. */
export type ColumnDetection = {
  column: string | null;
  /** 0-1. For the heuristic this is the literal match fraction. */
  confidence: number;
  method: "heuristic" | "heuristic-weak" | "llm" | "none";
};

/** Copy shown next to the proposed column, so the user knows how sure to be. */
export const DETECTION_METHOD_LABEL: Record<ColumnDetection["method"], string> = {
  heuristic: "Detected from the data in this column",
  "heuristic-weak": "Best guess — only some cells in this column look like profile URLs",
  llm: "Suggested by AI — no column clearly held profile URLs",
  none: "No column looked like it holds LinkedIn profile URLs",
};
