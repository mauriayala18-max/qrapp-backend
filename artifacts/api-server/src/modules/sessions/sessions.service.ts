import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

const generateToken = () =>
  Math.random().toString(36).substring(2, 12).toUpperCase();

const generatePin = () =>
  Math.floor(1000 + Math.random() * 9000).toString();

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
    const { data: existingSession } = await supabaseAdmin
      .from("table_sessions")
      .select("*")
      .eq("table_id", table.id)
      .eq("status", "active")
      .maybeSingle();

    if (existingSession) {
      session = existingSession;
    } else {
      const { data: newSession, error: sessionError } = await supabaseAdmin
        .from("table_sessions")
        .insert({ table_id: table.id, status: "active", started_at: new Date().toISOString() })
        .select("*")
        .single();

      if (sessionError || !newSession) {
        throw createError(sessionError?.message ?? "Failed to create session", 500, "SESSION_CREATE_FAILED");
      }
      session = newSession;
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

  let session = null;
  const { data: existingSession } = await supabaseAdmin
    .from("table_sessions")
    .select("*")
    .eq("table_id", table.id)
    .eq("status", "active")
    .maybeSingle();

  if (existingSession) {
    session = existingSession;
  } else {
    const { data: newSession, error: sessionError } = await supabaseAdmin
      .from("table_sessions")
      .insert({ table_id: table.id, status: "active", started_at: new Date().toISOString() })
      .select("*")
      .single();

    if (sessionError || !newSession) {
      throw createError("Failed to create session", 500, "SESSION_CREATE_FAILED");
    }
    session = newSession;
  }

  const participantData: Record<string, unknown> = {
    session_id: session.id,
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
    supabaseAdmin.from("session_participants").select("*").eq("session_id", session.id),
    supabaseAdmin
      .from("orders")
      .select("*, order_items(*, order_item_modifications(*))")
      .eq("session_id", session.id)
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
      id: session.id,
      status: session.status,
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

export const closeSession = async (sessionId: string, employeeId: string): Promise<void> => {
  const { data: session, error: sessionError } = await supabaseAdmin
    .from("table_sessions")
    .select("*, orders(total_amount), payments(amount)")
    .eq("id", sessionId)
    .eq("status", "active")
    .single();

  if (sessionError || !session) {
    throw createError("Active session not found", 404, "SESSION_NOT_FOUND");
  }

  const orders = (session as Record<string, unknown>)["orders"] as Array<{ total_amount: number }> ?? [];
  const payments = (session as Record<string, unknown>)["payments"] as Array<{ amount: number }> ?? [];

  const totalOrders = orders.reduce((sum, o) => sum + (o.total_amount ?? 0), 0);
  const totalPayments = payments.reduce((sum, p) => sum + (p.amount ?? 0), 0);

  if (Math.abs(totalOrders - totalPayments) > 0.01) {
    throw createError(
      "Cannot close session: pending payments remain",
      400,
      "PENDING_PAYMENTS",
    );
  }

  const tableId = (session as Record<string, unknown>)["table_id"] as string;

  const { error: closeError } = await supabaseAdmin
    .from("table_sessions")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: employeeId,
    })
    .eq("id", sessionId);

  if (closeError) {
    throw createError(closeError.message, 500, "CLOSE_FAILED");
  }

  await supabaseAdmin
    .from("tables")
    .update({
      current_session_token: generateToken(),
      current_pin: generatePin(),
    })
    .eq("id", tableId);
};
