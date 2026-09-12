import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";

/**
 * One authorization model for every action scoped to a table session:
 * reading the roster, expelling a diner, sealing the table.
 *
 * The rule is always the same and is always answered by the database, never by
 * the request body: the caller is either a diner currently sitting at THIS
 * table, or a member of staff assigned to the branch that owns it. Knowing a
 * session id, a participant id or a proposal id proves nothing - that is the
 * IDOR class already fixed for orders, cancellations and the roster.
 */

/** Staff roles that may act on a table session (expel, seal, readmit). */
export const SESSION_STAFF_ROLES = ["waiter", "manager", "admin"];

export interface SessionContext {
  id: string;
  branch_id: string;
  status: string;
  entry_locked: boolean;
}

export type SessionActor =
  | { kind: "staff"; authUserId: string; employeeId: string; role: string }
  | { kind: "participant"; authUserId: string; participantId: string };

/** Every refusal is logged: a probing caller writes no audit row otherwise. */
export const denySession = (
  code: string,
  message: string,
  context: Record<string, unknown>,
): never => {
  logger.warn({ code, ...context }, "session action denied");
  throw createError(message, 403, code);
};

/** Load the session together with the branch it belongs to. */
export const loadSessionContext = async (sessionId: string): Promise<SessionContext> => {
  const { data, error } = await supabaseAdmin
    .from("table_sessions")
    .select("id, branch_id, status, entry_locked")
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
    status: (row["status"] as string | null) ?? "active",
    entry_locked: row["entry_locked"] === true,
  };
};

/** Expelling or sealing a table that is already closed changes nothing real. */
export const assertSessionActive = (session: SessionContext): void => {
  if (session.status !== "active") {
    throw createError("This session is no longer active", 409, "SESSION_NOT_ACTIVE", {
      session_id: session.id,
      status: session.status,
    });
  }
};

/** The staff row for this auth user, if they are one and are assigned here. */
const resolveStaff = async (
  authUserId: string,
  branchId: string,
): Promise<{ employeeId: string; role: string } | null> => {
  const { data: employee, error: employeeError } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("auth_user_id", authUserId)
    .eq("is_active", true)
    .maybeSingle();

  if (employeeError) {
    throw createError(employeeError.message, 500, "EMPLOYEE_LOOKUP_FAILED");
  }

  if (!employee) return null;

  const row = employee as Record<string, unknown>;
  const employeeId = row["id"] as string;

  const { data: assignment, error: assignmentError } = await supabaseAdmin
    .from("employee_branches")
    .select("branch_id")
    .eq("employee_id", employeeId)
    .eq("branch_id", branchId)
    .eq("is_active", true)
    .maybeSingle();

  if (assignmentError) {
    throw createError(assignmentError.message, 500, "BRANCH_LOOKUP_FAILED");
  }

  // An employee of another restaurant is a stranger at this table.
  if (!assignment) return null;

  return { employeeId, role: row["role"] as string };
};

/** The caller's participant row in this session, only while still connected. */
const resolveParticipant = async (
  authUserId: string,
  sessionId: string,
): Promise<string | null> => {
  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .select("id")
    .eq("session_id", sessionId)
    .eq("user_id", authUserId)
    .is("disconnected_at", null)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  }

  return ((data as Record<string, unknown> | null)?.["id"] as string | undefined) ?? null;
};

/**
 * Identify the caller for this session, or throw 403.
 *
 * Staff are checked first so an employee who also happens to be seated is
 * treated as staff. A diner must be currently connected: having left the table
 * (or sat at a different one) is not access.
 */
export const resolveSessionActor = async (
  authUserId: string,
  session: SessionContext,
): Promise<SessionActor> => {
  const staff = await resolveStaff(authUserId, session.branch_id);

  if (staff) {
    return { kind: "staff", authUserId, employeeId: staff.employeeId, role: staff.role };
  }

  const participantId = await resolveParticipant(authUserId, session.id);

  if (participantId) {
    return { kind: "participant", authUserId, participantId };
  }

  return denySession("FORBIDDEN", "You are not part of this session", {
    auth_user_id: authUserId,
    session_id: session.id,
  });
};

/** Narrow an actor to staff with one of the allowed roles, or throw 403. */
export const requireStaffActor = (
  actor: SessionActor,
  session: SessionContext,
  roles: string[] = SESSION_STAFF_ROLES,
): Extract<SessionActor, { kind: "staff" }> => {
  if (actor.kind !== "staff") {
    denySession("FORBIDDEN", "Employee access required", {
      auth_user_id: actor.authUserId,
      session_id: session.id,
    });
  }

  const staff = actor as Extract<SessionActor, { kind: "staff" }>;

  if (!roles.includes(staff.role)) {
    denySession("FORBIDDEN_ROLE", "Insufficient role permissions", {
      auth_user_id: actor.authUserId,
      session_id: session.id,
      role: staff.role,
    });
  }

  return staff;
};

/** Narrow an actor to a seated diner, or throw 403. */
export const requireParticipantActor = (
  actor: SessionActor,
  session: SessionContext,
): Extract<SessionActor, { kind: "participant" }> => {
  if (actor.kind !== "participant") {
    denySession("PARTICIPANTS_ONLY", "Only a diner seated at this table can do this", {
      auth_user_id: actor.authUserId,
      session_id: session.id,
    });
  }

  return actor as Extract<SessionActor, { kind: "participant" }>;
};

/** Ids of everyone currently seated. The quorum for votes and locks. */
export const listActiveParticipantIds = async (sessionId: string): Promise<string[]> => {
  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .select("id")
    .eq("session_id", sessionId)
    .is("disconnected_at", null);

  if (error) {
    throw createError(error.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => row["id"] as string);
};

/** A participant row of this session that is still connected, or null. */
export const loadActiveParticipant = async (
  sessionId: string,
  participantId: string,
): Promise<Record<string, unknown> | null> => {
  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .select("id, user_id, web_name, disconnected_at")
    .eq("session_id", sessionId)
    .eq("id", participantId)
    .is("disconnected_at", null)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  }

  return (data as Record<string, unknown> | null) ?? null;
};
