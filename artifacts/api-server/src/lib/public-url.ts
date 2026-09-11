/**
 * The public address printed on physical things.
 *
 * A table's QR sticker is printed once and lives on the table for years, so the
 * URL it encodes must never depend on where the backend happens to be running
 * today. It comes from PUBLIC_APP_URL and from nowhere else: falling back to the
 * Replit dev domain would silently print thousands of stickers that die the day
 * the app moves to its real domain.
 */

/** Path stored in tables.qr_code_url. Fixed per table, never rotated. */
export const tableStickerPath = (tableId: string): string => `/t/${tableId}`;

/**
 * The configured public origin, or null when it is unset or unusable.
 *
 * Validated strictly, because the output ends up on paper: a value with a path,
 * a query string, embedded credentials or a plain-http scheme would print a
 * sticker that is dead or unsafe, and nobody notices until the stickers are on
 * the tables. Only http://localhost is tolerated, for local development.
 */
export const getPublicAppUrl = (): string | null => {
  const raw = process.env["PUBLIC_APP_URL"]?.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;

  return parsed.origin;
};

/** Why no sticker URL could be produced, for the panel to show. */
export const publicAppUrlProblem = (): "PUBLIC_APP_URL_NOT_SET" | "PUBLIC_APP_URL_INVALID" | null => {
  if (getPublicAppUrl()) return null;
  return process.env["PUBLIC_APP_URL"]?.trim() ? "PUBLIC_APP_URL_INVALID" : "PUBLIC_APP_URL_NOT_SET";
};

/**
 * Absolute URL to encode in a table's QR sticker, or null when PUBLIC_APP_URL
 * is unset. Callers must surface the null rather than substituting a domain.
 */
export const buildTableStickerUrl = (tableId: string): string | null => {
  const base = getPublicAppUrl();
  return base ? `${base}${tableStickerPath(tableId)}` : null;
};

/** Adds the sticker fields to a table row on its way out of the API. */
export const withStickerUrl = <T extends { id: string }>(
  table: T,
): T & {
  qr_sticker_url: string | null;
  qr_sticker_url_error: "PUBLIC_APP_URL_NOT_SET" | "PUBLIC_APP_URL_INVALID" | null;
} => {
  return {
    ...table,
    qr_sticker_url: buildTableStickerUrl(table.id),
    qr_sticker_url_error: publicAppUrlProblem(),
  };
};
