/**
 * Single source of truth for the Vercel Blob access mode used by the import
 * upload flow. It must match the access mode of the connected Blob store:
 * change it here and both the browser upload (`uploadPresigned`) and the
 * server-side download in the Inngest worker (`get`) stay in sync.
 */
export const BLOB_ACCESS = "private" as const;

/**
 * Content types browsers actually send for a `.zip` file. The authoritative
 * guard is the `.zip` filename check in the upload route; this list only
 * keeps the presigned URL from rejecting legitimate uploads.
 */
export const ZIP_CONTENT_TYPES = [
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "multipart/x-zip",
  "application/octet-stream",
];

/** 50MB safety net (see build plan). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Extensions accepted for a campaign lead list (Phase 5).
 *
 * `.xls` (the pre-2007 BIFF8 binary format) is deliberately NOT here. The one
 * maintained npm parser that reads it is SheetJS, whose npm-registry release is
 * pinned at 0.18.5 (2022) and carries an unpatched prototype-pollution advisory
 * in the parser itself; the fixed builds ship only from the vendor's own CDN.
 * Running an untrusted user upload through that is not a trade worth making for
 * a legacy format, so `.xls` is rejected with an explicit "re-save as .xlsx"
 * message instead. See src/lib/campaigns/parse-spreadsheet.ts.
 */
export const SPREADSHEET_EXTENSIONS = [".xlsx", ".xlsm", ".csv"] as const;

/** Content types browsers actually send for the extensions above. */
export const SPREADSHEET_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel",
  "text/csv",
  "application/csv",
  "text/plain",
  "application/octet-stream",
];

/**
 * 10MB. A lead list is a few columns wide; 10MB of xlsx is far more rows than
 * `MAX_CAMPAIGN_LEADS` allows anyway, so this is the cheap first gate.
 */
export const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;

export function hasSpreadsheetExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SPREADSHEET_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
