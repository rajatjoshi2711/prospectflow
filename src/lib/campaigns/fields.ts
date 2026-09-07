import type { SpreadsheetRow } from "@/lib/campaigns/parse-spreadsheet";
import { looksLikeLinkedinProfile } from "@/lib/campaigns/detect-column";

/**
 * Pulls the display fields (name, company, title) out of an arbitrary lead
 * spreadsheet.
 *
 * Only the LinkedIn-URL column is confirmed by the user, because only it drives
 * matching. Everything else is best-effort header matching purely for display:
 * the untouched row is always kept in `CampaignLead.rawRow`, so a column this
 * misses is never lost — it is still there to show and to query later.
 *
 * Nothing here invents a value. A field that cannot be found stays null.
 */

/** Case/space-insensitive header lookup over a list of likely spellings. */
function pick(row: SpreadsheetRow, candidates: string[]): string | null {
  const normalized = new Map<string, string>();
  for (const key of Object.keys(row)) {
    normalized.set(key.trim().toLowerCase().replace(/[\s_-]+/g, " "), row[key]);
  }
  for (const candidate of candidates) {
    const value = normalized.get(candidate)?.trim();
    if (value) return value;
  }
  return null;
}

/** Substring fallback, e.g. a header called "Prospect first name". */
function pickContaining(row: SpreadsheetRow, needles: string[], exclude: string[] = []): string | null {
  for (const key of Object.keys(row)) {
    const lower = key.trim().toLowerCase();
    if (exclude.some((word) => lower.includes(word))) continue;
    if (needles.some((needle) => lower.includes(needle))) {
      const value = row[key]?.trim();
      if (value) return value;
    }
  }
  return null;
}

/** Splits "Jane Van Doe" into first / last, last token being the surname. */
function splitFullName(fullName: string): { firstName: string | null; lastName: string | null } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

export type LeadFields = {
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  position: string | null;
};

export function extractLeadFields(row: SpreadsheetRow): LeadFields {
  let firstName = pick(row, ["first name", "firstname", "given name", "forename"]);
  let lastName = pick(row, ["last name", "lastname", "surname", "family name"]);

  if (!firstName && !lastName) {
    const fullName =
      pick(row, ["name", "full name", "fullname", "contact name", "lead name", "prospect name"]) ??
      pickContaining(row, ["name"], ["company", "organisation", "organization", "account", "file", "user", "column"]);
    if (fullName && !looksLikeLinkedinProfile(fullName)) {
      const split = splitFullName(fullName);
      firstName = split.firstName;
      lastName = split.lastName;
    }
  } else if (!firstName) {
    firstName = pickContaining(row, ["first"], ["company"]);
  }

  const company =
    pick(row, ["company", "company name", "organisation", "organization", "employer", "account", "account name"]) ??
    pickContaining(row, ["company", "organisation", "organization", "employer"]);

  const position =
    pick(row, ["position", "title", "job title", "jobtitle", "role", "headline", "designation"]) ??
    pickContaining(row, ["title", "role", "position", "headline"], ["company", "file"]);

  return { firstName, lastName, company, position };
}

/**
 * A short line of context from the original row for the campaign table's extra
 * column: the job title if one was found, else the first cell that is neither
 * the URL nor an already-displayed field. Returns null when the row holds
 * nothing else worth showing — better an em dash than filler.
 */
export function summarizeRawRow(
  row: SpreadsheetRow,
  linkedinColumn: string | null,
  fields: LeadFields,
): string | null {
  if (fields.position) return fields.position;

  const shown = new Set(
    [fields.firstName, fields.lastName, fields.company].filter(Boolean).map((value) => value!.toLowerCase()),
  );

  for (const [key, rawValue] of Object.entries(row)) {
    if (key === linkedinColumn) continue;
    const value = (rawValue ?? "").trim();
    if (!value || shown.has(value.toLowerCase()) || looksLikeLinkedinProfile(value)) continue;
    const label = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    return `${key}: ${label}`;
  }
  return null;
}
