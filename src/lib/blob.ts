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
