import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";
import { assertNotExpelled } from "../expulsions/expulsion-guard.js";
import {
  assertSessionActive,
  loadActiveParticipant,
  loadSessionContext,
} from "../sessions/session-actor.js";

/**
 * Who is allowed to place a digital order at a table, and under which proof.
 *
 * The web diner has no account at all: they join a table with a typed name and
 * receive a `participant_id`. Requiring a JWT there meant the entire web flow
 * could not order. The app diner does have an account and keeps having to
 * prove it.
 *
 * Anonymous is NOT "anyone": every order is tied to a row in
 * `session_participants` that is currently seated at THIS session, and the
 * attribution (`participant_id`, `user_id`) is read off that row - never off
 * the request body and never off the token. Knowing a session id proves
 * nothing; the same IDOR discipline as the rest of the session actions.
 */

export interface OrderingParticipant {
  sessionId: string;
  participantId: string;
  /** The registered account behind the seat, when there is one. */
  userId: string | null;
  platform: string | null;
  webName: string | null;
}

/** Every refusal is logged - a probing caller leaves no other trace. */
const denyOrder = (
  code: string,
  message: string,
  status: number,
  context: Record<string, unknown>,
): never => {
  logger.warn({ code, ...context }, "order authorization denied");
  throw createError(message, status, code);
};

/** The caller's own seat in this session, resolved from their account. */
const findParticipantByUser = async (
  sessionId: string,
  authUserId: string,
): Promise<Record<string, unknown> | null> => {
  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .select("id, user_id, web_name, platform, disconnected_at")
    .eq("session_id", sessionId)
    .eq("user_id", authUserId)
    .is("disconnected_at", null)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  }

  return (data as Record<string, unknown> | null) ?? null;
};

/**
 * Identify the diner placing the order, or throw.
 *
 * - `platform = 'web'`: no token required, the seat itself is the credential.
 * - anything else ('app', or a row with no platform recorded): a valid JWT
 *   whose user matches the seat is required. Unknown platforms fail closed.
 *
 * When no `participant_id` is sent, the seat is resolved from the token. That
 * is the app's existing request shape, which keeps working unchanged - and now
 * lands with a `participant_id` instead of losing it.
 */
export const resolveOrderingParticipant = async (params: {
  sessionId: string;
  participantId?: string;
  authUserId?: string;
}): Promise<OrderingParticipant> => {
  const { sessionId, participantId, authUserId } = params;

  // 404 / 409 before anything else: ordering into a closed table is refused
  // for web and app alike.
  const session = await loadSessionContext(sessionId);
  assertSessionActive(session);

  let row: Record<string, unknown> | null;

  if (participantId) {
    row = await loadActiveParticipant(sessionId, participantId);

    if (!row) {
      return denyOrder(
        "PARTICIPANT_NOT_IN_SESSION",
        "You are not seated at this table",
        403,
        { session_id: sessionId, participant_id: participantId },
      );
    }
  } else if (authUserId) {
    row = await findParticipantByUser(sessionId, authUserId);

    if (!row) {
      return denyOrder("NOT_A_PARTICIPANT", "You are not seated at this table", 403, {
        session_id: sessionId,
        auth_user_id: authUserId,
      });
    }
  } else {
    return denyOrder(
      "IDENTITY_REQUIRED",
      "participant_id is required when ordering without a session token",
      401,
      { session_id: sessionId },
    );
  }

  const resolvedParticipantId = row["id"] as string;
  const userId = (row["user_id"] as string | null) ?? null;
  const platform = (row["platform"] as string | null) ?? null;
  const webName = (row["web_name"] as string | null) ?? null;

  // Anonymous is allowed only for a seat that has no account behind it. A
  // registered diner who joined from the web still carries a `user_id`, and
  // letting that seat order without a token would downgrade a real account to
  // "anyone who knows the id". The platform alone does not decide; the
  // presence of an account does. Unknown platforms fail closed.
  const anonymousAllowed = platform === "web" && userId === null;

  if (!anonymousAllowed) {
    if (!authUserId) {
      return denyOrder("AUTH_REQUIRED", "This participant must be signed in to order", 401, {
        session_id: sessionId,
        participant_id: resolvedParticipantId,
        platform,
        has_account: userId !== null,
      });
    }

    if (!userId || userId !== authUserId) {
      return denyOrder("PARTICIPANT_MISMATCH", "This participant is not yours", 401, {
        session_id: sessionId,
        participant_id: resolvedParticipantId,
        auth_user_id: authUserId,
      });
    }
  }

  // A seat can survive an expulsion race; the ban is the door, not the row.
  await assertNotExpelled({
    sessionId,
    userId: userId ?? undefined,
    webName: userId ? undefined : webName ?? undefined,
  });

  return {
    sessionId,
    participantId: resolvedParticipantId,
    userId,
    platform,
    webName,
  };
};
