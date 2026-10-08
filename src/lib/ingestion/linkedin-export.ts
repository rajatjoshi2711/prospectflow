/**
 * Where LinkedIn hands out a data export.
 *
 * Kept as a constant rather than inlined at each call site because it is an
 * external URL we do not control: when LinkedIn moves the page, this is the
 * one line to change.
 *
 * This is the "Get a copy of your data" screen under Settings → Data privacy.
 * Pick "Want something in particular?" and tick Connections, Messages,
 * Positions and Invitations, or take the larger archive — ProspectFlow ingests
 * every CSV it finds either way.
 */
export const LINKEDIN_EXPORT_URL =
  "https://www.linkedin.com/mypreferences/d/download-my-data";
