// src/config/supabase.ts
import { createClient } from "@supabase/supabase-js";

// src/config/env.ts
var required = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};
var env = {
  PORT: process.env["PORT"] ?? "3000",
  NODE_ENV: process.env["NODE_ENV"] ?? "development",
  SUPABASE_URL: required("SUPABASE_URL"),
  SUPABASE_ANON_KEY: required("SUPABASE_ANON_KEY"),
  SUPABASE_SERVICE_ROLE_KEY: required("SUPABASE_SERVICE_ROLE_KEY"),
  JWT_SECRET: required("JWT_SECRET")
};

// src/config/supabase.ts
var supabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY
);
var supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);
var supabaseAuth = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// src/middleware/errorHandler.ts
var createError = (message, statusCode, code, details) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
};

// src/lib/actors.ts
var resolveEmployeeId = async (authUserId) => {
  const { data, error } = await supabaseAdmin.from("employees").select("id").eq("auth_user_id", authUserId).eq("is_active", true).maybeSingle();
  if (error) {
    throw createError(error.message, 500, "EMPLOYEE_LOOKUP_FAILED");
  }
  const employeeId = data?.["id"];
  if (!employeeId) {
    throw createError(
      "No active employee record is linked to the signed-in user",
      403,
      "EMPLOYEE_NOT_FOUND"
    );
  }
  return employeeId;
};

// src/lib/session-credentials.ts
import { randomBytes, randomInt } from "node:crypto";
var PIN_ALPHABET = "BCDFGHJKLMNPRSTVWXYZ";
var PIN_LENGTH = 5;
var generatePin = () => {
  let pin = "";
  for (let i = 0; i < PIN_LENGTH; i += 1) {
    pin += PIN_ALPHABET[randomInt(0, PIN_ALPHABET.length)];
  }
  return pin;
};
var generateSessionToken = () => randomBytes(32).toString("base64url");
var generateUniquePin = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pin = generatePin();
    const [tableHit, sessionHit] = await Promise.all([
      supabaseAdmin.from("tables").select("id").eq("current_pin", pin).limit(1),
      supabaseAdmin.from("table_sessions").select("id").eq("pin", pin).eq("status", "active").limit(1)
    ]);
    if (tableHit.error || sessionHit.error) {
      throw createError(
        (tableHit.error ?? sessionHit.error).message,
        500,
        "PIN_LOOKUP_FAILED"
      );
    }
    if ((tableHit.data ?? []).length === 0 && (sessionHit.data ?? []).length === 0) {
      return pin;
    }
  }
  throw createError("Could not generate a free table PIN", 500, "PIN_GENERATION_FAILED");
};

// src/modules/table-groups/table-groups.service.ts
var createSessionForTable = async (table) => {
  const token = generateSessionToken();
  const pin = await generateUniquePin();
  const { error: sessionError } = await supabaseAdmin.from("table_sessions").insert({
    table_id: table.id,
    branch_id: table.branch_id,
    session_token: token,
    pin,
    status: "active",
    opened_at: (/* @__PURE__ */ new Date()).toISOString()
  });
  if (sessionError) {
    throw createError(sessionError.message, 500, "SESSION_CREATE_FAILED");
  }
  await supabaseAdmin.from("tables").update({ current_session_token: token, current_pin: pin }).eq("id", table.id);
};
var createTableGroup = async (params) => {
  const { branchId, tableIds, name, authUserId } = params;
  if (!Array.isArray(tableIds) || tableIds.length < 2) {
    throw createError("At least 2 table_ids are required", 400, "INVALID_TABLE_IDS");
  }
  const uniqueIds = [...new Set(tableIds)];
  if (uniqueIds.length !== tableIds.length) {
    throw createError("Duplicate table_ids provided", 400, "INVALID_TABLE_IDS");
  }
  const employeeId = await resolveEmployeeId(authUserId);
  const { data: tablesData, error: tablesError } = await supabaseAdmin.from("tables").select("id, branch_id, table_number, current_group_id").in("id", tableIds).eq("branch_id", branchId);
  if (tablesError) {
    throw createError(tablesError.message, 500, "FETCH_FAILED");
  }
  const tables = tablesData ?? [];
  if (tables.length !== tableIds.length) {
    throw createError(
      "One or more tables not found in this branch",
      400,
      "TABLES_NOT_IN_BRANCH"
    );
  }
  const alreadyGrouped = tables.filter((t) => t.current_group_id !== null);
  if (alreadyGrouped.length > 0) {
    throw createError(
      `Tables already in a group: ${alreadyGrouped.map((t) => t.table_number).join(", ")}`,
      409,
      "TABLES_ALREADY_GROUPED"
    );
  }
  const orderedTables = tableIds.map(
    (id) => tables.find((t) => t.id === id)
  );
  const { data: activeSessions2, error: sessionsError } = await supabaseAdmin.from("table_sessions").select("*").in("table_id", tableIds).eq("status", "active");
  if (sessionsError) {
    throw createError(sessionsError.message, 500, "FETCH_FAILED");
  }
  const sessionByTable = /* @__PURE__ */ new Map();
  for (const s of activeSessions2 ?? []) {
    sessionByTable.set(s.table_id, s);
  }
  const firstTable = orderedTables[0];
  let sharedSession = sessionByTable.get(firstTable.id) ?? null;
  if (!sharedSession) {
    const { data: newSession, error: newSessionError } = await supabaseAdmin.from("table_sessions").insert({
      table_id: firstTable.id,
      branch_id: branchId,
      session_token: generateSessionToken(),
      pin: await generateUniquePin(),
      status: "active",
      opened_at: (/* @__PURE__ */ new Date()).toISOString()
    }).select("*").single();
    if (newSessionError || !newSession) {
      throw createError(
        newSessionError?.message ?? "Failed to create shared session",
        500,
        "SESSION_CREATE_FAILED"
      );
    }
    sharedSession = newSession;
  }
  const sharedSessionId = sharedSession["id"];
  const groupName = name && name.trim().length > 0 ? name.trim() : `Mesas ${orderedTables.map((t) => t.table_number).sort((a, b) => a - b).join("-")}`;
  const { data: group, error: groupError } = await supabaseAdmin.from("table_groups").insert({
    branch_id: branchId,
    session_id: sharedSessionId,
    name: groupName,
    created_by: employeeId
  }).select("*").single();
  if (groupError || !group) {
    throw createError(
      groupError?.message ?? "Failed to create table group",
      500,
      "GROUP_CREATE_FAILED"
    );
  }
  const groupId = group.id;
  const { error: updateTablesError } = await supabaseAdmin.from("tables").update({ current_group_id: groupId }).in("id", tableIds);
  if (updateTablesError) {
    throw createError(updateTablesError.message, 500, "UPDATE_FAILED");
  }
  for (const table of orderedTables.slice(1)) {
    const ownSession = sessionByTable.get(table.id);
    if (!ownSession) continue;
    const ownSessionId = ownSession["id"];
    if (ownSessionId === sharedSessionId) continue;
    await supabaseAdmin.from("session_participants").update({ session_id: sharedSessionId }).eq("session_id", ownSessionId);
    await supabaseAdmin.from("orders").update({ session_id: sharedSessionId }).eq("session_id", ownSessionId);
    await supabaseAdmin.from("table_sessions").update({
      status: "closed",
      closed_at: (/* @__PURE__ */ new Date()).toISOString(),
      closed_by: employeeId
    }).eq("id", ownSessionId);
  }
  const { data: groupTables } = await supabaseAdmin.from("tables").select("*").eq("current_group_id", groupId);
  const { data: session } = await supabaseAdmin.from("table_sessions").select("*").eq("id", sharedSessionId).single();
  return {
    ...group,
    tables: groupTables ?? [],
    session: session ?? sharedSession
  };
};
var releaseGroupTables = async (groupId, createFreshSessions = true) => {
  const { data: tablesData, error: tablesError } = await supabaseAdmin.from("tables").select("id, branch_id, table_number, current_group_id").eq("current_group_id", groupId);
  if (tablesError) {
    throw createError(tablesError.message, 500, "FETCH_FAILED");
  }
  const tables = tablesData ?? [];
  const { error: clearError } = await supabaseAdmin.from("tables").update({ current_group_id: null }).eq("current_group_id", groupId);
  if (clearError) {
    throw createError(clearError.message, 500, "UPDATE_FAILED");
  }
  if (createFreshSessions) {
    const { data: stillOpen } = await supabaseAdmin.from("table_sessions").select("table_id").in("table_id", tables.map((t) => t.id)).eq("status", "active");
    const busy = new Set((stillOpen ?? []).map((r) => r["table_id"]));
    for (const table of tables) {
      if (busy.has(table.id)) continue;
      await createSessionForTable(table);
    }
  }
  return tables.map((t) => t.id);
};
var deleteTableGroup = async (groupId) => {
  const { data: group, error: groupError } = await supabaseAdmin.from("table_groups").select("*").eq("id", groupId).is("closed_at", null).maybeSingle();
  if (groupError) {
    throw createError(groupError.message, 500, "FETCH_FAILED");
  }
  if (!group) {
    throw createError("Active table group not found", 404, "GROUP_NOT_FOUND");
  }
  const { error: closeError } = await supabaseAdmin.from("table_groups").update({ closed_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", groupId);
  if (closeError) {
    throw createError(closeError.message, 500, "CLOSE_FAILED");
  }
  await releaseGroupTables(groupId);
};
var closeGroupForSession = async (sessionId, createFreshSessions = true) => {
  const { data: group } = await supabaseAdmin.from("table_groups").select("id").eq("session_id", sessionId).is("closed_at", null).maybeSingle();
  if (!group) return [];
  const groupId = group.id;
  await supabaseAdmin.from("table_groups").update({ closed_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", groupId);
  return releaseGroupTables(groupId, createFreshSessions);
};

// src/modules/payments/balance.service.ts
var gs = (value) => Math.round(value);
var orFail = (result, what) => {
  if (result.error) {
    throw createError(`Failed to read ${what}: ${result.error.message}`, 500, "BALANCE_READ_FAILED");
  }
  return result.data ?? [];
};
var computeSessionBalance = async (sessionId) => {
  const [orderResult, paymentResult] = await Promise.all([
    supabaseAdmin.from("orders").select("total_amount").eq("session_id", sessionId).neq("status", "cancelled"),
    supabaseAdmin.from("payments").select("amount, discount_amount, status, user_id, participant_id, banking_benefit_id").eq("session_id", sessionId)
  ]);
  const orders = orFail(orderResult, "orders");
  const payments = orFail(paymentResult, "payments");
  const total_ordered = gs(
    orders.reduce(
      (sum, o) => sum + (o["total_amount"] ?? 0),
      0
    )
  );
  const completed = payments.filter((p) => p.status === "completed");
  const total_paid = gs(completed.reduce((sum, p) => sum + (p.amount ?? 0), 0));
  const benefitIds = [
    ...new Set(
      completed.filter((p) => (p.discount_amount ?? 0) > 0 && p.banking_benefit_id).map((p) => p.banking_benefit_id)
    )
  ];
  let absorbedBenefitIds = /* @__PURE__ */ new Set();
  if (benefitIds.length > 0) {
    const benefits = orFail(
      await supabaseAdmin.from("banking_benefits").select("id, benefit_type").in("id", benefitIds),
      "banking benefits"
    );
    absorbedBenefitIds = new Set(
      benefits.filter((b) => b["benefit_type"] === "discount").map((b) => b["id"])
    );
  }
  const total_discount_absorbed = gs(
    completed.reduce(
      (sum, p) => p.banking_benefit_id && absorbedBenefitIds.has(p.banking_benefit_id) ? sum + (p.discount_amount ?? 0) : sum,
      0
    )
  );
  const settled = total_paid + total_discount_absorbed;
  const remaining = Math.max(0, gs(total_ordered - settled));
  const is_settled = remaining === 0;
  const pending_participant_count = is_settled ? 0 : await countPendingParticipants(sessionId, completed);
  return {
    total_ordered,
    total_paid,
    total_discount_absorbed,
    remaining,
    is_settled,
    pending_participant_count
  };
};
var countPendingParticipants = async (sessionId, completed) => {
  const distinctPayers = new Set(
    completed.map((p) => p.participant_id ?? p.user_id).filter((id) => Boolean(id))
  );
  const paidParticipantIds = new Set(
    completed.map((p) => p.participant_id).filter((id) => Boolean(id))
  );
  const paidUserIds = new Set(
    completed.map((p) => p.user_id).filter((id) => Boolean(id))
  );
  const [participantResult, linkResult, splitResult] = await Promise.all([
    supabaseAdmin.from("session_participants").select("id, user_id").eq("session_id", sessionId),
    supabaseAdmin.from("payment_links").select("id, expires_at").eq("session_id", sessionId).eq("status", "active"),
    supabaseAdmin.from("account_splits").select("id, split_method, total_participants").eq("session_id", sessionId).order("created_at", { ascending: false }).limit(1)
  ]);
  const roster = orFail(
    participantResult,
    "session participants"
  );
  const links = orFail(linkResult, "payment links");
  const splits = orFail(splitResult, "account splits");
  const now = Date.now();
  const openLinks = links.filter((l) => {
    const expiresAt = l["expires_at"];
    return !expiresAt || new Date(expiresAt).getTime() > now;
  }).length;
  const hasPaid = (p) => paidParticipantIds.has(p.id) || p.user_id !== null && paidUserIds.has(p.user_id);
  const unpaidRoster = roster.filter((p) => !hasPaid(p)).length;
  const split = splits[0];
  let owing;
  if (split?.split_method === "equal") {
    const expected = split.total_participants ?? roster.length;
    owing = Math.max(0, expected - distinctPayers.size);
  } else if (split?.split_method === "choose_mine") {
    const claims = orFail(
      await supabaseAdmin.from("claimed_items").select("participant_id").eq("split_id", split.id),
      "claimed items"
    );
    const claimants = new Set(
      claims.map((c) => c["participant_id"]).filter((id) => Boolean(id))
    );
    owing = claimants.size > 0 ? [...claimants].filter((id) => !paidParticipantIds.has(id)).length : unpaidRoster;
  } else {
    owing = unpaidRoster;
  }
  const pending = owing + openLinks;
  return pending > 0 ? pending : 1;
};

// src/lib/logger.ts
import pino from "pino";
var isProduction = process.env.NODE_ENV === "production";
var logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']"
  ],
  ...isProduction ? {} : {
    transport: {
      target: "pino-pretty",
      options: { colorize: true }
    }
  }
});

// src/modules/sessions/session-access.ts
var resolveAccessMethod = (branch) => {
  const raw = branch?.["access_method"];
  return raw === "qr" || raw === "pin" ? raw : "both";
};
var isEntryLocked = (session) => session?.["entry_locked"] === true;
var assertAccessMethodAllows = (accessMethod, method) => {
  if (accessMethod === "both") return;
  if (accessMethod === "qr" && method === "pin") {
    throw createError(
      "This restaurant only accepts joining by scanning the table QR",
      403,
      "PIN_ACCESS_DISABLED",
      { access_method: accessMethod }
    );
  }
  if (accessMethod === "pin" && method === "qr") {
    throw createError(
      "This restaurant only accepts joining with the table PIN",
      403,
      "QR_ACCESS_DISABLED",
      { access_method: accessMethod }
    );
  }
};
var assertEntryAllowed = (session, isKnownParticipant) => {
  if (isEntryLocked(session) && !isKnownParticipant) {
    throw createError(
      "This table is not accepting new diners right now",
      403,
      "ENTRY_LOCKED",
      { session_id: session?.["id"] ?? null }
    );
  }
};

// src/modules/sessions/sessions.service.ts
var openSessionForTable = async (table) => {
  const tableId = table["id"];
  const token = table["current_session_token"] ?? generateSessionToken();
  const pin = table["current_pin"] ?? await generateUniquePin();
  const { data, error } = await supabaseAdmin.from("table_sessions").insert({
    table_id: tableId,
    branch_id: table["branch_id"] ?? null,
    session_token: token,
    pin,
    status: "active",
    opened_at: (/* @__PURE__ */ new Date()).toISOString()
  }).select("*").single();
  if (error) {
    if (error.code === "23505") {
      const { data: winnerRow } = await supabaseAdmin.from("table_sessions").select("*").eq("table_id", tableId).eq("status", "active").order("created_at", { ascending: true }).limit(1);
      const winnerSession = (winnerRow ?? [])[0];
      if (winnerSession) return winnerSession;
    }
    throw createError(error.message, 500, "SESSION_CREATE_FAILED");
  }
  if (!data) {
    throw createError("Failed to create session", 500, "SESSION_CREATE_FAILED");
  }
  await supabaseAdmin.from("tables").update({ current_session_token: token, current_pin: pin }).eq("id", tableId);
  const { data: active } = await supabaseAdmin.from("table_sessions").select("*").eq("table_id", tableId).eq("status", "active").order("created_at", { ascending: true });
  const created = data;
  const winner = (active ?? [])[0];
  if (winner && winner["id"] !== created["id"]) {
    await supabaseAdmin.from("table_sessions").update({ status: "closed", closed_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", created["id"]);
    logger.warn(
      { table_id: tableId, kept_session_id: winner["id"], discarded_session_id: created["id"] },
      "two sessions opened for the same table at once; kept the first"
    );
    return winner;
  }
  return data;
};
var rotateTableCredentials = async (tableId, sessionId) => {
  const { data: tableRow2 } = await supabaseAdmin.from("tables").select("branch_id, qr_code_url").eq("id", tableId).maybeSingle();
  const branchId = tableRow2?.["branch_id"];
  const currentUrl = tableRow2?.["qr_code_url"];
  let lastMessage = "Failed to rotate table credentials";
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = generateSessionToken();
    const patch = {
      current_session_token: token,
      current_pin: await generateUniquePin()
    };
    if (branchId && currentUrl?.startsWith("/t/")) {
      patch["qr_code_url"] = `/t/${branchId}/${token}`;
    }
    const { error } = await supabaseAdmin.from("tables").update(patch).eq("id", tableId);
    if (!error) return;
    lastMessage = error.message;
  }
  throw createError(lastMessage, 500, "CLOSE_INCOMPLETE", {
    session_id: sessionId,
    table_id: tableId
  });
};
var isLiveSessionForTable = async (table, sessionId) => {
  const { data } = await supabaseAdmin.from("table_sessions").select("id").eq("table_id", table["id"]).eq("status", "active").order("created_at", { ascending: true }).limit(1);
  if ((data ?? [])[0]?.["id"] === sessionId) {
    return true;
  }
  const groupSession = await resolveGroupSession(table);
  return groupSession?.["id"] === sessionId;
};
var resolveTableForJoin = async (method, credential) => {
  const tableColumn = method === "qr" ? "current_session_token" : "current_pin";
  const { data: tables, error } = await supabaseAdmin.from("tables").select("*, branches(*, restaurants(*))").eq(tableColumn, credential).limit(2);
  if (error) {
    throw createError(error.message, 500, "TABLE_LOOKUP_FAILED");
  }
  if ((tables ?? []).length > 1) {
    throw createError(
      "That PIN matches more than one table; ask the staff for a new one",
      409,
      "AMBIGUOUS_CREDENTIAL"
    );
  }
  const table = (tables ?? [])[0];
  if (table) {
    return { table, session: null };
  }
  const sessionColumn = method === "qr" ? "session_token" : "pin";
  const { data: session } = await supabaseAdmin.from("table_sessions").select("*, tables(*, branches(*, restaurants(*)))").eq(sessionColumn, credential).eq("status", "active").maybeSingle();
  if (session) {
    const row = session;
    const sessionTable = row["tables"] ?? null;
    if (sessionTable && await isLiveSessionForTable(sessionTable, row["id"])) {
      return { table: sessionTable, session: row };
    }
  }
  return { table: null, session: null };
};
var findParticipant = async (sessionId, userId, webName) => {
  let query = supabaseAdmin.from("session_participants").select("*").eq("session_id", sessionId);
  query = userId ? query.eq("user_id", userId) : query.is("user_id", null).eq("web_name", webName ?? "");
  const { data, error } = await query.limit(1);
  if (error) {
    throw createError(error.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  }
  return (data ?? [])[0] ?? null;
};
var upsertParticipant = async (params) => {
  const { sessionId, method, platform, userId, name, existing } = params;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (existing) {
    const { data: data2, error: error2 } = await supabaseAdmin.from("session_participants").update({
      platform,
      connection_method: method,
      connected_at: now,
      disconnected_at: null
    }).eq("id", existing["id"]).select("*").single();
    if (error2 || !data2) {
      throw createError(error2?.message ?? "Failed to rejoin", 500, "PARTICIPANT_UPDATE_FAILED");
    }
    return data2;
  }
  const participantData = {
    session_id: sessionId,
    platform,
    connection_method: method,
    joined_at: now,
    connected_at: now
  };
  if (userId) {
    participantData["user_id"] = userId;
  } else {
    participantData["web_name"] = name;
  }
  const { data, error } = await supabaseAdmin.from("session_participants").insert(participantData).select("*").single();
  if (error) {
    if (error.code === "23505") {
      const raced = await findParticipant(sessionId, userId, name);
      if (raced) return raced;
    }
    throw createError(error.message, 500, "PARTICIPANT_CREATE_FAILED");
  }
  if (!data) {
    throw createError("Failed to create participant", 500, "PARTICIPANT_CREATE_FAILED");
  }
  return data;
};
var resolveGroupSession = async (table) => {
  const groupId = table["current_group_id"];
  if (!groupId) return null;
  const { data: group } = await supabaseAdmin.from("table_groups").select("session_id").eq("id", groupId).is("closed_at", null).maybeSingle();
  if (!group) return null;
  const { data: session } = await supabaseAdmin.from("table_sessions").select("*").eq("id", group.session_id).eq("status", "active").maybeSingle();
  return session ?? null;
};
var joinSession = async (params) => {
  const { token, pin, name, platform, userId } = params;
  if (!token && !pin) {
    throw createError("token or pin is required", 400, "MISSING_FIELDS");
  }
  if (!userId && !name) {
    throw createError("name is required for guest users", 400, "MISSING_FIELDS");
  }
  const method = token ? "qr" : "pin";
  const credential = token ?? pin;
  const { table, session: credentialSession } = await resolveTableForJoin(method, credential);
  if (!table) {
    throw createError("Invalid token or PIN", 404, "TABLE_NOT_FOUND");
  }
  const branch = table["branches"];
  assertAccessMethodAllows(resolveAccessMethod(branch), method);
  let session = credentialSession ?? await resolveGroupSession(table);
  let openedNow = false;
  if (!session) {
    const { data: existingSession } = await supabaseAdmin.from("table_sessions").select("*").eq("table_id", table["id"]).eq("status", "active").maybeSingle();
    if (existingSession) {
      session = existingSession;
    } else {
      session = await openSessionForTable(table);
      openedNow = true;
    }
  }
  const sessionId = session["id"];
  const existingParticipant = await findParticipant(sessionId, userId, name);
  assertEntryAllowed(session, Boolean(existingParticipant && userId));
  const participant = await upsertParticipant({
    sessionId,
    method,
    platform,
    userId,
    name,
    existing: existingParticipant
  });
  const { data: participants } = await supabaseAdmin.from("session_participants").select("*").eq("session_id", sessionId);
  const restaurant = branch?.["restaurants"];
  return {
    session_id: sessionId,
    session_opened_now: openedNow,
    joined_via: method,
    rejoined: Boolean(existingParticipant),
    table_number: table["table_number"] ?? null,
    branch: branch ? { id: branch["id"], name: branch["name"], address: branch["address"] } : null,
    restaurant_name: restaurant?.["name"] ?? null,
    participant_id: participant["id"],
    participants: participants ?? []
  };
};
var closeSession = async (sessionId, actorAuthUserId) => {
  const { data: session, error: sessionError } = await supabaseAdmin.from("table_sessions").select("id, table_id, branch_id, opened_at").eq("id", sessionId).eq("status", "active").single();
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
        pending_participant_count: balance.pending_participant_count
      }
    );
  }
  const employeeId = await resolveEmployeeId(actorAuthUserId);
  const tableId = session["table_id"];
  const closedAt = (/* @__PURE__ */ new Date()).toISOString();
  const { error: closeError } = await supabaseAdmin.from("table_sessions").update({ status: "closed", closed_at: closedAt, closed_by: employeeId }).eq("id", sessionId);
  if (closeError) {
    throw createError(closeError.message, 500, "CLOSE_FAILED");
  }
  const groupTableIds = await closeGroupForSession(sessionId, false);
  const freedTableIds = [.../* @__PURE__ */ new Set([tableId, ...groupTableIds])].filter(Boolean);
  if (freedTableIds.length > 0) {
    const { error: orphanError } = await supabaseAdmin.from("table_sessions").update({ status: "closed", closed_at: closedAt, closed_by: employeeId }).in("table_id", freedTableIds).eq("status", "active");
    if (orphanError) {
      throw createError(orphanError.message, 500, "CLOSE_INCOMPLETE", { session_id: sessionId });
    }
  }
  for (const freedTableId of freedTableIds) {
    await rotateTableCredentials(freedTableId, sessionId);
  }
  if (freedTableIds.length > 0) {
    const { data: lingering, error: verifyError } = await supabaseAdmin.from("table_sessions").select("id").in("table_id", freedTableIds).eq("status", "active");
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
            (s) => s["id"]
          )
        }
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
      opened_at: session["opened_at"] ?? null
    },
    new_value: {
      status: "closed",
      closed_at: closedAt,
      closed_by: employeeId,
      freed_table_ids: freedTableIds,
      total_ordered: balance.total_ordered,
      total_paid: balance.total_paid,
      total_discount_absorbed: balance.total_discount_absorbed
    },
    created_at: closedAt
  });
  if (auditError) {
    logger.error({ err: auditError, sessionId }, "close_session audit_log insert failed");
  }
};

// sectest.ts
var BRANCH_R = "22222222-2222-2222-2222-222222222222";
var MANAGER_AUTH = "fbae340a-e94f-4ed3-96d8-5327d9994929";
var USER_A = "f6f7ffdb-a93f-4239-9777-406824af5cf6";
var USER_B = "aa5c14a9-f1f7-4dd4-9bd0-bcc33fe27219";
var pass = 0;
var fail = 0;
var madeTables = [];
var madeGroups = [];
var check = (label, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}${detail ? " -> " + detail : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? " -> " + detail : ""}`);
  }
};
var expectCode = async (label, code, fn) => {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} -> no error thrown (expected ${code})`);
  } catch (e) {
    const err = e;
    if (err.code === code) {
      pass++;
      console.log(`PASS  ${label} -> ${err.statusCode} ${err.code}`);
    } else {
      fail++;
      console.log(`FAIL  ${label} -> expected ${code}, got ${err.statusCode} ${err.code}: ${err.message}`);
    }
  }
};
var mkTable = async (tableNumber) => {
  const token = generateSessionToken();
  const pin = generatePin();
  const { data, error } = await supabaseAdmin.from("tables").insert({
    branch_id: BRANCH_R,
    table_number: tableNumber,
    capacity: 4,
    current_session_token: token,
    current_pin: pin,
    qr_code_url: `/t/${BRANCH_R}/${token}`,
    is_active: true
  }).select("id").single();
  if (error) throw error;
  const id = data["id"];
  madeTables.push(id);
  return { id, tableNumber, token, pin };
};
var tableRow = async (id) => {
  const { data } = await supabaseAdmin.from("tables").select("current_session_token, current_pin, qr_code_url").eq("id", id).single();
  return data;
};
var activeSessions = async (tableId) => {
  const { data } = await supabaseAdmin.from("table_sessions").select("id, session_token, pin, status, opened_at, created_at").eq("table_id", tableId).eq("status", "active");
  return data ?? [];
};
var run = async () => {
  console.log("=== STEP 1: generators ===");
  console.log(`consonant set (${PIN_ALPHABET.length} letters): ${PIN_ALPHABET.split("").join(" ")}`);
  const pins = Array.from({ length: 6 }, () => generatePin());
  const tokens = Array.from({ length: 2 }, () => generateSessionToken());
  console.log("sample PINs:   " + pins.join("  "));
  console.log("sample tokens: " + tokens.join("\n               "));
  check("PINs are 5 consonants, no vowels", pins.every((p) => /^[BCDFGHJKLMNPRSTVWXYZ]{5}$/.test(p)));
  check("tokens are long and URL-safe", tokens.every((t) => t.length >= 40 && /^[A-Za-z0-9_-]+$/.test(t)), `${tokens[0].length} chars`);
  console.log("\n=== (a) join by PIN on a table with NO active session CREATES one ===");
  const t1 = await mkTable(901);
  console.log(`      test table #901 pin=${t1.pin} token=${t1.token.slice(0, 12)}...`);
  check("the table starts with no active session", (await activeSessions(t1.id)).length === 0);
  const joinA = await joinSession({ pin: t1.pin, platform: "web", userId: USER_A });
  console.log("      response: " + JSON.stringify(joinA, (k, v) => k === "participants" ? `[${v.length}]` : v));
  const openedRows = await activeSessions(t1.id);
  check("a session was created", openedRows.length === 1, openedRows[0]?.["id"]);
  check("it adopted the table's printed PIN and token", openedRows[0]?.["pin"] === t1.pin && openedRows[0]?.["session_token"] === t1.token);
  check("opened_at was set", Boolean(openedRows[0]?.["opened_at"]));
  check(
    "the response confirms table + branch + restaurant",
    joinA["table_number"] === 901 && Boolean(joinA["branch"]?.["name"]) && Boolean(joinA["restaurant_name"]),
    `Mesa ${joinA["table_number"]} de ${joinA["restaurant_name"]} (${joinA["branch"]?.["name"]})`
  );
  check("session_opened_now + joined_via are reported", joinA["session_opened_now"] === true && joinA["joined_via"] === "pin");
  console.log("\n=== (b) a second user joins the SAME session, nobody is duplicated ===");
  const joinB = await joinSession({ pin: t1.pin, platform: "app", userId: USER_B });
  check("second user got the same session", joinB["session_id"] === joinA["session_id"]);
  check("no second session was opened", (await activeSessions(t1.id)).length === 1);
  check("the table now has 2 participants", joinB["participants"].length === 2);
  const rejoin = await joinSession({ pin: t1.pin, platform: "web", userId: USER_A });
  check("the same user rejoining does not duplicate", rejoin["participants"].length === 2 && rejoin["participant_id"] === joinA["participant_id"]);
  check("the rejoin is reported as such", rejoin["rejoined"] === true);
  const guest1 = await joinSession({ pin: t1.pin, platform: "web", name: "Tio Cachito el Rapido" });
  const guest2 = await joinSession({ pin: t1.pin, platform: "web", name: "Tio Cachito el Rapido" });
  check("a guest joins by name and is not duplicated", guest2["participants"].length === 3 && guest2["participant_id"] === guest1["participant_id"]);
  console.log("\n=== the QR path opens a session from scratch too ===");
  const t2 = await mkTable(902);
  const joinQr = await joinSession({ token: t2.token, platform: "app", userId: USER_A });
  check("join by token created the session", joinQr["session_opened_now"] === true && (await activeSessions(t2.id)).length === 1);
  check("joined via qr", joinQr["joined_via"] === "qr");
  console.log("\n=== bad credentials ===");
  await expectCode("an unknown PIN is rejected", "TABLE_NOT_FOUND", () => joinSession({ pin: "ZZZZZ", platform: "web", userId: USER_A }));
  await expectCode("an unknown token is rejected", "TABLE_NOT_FOUND", () => joinSession({ token: "nope-nope-nope", platform: "web", userId: USER_A }));
  console.log("\n=== a stale active session is not a back door ===");
  const t3 = await mkTable(903);
  const stalePin = generatePin();
  const staleToken = generateSessionToken();
  const { data: staleRow } = await supabaseAdmin.from("table_sessions").insert({ table_id: t3.id, branch_id: BRANCH_R, session_token: staleToken, pin: stalePin, status: "active", opened_at: (/* @__PURE__ */ new Date()).toISOString() }).select("id").single();
  console.log(`      table #903 runs session ${staleRow["id"]}; a SECOND active session is then forced onto it`);
  const orphanPin = generatePin();
  await supabaseAdmin.from("table_sessions").insert({ table_id: t3.id, branch_id: BRANCH_R, session_token: generateSessionToken(), pin: orphanPin, status: "active", opened_at: (/* @__PURE__ */ new Date()).toISOString() });
  const live = await joinSession({ pin: stalePin, platform: "web", userId: USER_A });
  check("the table's live session still accepts its PIN", live["session_id"] === staleRow["id"]);
  await expectCode("the leftover session's PIN is refused", "TABLE_NOT_FOUND", () => joinSession({ pin: orphanPin, platform: "web", userId: USER_B }));
  console.log("\n=== (c) access_method and (d) entry_locked ===");
  console.log("      the columns do not exist yet (migration 20260908 is yours to run), so these");
  console.log("      run against the exact policy functions the join path calls:");
  check("a missing column means 'both' and unlocked", resolveAccessMethod({}) === "both");
  await expectCode("(c) access_method='qr' refuses a PIN join", "PIN_ACCESS_DISABLED", async () => assertAccessMethodAllows(resolveAccessMethod({ access_method: "qr" }), "pin"));
  await expectCode("     access_method='pin' refuses a QR join", "QR_ACCESS_DISABLED", async () => assertAccessMethodAllows(resolveAccessMethod({ access_method: "pin" }), "qr"));
  check("     access_method='both' allows either", (() => {
    assertAccessMethodAllows("both", "pin");
    assertAccessMethodAllows("both", "qr");
    return true;
  })());
  await expectCode("(d) entry_locked=true refuses a NEW diner", "ENTRY_LOCKED", async () => assertEntryAllowed({ entry_locked: true }, false));
  check("     entry_locked=true readmits an identified diner", (() => {
    assertEntryAllowed({ entry_locked: true }, true);
    return true;
  })());
  await expectCode("     a guest cannot claim a name to slip past the lock", "ENTRY_LOCKED", async () => assertEntryAllowed({ entry_locked: true }, Boolean(void 0)));
  console.log("\n=== (e) closing rotates BOTH token and PIN ===");
  const before = await tableRow(t1.id);
  const sessionId = joinA["session_id"];
  await closeSession(sessionId, MANAGER_AUTH);
  const after = await tableRow(t1.id);
  console.log(`      before: pin=${before["current_pin"]}  token=${before["current_session_token"].slice(0, 16)}...`);
  console.log(`      after:  pin=${after["current_pin"]}  token=${after["current_session_token"].slice(0, 16)}...`);
  console.log(`      qr_code_url after: ${after["qr_code_url"]}`);
  check("the PIN rotated", after["current_pin"] !== before["current_pin"]);
  check("the token rotated", after["current_session_token"] !== before["current_session_token"]);
  check("the new PIN has the new format", /^[BCDFGHJKLMNPRSTVWXYZ]{5}$/.test(after["current_pin"]), after["current_pin"]);
  check("the new token is long and URL-safe", after["current_session_token"].length >= 40 && /^[A-Za-z0-9_-]+$/.test(after["current_session_token"]));
  check("the stored QR link points at the new token", after["qr_code_url"] === `/t/${BRANCH_R}/${after["current_session_token"]}`);
  check("the table has no active session left", (await activeSessions(t1.id)).length === 0);
  await expectCode("the OLD pin opens nothing", "TABLE_NOT_FOUND", () => joinSession({ pin: t1.pin, platform: "web", userId: USER_A }));
  await expectCode("the OLD token opens nothing", "TABLE_NOT_FOUND", () => joinSession({ token: t1.token, platform: "web", userId: USER_A }));
  const reopened = await joinSession({ pin: after["current_pin"], platform: "web", userId: USER_A });
  check("the NEW pin opens a fresh session", reopened["session_opened_now"] === true && reopened["session_id"] !== sessionId);
  console.log("\n=== unmerging tables leaves one session per table ===");
  const g1 = await mkTable(911);
  const g2 = await mkTable(912);
  const created = await createTableGroup({ branchId: BRANCH_R, tableIds: [g1.id, g2.id], name: "Prueba", authUserId: MANAGER_AUTH });
  const groupId = created["id"] ?? created["group"]?.["id"];
  madeGroups.push(groupId);
  await deleteTableGroup(groupId);
  const a1 = await activeSessions(g1.id);
  const a2 = await activeSessions(g2.id);
  check("released table A runs exactly one session", a1.length === 1, `${a1.length}`);
  check("released table B runs exactly one session", a2.length === 1, `${a2.length}`);
  console.log("\n=== resulting rows ===");
  const { data: rows } = await supabaseAdmin.from("table_sessions").select("id, table_id, session_token, pin, status, opened_at, closed_at, closed_by").in("table_id", madeTables).order("opened_at", { ascending: true });
  for (const r of rows ?? []) {
    console.log(`  ${String(r["status"]).padEnd(6)} pin=${r["pin"]}  token=${String(r["session_token"]).slice(0, 14)}...  opened=${r["opened_at"]}  closed=${r["closed_at"] ?? "-"}`);
  }
  const sessionIds = (rows ?? []).map((r) => r["id"]);
  const { data: parts } = await supabaseAdmin.from("session_participants").select("session_id, user_id, web_name, connection_method, platform, joined_at").in("session_id", sessionIds);
  console.log("participants:");
  for (const p of parts ?? []) {
    console.log(`  ${p["connection_method"]}/${p["platform"]}  user=${String(p["user_id"] ?? "-").slice(0, 8)}  name=${p["web_name"] ?? "-"}  joined=${p["joined_at"]}`);
  }
  console.log("\nSAMPLE SESSION ROW:\n" + JSON.stringify((rows ?? [])[0], null, 2));
  console.log(`
RESULT: ${pass} passed, ${fail} failed`);
  console.log("\n=== cleanup ===");
  if (sessionIds.length) {
    await supabaseAdmin.from("session_participants").delete().in("session_id", sessionIds);
    await supabaseAdmin.from("audit_log").delete().in("reference_id", sessionIds);
    await supabaseAdmin.from("table_sessions").delete().in("id", sessionIds);
  }
  for (const gid of madeGroups) {
    await supabaseAdmin.from("table_group_members").delete().eq("group_id", gid);
    await supabaseAdmin.from("audit_log").delete().eq("reference_id", gid);
    await supabaseAdmin.from("table_groups").delete().eq("id", gid);
  }
  await supabaseAdmin.from("tables").delete().in("id", madeTables);
  const { data: leftTables } = await supabaseAdmin.from("tables").select("id").in("id", madeTables);
  const { data: leftSessions } = await supabaseAdmin.from("table_sessions").select("id").in("table_id", madeTables);
  const { data: leftParts } = sessionIds.length ? await supabaseAdmin.from("session_participants").select("id").in("session_id", sessionIds) : { data: [] };
  const { data: leftGroups } = madeGroups.length ? await supabaseAdmin.from("table_groups").select("id").in("id", madeGroups) : { data: [] };
  console.log("leftover rows (all must be 0): " + JSON.stringify({
    tables: (leftTables ?? []).length,
    sessions: (leftSessions ?? []).length,
    participants: (leftParts ?? []).length,
    groups: (leftGroups ?? []).length
  }));
};
run().catch((e) => {
  console.error("RUNNER CRASHED", e);
  process.exit(1);
});
