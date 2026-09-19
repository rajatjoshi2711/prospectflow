/**
 * Whether an exported text value carries real content.
 *
 * LinkedIn's exporter writes the four-character STRING `null` where a value is
 * missing — `Invitations.csv` does it for an invitation sent without a note.
 * A plain `.trim().length > 0` check reads that as content, which made every
 * note-less invitation look personalised and added +5 to the relationship
 * score of people who were never written to.
 *
 * Ingestion now drops these at the field level (`getField` in
 * `process-import.ts`), so newly imported rows are already clean. This guard
 * exists for rows imported BEFORE that fix: re-importing is the real repair,
 * but a stale row must not keep inflating a score in the meantime.
 */
const ABSENT_VALUES = new Set(["null", "undefined", "n/a"]);

export function hasRealText(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return !ABSENT_VALUES.has(trimmed.toLowerCase());
}
