import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { closeGroupForSession } from "../table-groups/table-groups.service.js";
import { computeSessionBalance } from "../payments/balance.service.js";
import { logger } from "../../lib/logger.js";

const generateToken = () =>
  Math.random().toString(36).substring(2, 12).toUpperCase();

const generatePin = () =>
  Math.floor(1000 + Math.random() * 9000).toString();

/** `closed_by` / audit actors are employees.id, not the auth user id. */
const resolveEmployeeId = async (authUserId: string): Promise<string> => {
  const { data } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("auth_user_id", authUserId)
    .eq("is_active", true)
    .maybeSingle();

  return ((data as Record<string, unknown> | null)?.["id"] as string | undefined) ?? authUserId;
};

/**
 * Lazily open a session for a table that is currently free. A freed table has
 * no active session, so the first diner to scan or enter the PIN opens one.
 * The session adopts the table's current credentials so the printed QR keeps
 * working after a close rotated them.
 */
const openSessionForTable = async (
  table: Record<string, unknown>,
): Promise<{ id: string; [key: string]: unknown }> => {
  const tableId = table["id"] as string;
  const token = (table["current_session_token"] as string | null) ?? generateToken();
  const pin = (table["current_pin"] as string | null) ?? generatePin();

  const { data, error } = await supabaseAdmin
    .from("table_sessions")
    .insert({
      table_id: tableId,
      branch_id: table["branch_id"] ?? null,
      session_token: token,
      pin,
      status: "active",
      opened_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create session", 500, "SESSION_CREATE_FAILED");
  }

  await supabaseAdmin
    .from("tables")
    .update({ current_session_token: token, current_pin: pin })
    .eq("id", tableId);

  return data as { id: string; [key: string]: unknown };
};

/**
 * If the table belongs to an active table group, return the group's shared
 * active session so all grouped tables join the same session.
 */
const resolveGroupSession = async (
  table: Record<string, unknown>,
): Promise<Record<string, unknown> | null> => {
  const groupId = table["current_group_id"] as string | null | undefined;
  if (!groupId) return null;

  const { data: group } = await supabaseAdmin
    .from("table_groups")
    .select("session_id")
    .eq("id", groupId)
    .is("closed_at", null)
    .maybeSingle();

  if (!group) return null;

  const { data: session } = await supabaseAdmin
    .from("table_sessions")
    .select("*")
    .eq("id", group.session_id as string)
    .eq("status", "active")
    .maybeSingle();

  return (session as Record<string, unknown> | null) ?? null;
};

export const joinSession = async (params: {
  token?: string;
  pin?: string;
  name?: string;
  platform: "app" | "web";
  userId?: string;
}): Promise<object> => {
  const { token, pin, name, platform, userId } = params;

  if (!token && !pin) {
    throw createError("token or pin is required", 400, "MISSING_FIELDS");
  }

  if (!userId && !name) {
    throw createError("name is required for guest users", 400, "MISSING_FIELDS");
  }

  let table = null;
  let tableError = null;
  let session = null;

  if (token) {
    const tableResult = await supabaseAdmin
      .from("tables")
      .select("*, branches(*, restaurants(*))")
      .eq("current_session_token", token)
      .maybeSingle();
    table = tableResult.data;
    tableError = tableResult.error;
  } else {
    // PIN is stored on the active session, not on the table
    const sessionResult = await supabaseAdmin
      .from("table_sessions")
      .select("*, tables(*, branches(*, restaurants(*)))")
      .eq("pin", pin!)
      .eq("status", "active")
      .maybeSingle();

    if (sessionResult.data) {
      session = sessionResult.data;
      const tablesData = (sessionResult.data as Record<string, unknown>)["tables"];
      table = tablesData as Record<string, unknown> | null;
    }
    tableError = sessionResult.error;
  }

  if (tableError || !table) {
    throw createError("Invalid token or PIN", 404, "TABLE_NOT_FOUND");
  }

  if (!session) {
    // Grouped tables share the group's session
    session = await resolveGroupSession(table as Record<string, unknown>);
  }

  if (!session) {
    const { data: existingSession } = await supabaseAdmin
      .from("table_sessions")
      .select("*")
      .eq("table_id", table.id)
      .eq("status", "active")
      .maybeSingle();

    if (existingSession) {
      session = existingSession;
    } else {
      session = await openSessionForTable(table as Record<string, unknown>);
    }
  }

  const participantData: Record<string, unknown> = {
    session_id: session.id,
    platform,
    connection_method: token ? "qr" : "pin",
    joined_at: new Date().toISOString(),
  };

  if (userId) {
    participantData["user_id"] = userId;
  } else {
    participantData["web_name"] = name;
  }

  const { data: participant, error: partError } = await supabaseAdmin
    .from("session_participants")
    .insert(participantData)
    .select("*")
    .single();

  if (partError || !participant) {
    throw createError(partError?.message ?? "Failed to create participant", 500, "PARTICIPANT_CREATE_FAILED");
  }

  const { data: participants } = await supabaseAdmin
    .from("session_participants")
    .select("*")
    .eq("session_id", session.id);

  const branch = (table as Record<string, unknown>)["branches"] as Record<string, unknown> | null;
  const restaurant = branch?.["restaurants"] as Record<string, unknown> | null;

  return {
    session_id: session.id,
    table_number: table.table_number,
    branch: branch
      ? { id: branch["id"], name: branch["name"], address: branch["address"] }
      : null,
    restaurant_name: restaurant?.["name"] ?? null,
    participants: participants ?? [],
  };
};

export const scanAndJoin = async (params: {
  token: string;
  platform: "app" | "web";
  name?: string;
  userId?: string;
}): Promise<object> => {
  const { token, platform, name, userId } = params;

  const { data: table, error: tableError } = await supabaseAdmin
    .from("tables")
    .select("*, branches(*, restaurants(*))")
    .eq("current_session_token", token)
    .maybeSingle();

  if (tableError || !table) {
    throw createError("Invalid QR token", 404, "TABLE_NOT_FOUND");
  }

  if (!userId && !name) {
    throw createError("name is required for guest users", 400, "MISSING_FIELDS");
  }

  // Grouped tables share the group's session
  let session = await resolveGroupSession(table as Record<string, unknown>);

  if (!session) {
    const { data: existingSession } = await supabaseAdmin
      .from("table_sessions")
      .select("*")
      .eq("table_id", table.id)
      .eq("status", "active")
      .maybeSingle();

    if (existingSession) {
      session = existingSession;
    } else {
      session = await openSessionForTable(table as Record<string, unknown>);
    }
  }

  const activeSession = session as { id: string; status: string };

  const participantData: Record<string, unknown> = {
    session_id: activeSession.id,
    platform,
    connection_method: "qr",
    joined_at: new Date().toISOString(),
  };
  if (userId) participantData["user_id"] = userId;
  else participantData["web_name"] = name;

  await supabaseAdmin.from("session_participants").insert(participantData);

  const branch = (table as Record<string, unknown>)["branches"] as Record<string, unknown> | null;
  const restaurant = branch?.["restaurants"] as Record<string, unknown> | null;
  const branchId = branch?.["id"] as string | undefined;

  const [
    { data: participants },
    { data: orders },
    { data: categories },
    { data: promotions },
  ] = await Promise.all([
    supabaseAdmin.from("session_participants").select("*").eq("session_id", activeSession.id),
    supabaseAdmin
      .from("orders")
      .select("*, order_items(*, order_item_modifications(*))")
      .eq("session_id", activeSession.id)
      .neq("status", "cancelled"),
    branchId
      ? supabaseAdmin
          .from("menu_categories")
          .select("*, products(*)")
          .eq("branch_id", branchId)
          .eq("is_active", true)
      : Promise.resolve({ data: [] }),
    branchId
      ? supabaseAdmin
          .from("promotions")
          .select("*")
          .eq("branch_id", branchId)
          .eq("is_active", true)
      : Promise.resolve({ data: [] }),
  ]);

  let bankingBenefits = null;
  if (userId) {
    const { data: cards } = await supabaseAdmin
      .from("saved_cards")
      .select("*")
      .eq("user_id", userId);
    bankingBenefits = cards ?? [];
  }

  return {
    session: {
      id: activeSession.id,
      status: activeSession.status,
      table_number: table.table_number,
    },
    restaurant: {
      name: restaurant?.["name"] ?? null,
      logo: restaurant?.["logo_url"] ?? null,
      branch_name: branch?.["name"] ?? null,
      address: branch?.["address"] ?? null,
      operation_mode: branch?.["operation_mode"] ?? null,
    },
    menu: categories ?? [],
    orders: orders ?? [],
    participants: participants ?? [],
    promotions: promotions ?? [],
    banking_benefits: bankingBenefits,
  };
};

export const getSession = async (sessionId: string): Promise<object> => {
  const { data: session, error } = await supabaseAdmin
    .from("table_sessions")
    .select("*, tables(*, branches(*, restaurants(*))), session_participants(*), orders(*, order_items(*, order_item_modifications(*)))")
    .eq("id", sessionId)
    .single();

  if (error || !session) {
    throw createError("Session not found", 404, "SESSION_NOT_FOUND");
  }

  return session;
};

export const getParticipants = async (sessionId: string): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .select("*")
    .eq("session_id", sessionId);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return data ?? [];
};

/**
 * Close a table session.
 *
 * A session can only close when `computeSessionBalance` says the bill is fully
 * settled - the same helper GET /payments and invoice generation use, so the
 * three can never disagree. Afterwards every freed table ends up with exactly
 * one fresh credential set and NO active session, because availability is
 * derived from the absence of an active session.
 *
 * @param actorAuthUserId the auth user id of the employee closing the table.
 */
export const closeSession = async (
  sessionId: string,
  actorAuthUserId: string,
): Promise<void> => {
  const { data: session, error: sessionError } = await supabaseAdmin
    .from("table_sessions")
    .select("id, table_id, branch_id, opened_at")
    .eq("id", sessionId)
    .eq("status", "active")
    .single();

  if (sessionError || !session) {
    throw createError("Active session not found", 404, "SESSION_NOT_FOUND");
  }

  const balance = await computeSessionBalance(sessionId);

  if (!balance.is_settled) {
    throw createError(
      "Cannot close session: the table still has a pending balance",
      400,
      "BALANCE_PENDING",
      {
        remaining: balance.remaining,
        pending_participant_count: balance.pending_participant_count,
      },
    );
  }

  const employeeId = await resolveEmployeeId(actorAuthUserId);
  const tableId = (session as Record<string, unknown>)["table_id"] as string;
  const closedAt = new Date().toISOString();

  const { error: closeError } = await supabaseAdmin
    .from("table_sessions")
    .update({ status: "closed", closed_at: closedAt, closed_by: employeeId })
    .eq("id", sessionId);

  if (closeError) {
    throw createError(closeError.message, 500, "CLOSE_FAILED");
  }

  // If this session belongs to an active table group, close the group and free
  // its tables WITHOUT opening replacement sessions - a freed table must have
  // none. Diners opening a new one is handled lazily on the next scan/PIN.
  const groupTableIds = await closeGroupForSession(sessionId, false);

  const freedTableIds = [...new Set([tableId, ...groupTableIds])].filter(Boolean);

  // No orphan active session may be left pointing at a freed table.
  if (freedTableIds.length > 0) {
    const { error: orphanError } = await supabaseAdmin
      .from("table_sessions")
      .update({ status: "closed", closed_at: closedAt, closed_by: employeeId })
      .in("table_id", freedTableIds)
      .eq("status", "active");

    if (orphanError) {
      throw createError(orphanError.message, 500, "CLOSE_INCOMPLETE", { session_id: sessionId });
    }
  }

  // Exactly one fresh credential set per freed table.
  for (const freedTableId of freedTableIds) {
    const { error: rotateError } = await supabaseAdmin
      .from("tables")
      .update({ current_session_token: generateToken(), current_pin: generatePin() })
      .eq("id", freedTableId);

    if (rotateError) {
      throw createError(rotateError.message, 500, "CLOSE_INCOMPLETE", {
        session_id: sessionId,
        table_id: freedTableId,
      });
    }
  }

  // PostgREST gives no transaction, so the invariant is verified rather than
  // assumed: never report a clean close over a half-applied one.
  if (freedTableIds.length > 0) {
    const { data: lingering, error: verifyError } = await supabaseAdmin
      .from("table_sessions")
      .select("id")
      .in("table_id", freedTableIds)
      .eq("status", "active");

    if (verifyError) {
      throw createError(verifyError.message, 500, "CLOSE_INCOMPLETE", { session_id: sessionId });
    }

    if ((lingering ?? []).length > 0) {
      throw createError(
        "Session closed but freed tables still have an active session",
        500,
        "CLOSE_INCOMPLETE",
        {
          session_id: sessionId,
          lingering_session_ids: (lingering ?? []).map(
            (s: Record<string, unknown>) => s["id"] as string,
          ),
        },
      );
    }
  }

  const { error: auditError } = await supabaseAdmin.from("audit_log").insert({
    actor_type: "employee",
    actor_id: employeeId,
    action: "close_session",
    module: "sessions",
    reference_type: "session",
    reference_id: sessionId,
    log_level: "full",
    old_value: {
      status: "active",
      opened_at: (session as Record<string, unknown>)["opened_at"] ?? null,
    },
    new_value: {
      status: "closed",
      closed_at: closedAt,
      closed_by: employeeId,
      freed_table_ids: freedTableIds,
      total_ordered: balance.total_ordered,
      total_paid: balance.total_paid,
      total_discount_absorbed: balance.total_discount_absorbed,
    },
    created_at: closedAt,
  });

  if (auditError) {
    logger.error({ err: auditError, sessionId }, "close_session audit_log insert failed");
  }
};
