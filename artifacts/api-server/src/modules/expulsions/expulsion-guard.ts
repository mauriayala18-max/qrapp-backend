import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";

/**
 * The door test for someone trying to enter a table session.
 *
 * An expulsion that only sets `disconnected_at` is theatre: the diner scans
 * the same QR again and `upsertParticipant` brings their row straight back to
 * life. The ban has to be checked BEFORE the participant row is touched, and
 * it has to key off something the diner cannot change at will - their user id,
 * or for a guest the name the expulsion was recorded against.
 *
 * A guest's name is weak proof of identity (anyone can type it), but it is the
 * only handle a guest has; a determined guest can always come back under a new
 * name, which is precisely why staff can seal the table on top of expelling.
 */

/** Missing table / missing relation: the migration has not been run yet. */
export const isMissingRelation = (error: { code?: string } | null): boolean =>
  error?.code === "PGRST205" || error?.code === "PGRST204" || error?.code === "42P01";

/**
 * Refuse entry when an unrevoked expulsion record exists for this diner in
 * this session. Before the migration runs there is no table to consult, and
 * entry is allowed rather than denying everyone at every table.
 */
export const assertNotExpelled = async (params: {
  sessionId: string;
  userId?: string;
  webName?: string;
}): Promise<void> => {
  const { sessionId, userId, webName } = params;

  let query = supabaseAdmin
    .from("expulsion_records")
    .select("id, reason_type, created_at")
    .eq("session_id", sessionId)
    .eq("readmitted", false);

  if (userId) {
    query = query.eq("target_user_id", userId);
  } else if (webName) {
    query = query.is("target_user_id", null).eq("target_web_name", webName);
  } else {
    return;
  }

  const { data, error } = await query.limit(1);

  if (error) {
    if (isMissingRelation(error)) return;
    throw createError(error.message, 500, "EXPULSION_LOOKUP_FAILED");
  }

  const record = (data ?? [])[0] as Record<string, unknown> | undefined;

  if (!record) return;

  logger.warn(
    { session_id: sessionId, user_id: userId ?? null, web_name: webName ?? null },
    "expelled diner tried to rejoin",
  );

  throw createError(
    "You were removed from this table and cannot rejoin it",
    403,
    "EXPELLED_FROM_SESSION",
    { session_id: sessionId, reason_type: record["reason_type"] ?? null },
  );
};
