import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "../config/supabase.js";
import { logger } from "./logger.js";
import { createError } from "../middleware/errorHandler.js";

/**
 * Seat tokens: the private credential of ONE participant at ONE table session.
 *
 * A participant id is not a secret - it travels in rosters, orders and logs -
 * and a guest's display name is visible to the whole table. The seat token is
 * the only thing that proves "I am this seat": 32 random bytes handed to the
 * diner once, at join time, and never again. The database keeps only its
 * sha256, so a leaked row (or a leaked backup) cannot be replayed.
 *
 * Never log the plaintext, never return the hash.
 */

/** Request header carrying the diner's token (Express lowercases names). */
export const SEAT_TOKEN_HEADER = "x-seat-token";

/** Response header carrying a token issued lazily on a protected request. */
export const SEAT_TOKEN_ISSUED_HEADER = "X-Seat-Token-Issued";

/** Column names, kept in one place so they can be stripped from every payload. */
export const SEAT_TOKEN_HASH_COLUMN = "seat_token_hash";
export const SEAT_TOKEN_ISSUED_AT_COLUMN = "seat_token_issued_at";

export interface IssuedSeatToken {
  /** Plaintext. Goes to the client exactly once, then is forgotten. */
  token: string;
  /** sha256 hex of `token` - the only form ever persisted. */
  hash: string;
  issuedAt: string;
}

export const hashSeatToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const generateSeatToken = (): IssuedSeatToken => {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashSeatToken(token), issuedAt: new Date().toISOString() };
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Constant-time comparison of a presented token against a stored hash.
 * Both sides are compared as fixed-length 32-byte digests, so the time taken
 * never depends on how much of the token was right.
 */
export const seatTokenMatches = (presented: string, storedHash: string | null): boolean => {
  if (!storedHash || !SHA256_HEX.test(storedHash)) return false;
  const presentedDigest = Buffer.from(hashSeatToken(presented), "hex");
  const storedDigest = Buffer.from(storedHash, "hex");
  return presentedDigest.length === storedDigest.length && timingSafeEqual(presentedDigest, storedDigest);
};

/** Read the token header, ignoring empty values and absurd lengths. */
export const readPresentedSeatToken = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 256) return null;
  return trimmed;
};

/**
 * SEAT_TOKEN_ENFORCE (default "true"). "false" turns every rejection into a
 * logged warning so a bad rollout can be undone with an env change instead of
 * a redeploy. Read per request so flipping it needs only a restart.
 */
export const isSeatTokenEnforced = (): boolean =>
  (process.env["SEAT_TOKEN_ENFORCE"] ?? "true").trim().toLowerCase() !== "false";

/**
 * Whether the two seat-token columns exist in the live database.
 *
 * The SQL is run by hand, possibly after this code is deployed. Until then the
 * API must keep seating and serving diners exactly as before (no tokens issued,
 * nothing enforced) rather than locking every table out. The probe is cached;
 * a negative answer is re-checked every minute so running the SQL takes effect
 * without a restart.
 */
let columnsReady: boolean | null = null;
let lastProbeAt = 0;
const NEGATIVE_PROBE_TTL_MS = 60_000;

export const seatTokenColumnsReady = async (): Promise<boolean> => {
  if (columnsReady === true) return true;
  if (columnsReady === false && Date.now() - lastProbeAt < NEGATIVE_PROBE_TTL_MS) return false;

  lastProbeAt = Date.now();

  const { error } = await supabaseAdmin
    .from("session_participants")
    .select(`id, ${SEAT_TOKEN_HASH_COLUMN}, ${SEAT_TOKEN_ISSUED_AT_COLUMN}`)
    .limit(1);

  if (!error) {
    logger.info("seat token columns detected; seat tokens are active");
    columnsReady = true;
    return true;
  }

  // 42703 = undefined column; PGRST204 = column not in the schema cache.
  if (error.code === "42703" || error.code === "PGRST204") {
    logger.error(
      "session_participants.seat_token_hash / seat_token_issued_at are missing: " +
        "seat tokens are NOT issued or enforced until migrations/20261018_seat_tokens.sql is run",
    );
    columnsReady = false;
    return false;
  }

  // Unknown failure: do not cache, do not pretend the columns are missing.
  throw createError(error.message, 500, "SEAT_TOKEN_PROBE_FAILED");
};

/** Last known state, for /healthz. Never triggers a probe. */
export const seatTokenColumnsState = (): "ready" | "missing_columns" | "unknown" =>
  columnsReady === true ? "ready" : columnsReady === false ? "missing_columns" : "unknown";

/** Drop the hash from a participant row before it leaves the server. */
export const stripSeatSecrets = <T extends Record<string, unknown>>(row: T): T => {
  if (!(SEAT_TOKEN_HASH_COLUMN in row)) return row;
  const { [SEAT_TOKEN_HASH_COLUMN]: _hash, ...rest } = row;
  return rest as T;
};
