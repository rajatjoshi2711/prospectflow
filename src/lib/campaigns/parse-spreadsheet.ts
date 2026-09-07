import ExcelJS from "exceljs";
import Papa from "papaparse";

/**
 * Reads an uploaded campaign lead list into a header row + string rows.
 *
 * LIBRARY CHOICE (deliberate, revisit if the landscape changes)
 * ------------------------------------------------------------
 * `exceljs` for the OOXML formats, `papaparse` for CSV.
 *
 * The obvious alternative is SheetJS (`xlsx`), which reads more formats. But
 * its npm-registry release has been frozen at 0.18.5 since 2022 and carries two
 * advisories in the parsing path itself — prototype pollution (CVE-2023-30533)
 * and a ReDoS (CVE-2024-22363). Both are fixed only in versions published to
 * the vendor's own CDN, not to npm, so `npm i xlsx` cannot get a patched build.
 * Feeding an arbitrary user upload to a known-vulnerable parser is exactly the
 * case those CVEs describe, so it is out.
 *
 * `exceljs` 4.4.0 is on npm, reads .xlsx/.xlsm, and has no advisory of its own.
 * It does pull a transitive `uuid` advisory (GHSA-w5hq-g745-h8pq), which
 * concerns a missing bounds check in uuid v3/v5/v6 when the CALLER supplies a
 * buffer; exceljs uses v4 and supplies no buffer, so it is not reachable here.
 *
 * `papaparse` is already a dependency (Phase 2 ingestion), so CSV costs nothing
 * new and gets a battle-tested parser rather than exceljs's weaker CSV path.
 *
 * `.xls` (BIFF8) is not supported — see `SPREADSHEET_EXTENSIONS` in
 * src/lib/blob.ts. Users are told to re-save as .xlsx.
 */

export type SpreadsheetRow = Record<string, string>;

export type ParsedSpreadsheet = {
  /** Header row, de-duplicated and in sheet order. */
  headers: string[];
  /** Data rows keyed by header. Fully blank rows are dropped. */
  rows: SpreadsheetRow[];
  /** True when parsing stopped at `maxRows` and the file held more. */
  truncated: boolean;
};

export class SpreadsheetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetParseError";
  }
}

/** Hard ceiling on leads per campaign, enforced at parse time. */
export const MAX_CAMPAIGN_LEADS = 20_000;

/**
 * How many data rows detection samples. Twenty is enough for a fraction-based
 * heuristic to be stable while staying small enough to put in an LLM prompt
 * and to store on the Campaign row for the confirmation preview.
 */
export const DETECTION_SAMPLE_ROWS = 20;

/**
 * Flattens an ExcelJS cell value to text.
 *
 * ExcelJS returns rich objects for several cell kinds. The hyperlink case
 * matters most here: a spreadsheet often shows a person's NAME as the visible
 * text with the LinkedIn profile URL hidden in the link target. Reading only
 * `.text` would hand column detection a column of names and it would find no
 * URLs at all, so a hyperlink whose target looks like a URL wins over its
 * display text.
 */
function cellToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    const candidate = value as unknown as Record<string, unknown>;

    if (typeof candidate.hyperlink === "string") {
      const target = candidate.hyperlink.trim();
      const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
      return /^(https?:)?\/\//i.test(target) || target.includes(".") ? target : text || target;
    }
    if (typeof candidate.text === "string") return candidate.text.trim();
    if (Array.isArray(candidate.richText)) {
      return candidate.richText
        .map((part) => (typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
        .join("")
        .trim();
    }
    // Formula cell: the cached result is what the user sees.
    if ("result" in candidate) return cellToText(candidate.result as ExcelJS.CellValue);
    if (typeof candidate.error === "string") return "";
  }

  return String(value).trim();
}

/**
 * Makes headers usable as object keys: blanks become `Column N`, and a repeated
 * header gets a numeric suffix rather than silently overwriting the first.
 */
function normalizeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

function isBlankRow(row: SpreadsheetRow): boolean {
  return Object.values(row).every((value) => value.trim() === "");
}

async function parseXlsx(buffer: Buffer, maxRows: number): Promise<ParsedSpreadsheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (error) {
    throw new SpreadsheetParseError(
      `Could not read that workbook: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  const worksheet = workbook.worksheets.find((sheet) => sheet.rowCount > 0) ?? workbook.worksheets[0];
  if (!worksheet) {
    throw new SpreadsheetParseError("That workbook has no sheets.");
  }

  const headerRow = worksheet.getRow(1);
  const rawHeaders: string[] = [];
  // `cellCount` counts populated cells; `actualCellCount` skips gaps. Iterate
  // by column index so an empty header cell between two populated ones keeps
  // its position and the data columns stay aligned.
  const columnCount = Math.max(headerRow.cellCount, worksheet.columnCount);
  for (let column = 1; column <= columnCount; column += 1) {
    rawHeaders.push(cellToText(headerRow.getCell(column).value));
  }
  while (rawHeaders.length > 0 && rawHeaders[rawHeaders.length - 1] === "") {
    rawHeaders.pop();
  }
  if (rawHeaders.length === 0) {
    throw new SpreadsheetParseError("The first row of that sheet is empty — it needs a header row.");
  }

  const headers = normalizeHeaders(rawHeaders);
  const rows: SpreadsheetRow[] = [];
  let truncated = false;

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const sheetRow = worksheet.getRow(rowNumber);
    const row: SpreadsheetRow = {};
    headers.forEach((header, index) => {
      row[header] = cellToText(sheetRow.getCell(index + 1).value);
    });
    if (!isBlankRow(row)) rows.push(row);
  }

  return { headers, rows, truncated };
}

function parseCsv(buffer: Buffer, maxRows: number): ParsedSpreadsheet {
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  const result = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const table = result.data.filter(Array.isArray);
  if (table.length === 0) {
    throw new SpreadsheetParseError("That CSV appears to be empty.");
  }

  const headers = normalizeHeaders((table[0] ?? []).map((value) => String(value ?? "")));
  const rows: SpreadsheetRow[] = [];
  let truncated = false;

  for (const record of table.slice(1)) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const row: SpreadsheetRow = {};
    headers.forEach((header, index) => {
      row[header] = String(record[index] ?? "").trim();
    });
    if (!isBlankRow(row)) rows.push(row);
  }

  return { headers, rows, truncated };
}

export async function parseSpreadsheet(
  buffer: Buffer,
  fileName: string,
  { maxRows = MAX_CAMPAIGN_LEADS }: { maxRows?: number } = {},
): Promise<ParsedSpreadsheet> {
  const lower = fileName.toLowerCase();

  if (lower.endsWith(".csv")) return parseCsv(buffer, maxRows);
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return parseXlsx(buffer, maxRows);
  if (lower.endsWith(".xls")) {
    throw new SpreadsheetParseError(
      "The old .xls format is not supported. Open the file in Excel or Sheets and re-save it as .xlsx, then upload again.",
    );
  }

  throw new SpreadsheetParseError("Upload an .xlsx, .xlsm or .csv file.");
}
