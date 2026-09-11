import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";

/**
 * Authorization for reading a session's participant roster.
 *
 * The endpoint this guards previously had no authorization at all: any
 * authenticated (or unauthenticated) caller who knew or guessed a session id
 * could read who is sitting at that table - the same IDOR class fixed for
 * orders and cancellations. Only two actors may see the roster: a diner who is
 * themselves in the session, or a member of staff assigned to its branch.
 */

export interface SessionRosterContext {
  id: string;
  branch_id: string;
}

/** Load the session together with the branch it belongs to. */
export const loadSessionForRoster = async (sessionId: string): Promise<SessionRosterContext> => {
  const { data, error } = await supabaseAdmin
    .from("table_sessions")
    .select("id, branch_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "SESSION_LOOKUP_FAILED");
  }

  if (!data) {
    throw createError("Session not found", 404, "SESSION_NOT_FOUND");
  }

  const row = data as Record<string, unknown>;

  return {
    id: row["id"] as string,
    branch_id: row["branch_id"] as string,
  };
};

const deny = (code: string, message: string, context: Record<string, unknown>): never => {
  logger.warn({ code, ...context }, "participant list denied");
  throw createError(message, 403, code);
};

/**
 * Prove the caller may read this session's roster, or throw 403.
 *
 * Staff must hold an active `employee_branches` row for the session's branch -
 * an employee of a different restaurant is a stranger here, same as anyone
 * else. A diner must be a currently-connected participant of THIS session;
 * having left it (disconnected_at set) or having sat at a different table does
 * not carry over.
 */
export const authorizeParticipantsAccess = async (
  authUserId: string,
  session: SessionRosterContext,
): Promise<void> => {
  const { data: employee, error: employeeError } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("auth_user_id", authUserId)
    .eq("is_active", true)
    .maybeSingle();

  if (employeeError) {
    throw createError(employeeError.message, 500, "EMPLOYEE_LOOKUP_FAILED");
  }

  if (employee) {
    const employeeId = (employee as Record<string, unknown>)["id"] as string;

    const { data: assignment, error: assignmentError } = await supabaseAdmin
      .from("employee_branches")
      .select("branch_id")
      .eq("employee_id", employeeId)
      .eq("branch_id", session.branch_id)
      .maybeSingle();

    if (assignmentError) {
      throw createError(assignmentError.message, 500, "BRANCH_LOOKUP_FAILED");
    }

    if (assignment) {
      return;
    }

    // An employee of a different branch is not automatically a diner either,
    // so fall through to the participant check rather than denying outright.
  }

  const { data: participant, error: participantError } = await supabaseAdmin
    .from("session_participants")
    .select("id")
    .eq("session_id", session.id)
    .eq("user_id", authUserId)
    .is("disconnected_at", null)
    .maybeSingle();

  if (participantError) {
    throw createError(participantError.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  }

  if (!participant) {
    deny("FORBIDDEN", "You are not part of this session", {
      auth_user_id: authUserId,
      session_id: session.id,
    });
  }
};
