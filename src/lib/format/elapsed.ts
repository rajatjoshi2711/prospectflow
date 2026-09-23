/**
 * A coarse, honest elapsed time: days up to two months, then months, then
 * years.
 *
 * Deliberately coarse. These dates come out of a LinkedIn export whose
 * timestamps are already approximate, and "waiting 7 months" is the fact a
 * reader acts on — "waiting 214 days" would dress that up as a precision the
 * source does not have.
 *
 * Shared by the dashboard's action cards and the full action pages so the same
 * gap never reads two different ways on two screens.
 */
export function formatElapsed(from: Date, now: Date = new Date()): string {
  const days = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "1 day";
  if (days < 60) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months`;
  return `${Math.floor(days / 365)} years`;
}
