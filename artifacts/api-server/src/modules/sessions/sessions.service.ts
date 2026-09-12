import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { closeGroupForSession } from "../table-groups/table-groups.service.js";
import { computeSessionBalance } from "../payments/balance.service.js";
import { logger } from "../../lib/logger.js";
import { resolveEmployeeId } from "../../lib/actors.js";
import { generateSessionToken, generateUniquePin } from "../../lib/session-credentials.js";
import {
  assertAccessMethodAllows,
  assertEntryAllowed,
  resolveAccessMethod,
  type JoinMethod,
} from "./session-access.js";
import { assertNotExpelled } from "../expulsions/expulsion-guard.js";

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
  const token = (table["current_session_token"] as string | null) ?? generateSessionToken();
  const pin = (table["current_pin"] as string | null) ?? (await generateUniquePin());

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

  if (error) {
    // Once the partial unique index is in place the database itself settles a
    // simultaneous open: the loser reads the winner's session.
    if (error.code === "23505") {
      const { data: winnerRow } = await supabaseAdmin
        .from("table_sessions")
        .select("*")
        .eq("table_id", tableId)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1);

      const winnerSession = (winnerRow ?? [])[0] as { id: string; [key: string]: unknown } | undefined;
      if (winnerSession) return winnerSession;
    }

    throw createError(error.message, 500, "SESSION_CREATE_FAILED");
  }

  if (!data) {
    throw createError("Failed to create session", 500, "SESSION_CREATE_FAILED");
  }

  await supabaseAdmin
    .from("tables")
    .update({ current_session_token: token, current_pin: pin })
    .eq("id", tableId);

  // Two diners can reach the same free table in the same instant. Whoever
  // inserted first owns it: the loser closes the session it just opened and
  // returns the winner's, so a table never ends up with two active sessions.
  const { data: active } = await supabaseAdmin
    .from("table_sessions")
    .select("*")
    .eq("table_id", tableId)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  const created = data as Record<string, unknown>;
  const winner = (active ?? [])[0] as Record<string, unknown> | undefined;

  if (winner && winner["id"] !== created["id"]) {
    await supabaseAdmin
      .from("table_sessions")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", created["id"] as string);

    logger.warn(
      { table_id: tableId, kept_session_id: winner["id"], discarded_session_id: created["id"] },
      "two sessions opened for the same table at once; kept the first",
    );

    return winner as { id: string; [key: string]: unknown };
  }

  return data as { id: string; [key: string]: unknown };
};

/**
 * Give a freed table a brand new token and PIN, so nothing screenshotted or
 * remembered from the previous party can reach the next one.
 *
 * qr_code_url is deliberately NOT touched: the sticker on the table encodes a
 * permanent /t/{table_id} link and the server resolves the live session behind
 * it. Rotating that URL would kill printed stickers on every close. Retried
 * once, because a table left holding closed-session credentials is worse than
 * a slow close.
 */
const rotateTableCredentials = async (tableId: string, sessionId: string): Promise<void> => {
  let lastMessage = "Failed to rotate table credentials";

  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await supabaseAdmin
      .from("tables")
      .update({
        current_session_token: generateSessionToken(),
        current_pin: await generateUniquePin(),
      })
      .eq("id", tableId);

    if (!error) return;
    lastMessage = error.message;
  }

  throw createError(lastMessage, 500, "CLOSE_INCOMPLETE", {
    session_id: sessionId,
    table_id: tableId,
  });
};

/**
 * Is this session the one the table is actually running right now - either its
 * own oldest active session, or the shared session of the group it belongs to?
 */
const isLiveSessionForTable = async (
  table: Record<string, unknown>,
  sessionId: string,
): Promise<boolean> => {
  const { data } = await supabaseAdmin
    .from("table_sessions")
    .select("id")
    .eq("table_id", table["id"] as string)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1);

  if (((data ?? [])[0] as Record<string, unknown> | undefined)?.["id"] === sessionId) {
    return true;
  }

  const groupSession = await resolveGroupSession(table);
  return groupSession?.["id"] === sessionId;
};

/**
 * Seat a diner at a table: enforce the branch's entry rules, find or open the
 * table's session, and add the diner to it exactly once.
 *
 * Every entry point funnels through here - PIN, permanent QR sticker, and the
 * legacy token scan - so the rules cannot drift apart between them.
 */
const enterTableSession = async (params: {
  table: Record<string, unknown>;
  method: JoinMethod;
  platform: "app" | "web";
  userId?: string;
  name?: string;
  knownSession?: Record<string, unknown> | null;
}): Promise<{
  session: Record<string, unknown>;
  participant: Record<string, unknown>;
  participants: Array<Record<string, unknown>>;
  openedNow: boolean;
  confirmation: Record<string, unknown>;
}> => {
  const { table, method, platform, userId, name, knownSession } = params;

  const branch = table["branches"] as Record<string, unknown> | null;

  // The restaurant decides whether diners come in by QR, by PIN, or either.
  assertAccessMethodAllows(resolveAccessMethod(branch), method);

  // Grouped tables share the group's session.
  let session = knownSession ?? (await resolveGroupSession(table));
  let openedNow = false;

  if (!session) {
    const { data: existingSession } = await supabaseAdmin
      .from("table_sessions")
      .select("*")
      .eq("table_id", table["id"] as string)
      .eq("status", "active")
      .maybeSingle();

    if (existingSession) {
      session = existingSession as Record<string, unknown>;
    } else {
      // An empty table opens its session on the first diner, adopting the
      // credentials the table already carries.
      session = await openSessionForTable(table);
      openedNow = true;
    }
  }

  const sessionId = session["id"] as string;

  // A diner who was expelled from THIS session does not get back in, by QR or
  // by PIN. Checked before the participant row is touched, because rejoining
  // would otherwise just revive it.
  await assertNotExpelled({ sessionId, userId, webName: name });

  const existingParticipant = await findParticipant(sessionId, userId, name);

  // Staff can seal a table; the diners already inside keep their access. A
  // guest's typed name is not proof of being one of them, so only an
  // authenticated diner can be readmitted to a locked table.
  assertEntryAllowed(session, Boolean(existingParticipant && userId));

  const participant = await upsertParticipant({
    sessionId,
    method,
    platform,
    userId,
    name,
    existing: existingParticipant,
  });

  // Checked again, now that the seat exists. An expulsion that landed between
  // the first check and this write would otherwise be undone by the revived
  // participant row, so the seat is taken away again before answering.
  try {
    await assertNotExpelled({ sessionId, userId, webName: name });
  } catch (err) {
    await supabaseAdmin
      .from("session_participants")
      .update({ disconnected_at: new Date().toISOString() })
      .eq("id", participant["id"] as string)
      .is("disconnected_at", null);

    throw err;
  }

  const { data: participantRows } = await supabaseAdmin
    .from("session_participants")
    .select("*")
    .eq("session_id", sessionId);

  const participants = (participantRows ?? []) as Array<Record<string, unknown>>;
  const restaurant = branch?.["restaurants"] as Record<string, unknown> | null;

  return {
    session,
    participant,
    participants,
    openedNow,
    confirmation: {
      session_id: sessionId,
      session_opened_now: openedNow,
      joined_via: method,
      rejoined: Boolean(existingParticipant),
      table_id: table["id"],
      table_number: table["table_number"] ?? null,
      branch: branch
        ? { id: branch["id"], name: branch["name"], address: branch["address"] }
        : null,
      restaurant_name: restaurant?.["name"] ?? null,
      participant_id: participant["id"],
      participants,
    },
  };
};

/**
 * Resolve the table a diner is trying to reach.
 *
 * The QR token and the PIN are two names for the same table: both live on the
 * table row (`current_session_token` / `current_pin`) and survive between
 * sessions. Resolving them against the TABLE rather than against an active
 * session is what lets the first diner of the night open one from scratch -
 * the old PIN path only ever queried active sessions, so an empty table
 * answered "invalid PIN". The active session is still consulted as a fallback,
 * because a grouped table's shared session carries its own credentials.
 */
const resolveTableForJoin = async (
  method: JoinMethod,
  credential: string,
): Promise<{
  table: Record<string, unknown> | null;
  session: Record<string, unknown> | null;
}> => {
  const tableColumn = method === "qr" ? "current_session_token" : "current_pin";

  const { data: tables, error } = await supabaseAdmin
    .from("tables")
    .select("*, branches(*, restaurants(*))")
    .eq(tableColumn, credential)
    .limit(2);

  if (error) {
    throw createError(error.message, 500, "TABLE_LOOKUP_FAILED");
  }

  if ((tables ?? []).length > 1) {
    // Never guess which table the diner meant.
    throw createError(
      "That PIN matches more than one table; ask the staff for a new one",
      409,
      "AMBIGUOUS_CREDENTIAL",
    );
  }

  const table = (tables ?? [])[0] as Record<string, unknown> | undefined;

  if (table) {
    return { table, session: null };
  }

  const sessionColumn = method === "qr" ? "session_token" : "pin";

  const { data: session } = await supabaseAdmin
    .from("table_sessions")
    .select("*, tables(*, branches(*, restaurants(*)))")
    .eq(sessionColumn, credential)
    .eq("status", "active")
    .maybeSingle();

  if (session) {
    const row = session as Record<string, unknown>;
    const sessionTable = (row["tables"] as Record<string, unknown> | null) ?? null;

    // Only a table's live session - or its group's shared one - may be reached
    // this way. A stale active session whose credentials nobody rotated must
    // not keep letting diners in behind the table's back.
    if (sessionTable && (await isLiveSessionForTable(sessionTable, row["id"] as string))) {
      return { table: sessionTable, session: row };
    }
  }

  return { table: null, session: null };
};

/**
 * The participant row for this diner in this session, if they already have
 * one. Authenticated diners are matched by user id; guests by the name they
 * typed, so reopening the page does not fill the table with clones of them.
 */
const findParticipant = async (
  sessionId: string,
  userId?: string,
  webName?: string,
): Promise<Record<string, unknown> | null> => {
  let query = supabaseAdmin
    .from("session_participants")
    .select("*")
    .eq("session_id", sessionId);

  query = userId
    ? query.eq("user_id", userId)
    : query.is("user_id", null).eq("web_name", webName ?? "");

  const { data, error } = await query.limit(1);

  if (error) {
    throw createError(error.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  }

  return ((data ?? [])[0] as Record<string, unknown> | undefined) ?? null;
};

/**
 * Add the diner to the session, or bring their existing row back to life.
 * Rejoining is not a new seat at the table.
 */
const upsertParticipant = async (params: {
  sessionId: string;
  method: JoinMethod;
  platform: "app" | "web";
  userId?: string;
  name?: string;
  existing: Record<string, unknown> | null;
}): Promise<Record<string, unknown>> => {
  const { sessionId, method, platform, userId, name, existing } = params;
  const now = new Date().toISOString();

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from("session_participants")
      .update({
        platform,
        connection_method: method,
        connected_at: now,
        disconnected_at: null,
      })
      .eq("id", existing["id"] as string)
      .select("*")
      .single();

    if (error || !data) {
      throw createError(error?.message ?? "Failed to rejoin", 500, "PARTICIPANT_UPDATE_FAILED");
    }

    return data as Record<string, unknown>;
  }

  const participantData: Record<string, unknown> = {
    session_id: sessionId,
    platform,
    connection_method: method,
    joined_at: now,
    connected_at: now,
  };

  if (userId) {
    participantData["user_id"] = userId;
  } else {
    participantData["web_name"] = name;
  }

  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .insert(participantData)
    .select("*")
    .single();

  if (error) {
    // Two devices joining in the same instant: the unique index rejects the
    // loser, whose row now exists anyway. Read it back instead of failing a
    // join that effectively succeeded.
    if (error.code === "23505") {
      const raced = await findParticipant(sessionId, userId, name);
      if (raced) return raced;
    }

    throw createError(error.message, 500, "PARTICIPANT_CREATE_FAILED");
  }

  if (!data) {
    throw createError("Failed to create participant", 500, "PARTICIPANT_CREATE_FAILED");
  }

  return data as Record<string, unknown>;
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

  const method: JoinMethod = token ? "qr" : "pin";
  const credential = (token ?? pin) as string;

  const { table, session: credentialSession } = await resolveTableForJoin(method, credential);

  if (!table) {
    throw createError("Invalid token or PIN", 404, "TABLE_NOT_FOUND");
  }

  const { confirmation } = await enterTableSession({
    table,
    method,
    platform,
    userId,
    name,
    knownSession: credentialSession,
  });

  return confirmation;
};

/**
 * Scan of the permanent QR sticker: the URL carries only the table id, and the
 * server resolves whatever session that table is running right now - or opens
 * one if the table is free. No PIN prompt: QR and PIN are two doors into the
 * same session, and the camera is the fast one.
 */
export const scanTable = async (params: {
  tableId: string;
  platform: "app" | "web";
  name?: string;
  userId?: string;
}): Promise<object> => {
  const { tableId, platform, name, userId } = params;

  if (!userId && !name) {
    throw createError("name is required for guest users", 400, "MISSING_FIELDS");
  }

  const { data: table, error } = await supabaseAdmin
    .from("tables")
    .select("*, branches(*, restaurants(*))")
    .eq("id", tableId)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !table) {
    throw createError("Table not found", 404, "TABLE_NOT_FOUND");
  }

  const { confirmation } = await enterTableSession({
    table: table as Record<string, unknown>,
    method: "qr",
    platform,
    userId,
    name,
  });

  return confirmation;
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

  const { session: enteredSession, participants: sessionParticipants } = await enterTableSession({
    table: table as Record<string, unknown>,
    method: "qr",
    platform,
    userId,
    name,
  });

  const activeSession = enteredSession as unknown as { id: string; status: string };

  const branch = (table as Record<string, unknown>)["branches"] as Record<string, unknown> | null;
  const restaurant = branch?.["restaurants"] as Record<string, unknown> | null;
  const branchId = branch?.["id"] as string | undefined;

  const [
    { data: orders },
    { data: categories },
    { data: promotions },
  ] = await Promise.all([
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
    participants: sessionParticipants,
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

/**
 * The list of diners currently at a table.
 *
 * Only ACTIVE participants (disconnected_at IS NULL) are returned - someone
 * who already left is not "at the table" for staff or fellow diners looking at
 * the roster. Authorization is the caller's job (see session-actor.ts);
 * this function assumes it has already run.
 */
export const getParticipants = async (
  sessionId: string,
): Promise<{
  session_id: string;
  total: number;
  participants: Array<{
    participant_id: string;
    display_name: string;
    is_registered_user: boolean;
    connection_method: string | null;
    joined_at: string | null;
  }>;
}> => {
  const { data, error } = await supabaseAdmin
    .from("session_participants")
    .select("id, user_id, web_name, connection_method, joined_at")
    .eq("session_id", sessionId)
    .is("disconnected_at", null);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const userIds = [...new Set(rows.map((r) => r["user_id"] as string | null).filter((id): id is string => Boolean(id)))];

  const namesByUserId = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users, error: usersError } = await supabaseAdmin
      .from("users")
      .select("id, full_name")
      .in("id", userIds);

    if (usersError) {
      throw createError(usersError.message, 500, "USER_LOOKUP_FAILED");
    }

    for (const u of (users ?? []) as Array<Record<string, unknown>>) {
      const fullName = u["full_name"] as string | null;
      if (fullName) namesByUserId.set(u["id"] as string, fullName);
    }
  }

  const participants = rows.map((row) => {
    const userId = row["user_id"] as string | null;
    const webName = row["web_name"] as string | null;
    const displayName = (userId ? namesByUserId.get(userId) : null) ?? webName ?? "Invitado";

    return {
      participant_id: row["id"] as string,
      display_name: displayName,
      is_registered_user: Boolean(userId),
      connection_method: (row["connection_method"] as string | null) ?? null,
      joined_at: (row["joined_at"] as string | null) ?? null,
    };
  });

  return {
    session_id: sessionId,
    total: participants.length,
    participants,
  };
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
    await rotateTableCredentials(freedTableId, sessionId);
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
