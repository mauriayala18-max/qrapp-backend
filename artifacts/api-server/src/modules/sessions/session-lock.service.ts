import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";
import {
  assertSessionActive,
  listActiveParticipantIds,
  loadSessionContext,
  requireStaffActor,
  resolveSessionActor,
} from "./session-actor.js";
import { isMissingRelation } from "../expulsions/expulsion-guard.js";

/**
 * Sealing a table (`table_sessions.entry_locked`).
 *
 * Locking model: a per-participant LOCK REQUEST, not a proposal with votes.
 * Each seated diner can ask once (`session_lock_requests`, unique per
 * participant), and the table seals itself the moment more than half of the
 * CURRENTLY seated diners have asked. There is no window and nothing to
 * accept or decline - the last person to ask is the one who flips it.
 *
 * The majority is always recomputed against the live participant list, so a
 * request made when eight people were seated does not silently become a
 * majority once six of them leave... and equally, two requests out of three
 * seal the table even if the request came in one at a time.
 *
 * Staff bypass the count entirely, and only staff can unlock.
 */

export interface LockState {
  session_id: string;
  entry_locked: boolean;
  locked_by: "staff" | "majority" | null;
  active_participants: number;
  lock_requests: number;
  requests_required: number;
  your_request_registered: boolean;
}

/** More than half: 2 of 3, 3 of 4, 3 of 5. */
export const majorityThreshold = (activeCount: number): number =>
  Math.floor(activeCount / 2) + 1;

const guardInstalled = (error: { code?: string } | null): void => {
  if (error && isMissingRelation(error)) {
    throw createError(
      "The lock-request table is not installed yet; run the 20260908_expulsions_and_sealing migration",
      503,
      "EXPULSIONS_NOT_INSTALLED",
    );
  }
};

const setEntryLocked = async (sessionId: string, locked: boolean): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("table_sessions")
    .update({ entry_locked: locked })
    .eq("id", sessionId);

  if (error) {
    throw createError(error.message, 500, "LOCK_UPDATE_FAILED");
  }
};

/** Requests only count while the diner who made them is still seated. */
const countLiveRequests = async (sessionId: string, activeIds: string[]): Promise<number> => {
  const { data, error } = await supabaseAdmin
    .from("session_lock_requests")
    .select("participant_id")
    .eq("session_id", sessionId);

  guardInstalled(error);
  if (error) throw createError(error.message, 500, "LOCK_REQUEST_LOOKUP_FAILED");

  const active = new Set(activeIds);

  return ((data ?? []) as Array<Record<string, unknown>>).filter((row) =>
    active.has(row["participant_id"] as string),
  ).length;
};

const clearRequests = async (sessionId: string): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("session_lock_requests")
    .delete()
    .eq("session_id", sessionId);

  if (error && !isMissingRelation(error)) {
    logger.error({ err: error, session_id: sessionId }, "failed to clear lock requests");
  }
};

/**
 * Seal the table. Staff do it outright; a diner registers their request and
 * the table seals once the majority is reached.
 */
export const lockSession = async (params: {
  sessionId: string;
  authUserId: string;
}): Promise<LockState> => {
  const { sessionId, authUserId } = params;

  const session = await loadSessionContext(sessionId);
  assertSessionActive(session);

  const actor = await resolveSessionActor(authUserId, session);
  const activeIds = await listActiveParticipantIds(session.id);

  if (actor.kind === "staff") {
    requireStaffActor(actor, session);

    if (!session.entry_locked) {
      await setEntryLocked(session.id, true);
      logger.info(
        { session_id: session.id, employee_id: actor.employeeId },
        "table sealed by staff",
      );
    }

    return {
      session_id: session.id,
      entry_locked: true,
      locked_by: "staff",
      active_participants: activeIds.length,
      lock_requests: await countLiveRequests(session.id, activeIds),
      requests_required: majorityThreshold(activeIds.length),
      your_request_registered: false,
    };
  }

  const { error: requestError } = await supabaseAdmin
    .from("session_lock_requests")
    .insert({ session_id: session.id, participant_id: actor.participantId });

  if (requestError && requestError.code !== "23505") {
    guardInstalled(requestError);
    throw createError(requestError.message, 500, "LOCK_REQUEST_FAILED");
  }

  // Read the roster again now that the request is stored: a diner who sat
  // down while this call was in flight raises the bar rather than being
  // missed by a count taken a moment before they arrived.
  const liveIds = await listActiveParticipantIds(session.id);
  const requests = await countLiveRequests(session.id, liveIds);
  const required = majorityThreshold(liveIds.length);
  const reached = requests >= required;

  if (reached && !session.entry_locked) {
    await setEntryLocked(session.id, true);
    logger.info(
      { session_id: session.id, requests, required },
      "table sealed by majority of diners",
    );
  }

  return {
    session_id: session.id,
    entry_locked: session.entry_locked || reached,
    locked_by: session.entry_locked || reached ? "majority" : null,
    active_participants: liveIds.length,
    lock_requests: requests,
    requests_required: required,
    your_request_registered: true,
  };
};

/**
 * Reopen the table. Staff only - a diner who could unlock would undo the
 * table's own decision on their own. Pending requests are wiped, otherwise a
 * majority left over from before would re-seal the table on the next request.
 */
export const unlockSession = async (params: {
  sessionId: string;
  authUserId: string;
}): Promise<LockState> => {
  const { sessionId, authUserId } = params;

  const session = await loadSessionContext(sessionId);
  assertSessionActive(session);

  const actor = await resolveSessionActor(authUserId, session);
  const staff = requireStaffActor(actor, session);

  if (session.entry_locked) {
    await setEntryLocked(session.id, false);
  }

  await clearRequests(session.id);

  logger.info({ session_id: session.id, employee_id: staff.employeeId }, "table reopened by staff");

  const activeIds = await listActiveParticipantIds(session.id);

  return {
    session_id: session.id,
    entry_locked: false,
    locked_by: null,
    active_participants: activeIds.length,
    lock_requests: 0,
    requests_required: majorityThreshold(activeIds.length),
    your_request_registered: false,
  };
};
