import { supabaseAdmin } from "../config/supabase.js";
import { createError } from "../middleware/errorHandler.js";

/**
 * The backend deals with three DIFFERENT id spaces, and mixing them is the
 * single most common source of silent data corruption here:
 *
 *   - `req.user.id`          the Supabase Auth user id (auth.users.id).
 *                            Valid for columns that FK to `users.id`.
 *   - `employees.id`         the staff row. Valid for `*_by` audit columns on
 *                            staff-performed actions.
 *   - `session_participants.id`  a diner inside one table session.
 *
 * `employees` links to auth through `employees.auth_user_id`, so an auth id is
 * NEVER interchangeable with an employees.id. Writing the auth id into a column
 * that FKs to `employees.id` is rejected outright by Postgres; writing it into
 * an unconstrained `*_by` column silently stores a value that joins to nothing.
 *
 * Always run the actor through one of these resolvers before persisting it.
 */

/** Resolve the signed-in auth user to their active `employees.id`. */
export const resolveEmployeeId = async (authUserId: string): Promise<string> => {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("auth_user_id", authUserId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "EMPLOYEE_LOOKUP_FAILED");
  }

  const employeeId = (data as Record<string, unknown> | null)?.["id"] as string | undefined;

  if (!employeeId) {
    // Never fall back to the auth id: that is exactly the bug this guards.
    throw createError(
      "No active employee record is linked to the signed-in user",
      403,
      "EMPLOYEE_NOT_FOUND",
    );
  }

  return employeeId;
};

/** Resolve a signed-in diner to their `session_participants.id` in a session. */
export const resolveParticipantId = async (
  sessionId: string,
  userId: string,
): Promise<string> => {
  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .select("id")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  }

  const participantId = (data as Record<string, unknown> | null)?.["id"] as string | undefined;

  if (!participantId) {
    throw createError(
      "You are not a participant in this session",
      403,
      "PARTICIPANT_NOT_FOUND",
    );
  }

  return participantId;
};
