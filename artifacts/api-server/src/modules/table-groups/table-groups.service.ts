import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { resolveEmployeeId as getEmployeeId } from "../../lib/actors.js";

const generateToken = () =>
  Math.random().toString(36).substring(2, 12).toUpperCase();

const generatePin = () =>
  Math.floor(1000 + Math.random() * 9000).toString();

type TableRow = {
  id: string;
  branch_id: string;
  table_number: number;
  current_group_id: string | null;
};

const createSessionForTable = async (table: TableRow): Promise<void> => {
  const token = generateToken();
  const pin = generatePin();

  const { error: sessionError } = await supabaseAdmin
    .from("table_sessions")
    .insert({
      table_id: table.id,
      branch_id: table.branch_id,
      session_token: token,
      pin,
      status: "active",
      opened_at: new Date().toISOString(),
    });

  if (sessionError) {
    throw createError(sessionError.message, 500, "SESSION_CREATE_FAILED");
  }

  await supabaseAdmin
    .from("tables")
    .update({ current_session_token: token, current_pin: pin })
    .eq("id", table.id);
};


export const createTableGroup = async (params: {
  branchId: string;
  tableIds: string[];
  name?: string;
  authUserId: string;
}): Promise<object> => {
  const { branchId, tableIds, name, authUserId } = params;

  if (!Array.isArray(tableIds) || tableIds.length < 2) {
    throw createError("At least 2 table_ids are required", 400, "INVALID_TABLE_IDS");
  }

  const uniqueIds = [...new Set(tableIds)];
  if (uniqueIds.length !== tableIds.length) {
    throw createError("Duplicate table_ids provided", 400, "INVALID_TABLE_IDS");
  }

  const employeeId = await getEmployeeId(authUserId);

  const { data: tablesData, error: tablesError } = await supabaseAdmin
    .from("tables")
    .select("id, branch_id, table_number, current_group_id")
    .in("id", tableIds)
    .eq("branch_id", branchId);

  if (tablesError) {
    throw createError(tablesError.message, 500, "FETCH_FAILED");
  }

  const tables = (tablesData ?? []) as TableRow[];
  if (tables.length !== tableIds.length) {
    throw createError(
      "One or more tables not found in this branch",
      400,
      "TABLES_NOT_IN_BRANCH",
    );
  }

  const alreadyGrouped = tables.filter((t) => t.current_group_id !== null);
  if (alreadyGrouped.length > 0) {
    throw createError(
      `Tables already in a group: ${alreadyGrouped.map((t) => t.table_number).join(", ")}`,
      409,
      "TABLES_ALREADY_GROUPED",
    );
  }

  // Order tables to match the order of the provided table_ids
  const orderedTables = tableIds.map(
    (id) => tables.find((t) => t.id === id) as TableRow,
  );

  // Fetch active sessions for all tables
  const { data: activeSessions, error: sessionsError } = await supabaseAdmin
    .from("table_sessions")
    .select("*")
    .in("table_id", tableIds)
    .eq("status", "active");

  if (sessionsError) {
    throw createError(sessionsError.message, 500, "FETCH_FAILED");
  }

  const sessionByTable = new Map<string, Record<string, unknown>>();
  for (const s of activeSessions ?? []) {
    sessionByTable.set(s.table_id as string, s as Record<string, unknown>);
  }

  // Shared session: first table's active session, or create a new one
  const firstTable = orderedTables[0]!;
  let sharedSession = sessionByTable.get(firstTable.id) ?? null;

  if (!sharedSession) {
    const { data: newSession, error: newSessionError } = await supabaseAdmin
      .from("table_sessions")
      .insert({
        table_id: firstTable.id,
        branch_id: branchId,
        session_token: generateToken(),
        pin: generatePin(),
        status: "active",
        opened_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (newSessionError || !newSession) {
      throw createError(
        newSessionError?.message ?? "Failed to create shared session",
        500,
        "SESSION_CREATE_FAILED",
      );
    }
    sharedSession = newSession as Record<string, unknown>;
  }

  const sharedSessionId = sharedSession["id"] as string;

  const groupName =
    name && name.trim().length > 0
      ? name.trim()
      : `Mesas ${orderedTables.map((t) => t.table_number).sort((a, b) => a - b).join("-")}`;

  const { data: group, error: groupError } = await supabaseAdmin
    .from("table_groups")
    .insert({
      branch_id: branchId,
      session_id: sharedSessionId,
      name: groupName,
      created_by: employeeId,
    })
    .select("*")
    .single();

  if (groupError || !group) {
    throw createError(
      groupError?.message ?? "Failed to create table group",
      500,
      "GROUP_CREATE_FAILED",
    );
  }

  const groupId = group.id as string;

  const { error: updateTablesError } = await supabaseAdmin
    .from("tables")
    .update({ current_group_id: groupId })
    .in("id", tableIds);

  if (updateTablesError) {
    throw createError(updateTablesError.message, 500, "UPDATE_FAILED");
  }

  // Merge other tables' active sessions into the shared session
  for (const table of orderedTables.slice(1)) {
    const ownSession = sessionByTable.get(table.id);
    if (!ownSession) continue;
    const ownSessionId = ownSession["id"] as string;
    if (ownSessionId === sharedSessionId) continue;

    await supabaseAdmin
      .from("session_participants")
      .update({ session_id: sharedSessionId })
      .eq("session_id", ownSessionId);

    await supabaseAdmin
      .from("orders")
      .update({ session_id: sharedSessionId })
      .eq("session_id", ownSessionId);

    await supabaseAdmin
      .from("table_sessions")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
        closed_by: employeeId,
      })
      .eq("id", ownSessionId);
  }

  const { data: groupTables } = await supabaseAdmin
    .from("tables")
    .select("*")
    .eq("current_group_id", groupId);

  const { data: session } = await supabaseAdmin
    .from("table_sessions")
    .select("*")
    .eq("id", sharedSessionId)
    .single();

  return {
    ...group,
    tables: groupTables ?? [],
    session: session ?? sharedSession,
  };
};

export const getTableGroups = async (branchId: string): Promise<object[]> => {
  const { data: groups, error } = await supabaseAdmin
    .from("table_groups")
    .select("*")
    .eq("branch_id", branchId)
    .is("closed_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  if (!groups || groups.length === 0) return [];

  const groupIds = groups.map((g) => g.id as string);
  const { data: tables, error: tablesError } = await supabaseAdmin
    .from("tables")
    .select("*")
    .in("current_group_id", groupIds);

  if (tablesError) {
    throw createError(tablesError.message, 500, "FETCH_FAILED");
  }

  return groups.map((g) => ({
    ...g,
    tables: (tables ?? []).filter((t) => t.current_group_id === g.id),
  }));
};

/**
 * Detach every table from the group.
 *
 * `createFreshSessions` distinguishes the two callers:
 *  - unmerge (deleteTableGroup): each freed table immediately gets its own
 *    active session again, because the diners are still seated.
 *  - session close: the table must end up with NO active session - availability
 *    is derived from the absence of one - so the caller rotates credentials and
 *    leaves the table free instead.
 *
 * Returns the ids of the tables that were released.
 */
const releaseGroupTables = async (
  groupId: string,
  createFreshSessions = true,
): Promise<string[]> => {
  const { data: tablesData, error: tablesError } = await supabaseAdmin
    .from("tables")
    .select("id, branch_id, table_number, current_group_id")
    .eq("current_group_id", groupId);

  if (tablesError) {
    throw createError(tablesError.message, 500, "FETCH_FAILED");
  }

  const tables = (tablesData ?? []) as TableRow[];

  const { error: clearError } = await supabaseAdmin
    .from("tables")
    .update({ current_group_id: null })
    .eq("current_group_id", groupId);

  if (clearError) {
    throw createError(clearError.message, 500, "UPDATE_FAILED");
  }

  if (createFreshSessions) {
    for (const table of tables) {
      await createSessionForTable(table);
    }
  }

  return tables.map((t) => t.id);
};

export const deleteTableGroup = async (groupId: string): Promise<void> => {
  const { data: group, error: groupError } = await supabaseAdmin
    .from("table_groups")
    .select("*")
    .eq("id", groupId)
    .is("closed_at", null)
    .maybeSingle();

  if (groupError) {
    throw createError(groupError.message, 500, "FETCH_FAILED");
  }
  if (!group) {
    throw createError("Active table group not found", 404, "GROUP_NOT_FOUND");
  }

  const { error: closeError } = await supabaseAdmin
    .from("table_groups")
    .update({ closed_at: new Date().toISOString() })
    .eq("id", groupId);

  if (closeError) {
    throw createError(closeError.message, 500, "CLOSE_FAILED");
  }

  // The shared session stays open until payment is complete.
  await releaseGroupTables(groupId);
};

/**
 * Called when a session is closed. If the session belongs to an active table
 * group, close the group and release its tables.
 *
 * Returns the ids of the released tables so the caller can rotate credentials
 * and guarantee no orphan active session is left behind.
 */
export const closeGroupForSession = async (
  sessionId: string,
  createFreshSessions = true,
): Promise<string[]> => {
  const { data: group } = await supabaseAdmin
    .from("table_groups")
    .select("id")
    .eq("session_id", sessionId)
    .is("closed_at", null)
    .maybeSingle();

  if (!group) return [];

  const groupId = group.id as string;

  await supabaseAdmin
    .from("table_groups")
    .update({ closed_at: new Date().toISOString() })
    .eq("id", groupId);

  return releaseGroupTables(groupId, createFreshSessions);
};
