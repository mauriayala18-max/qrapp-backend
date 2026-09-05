import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";

export const callWaiter = async (params: {
  sessionId: string;
  reason_id?: string;
  custom_reason?: string;
  userId?: string;
  participantName?: string;
}): Promise<object> => {
  const { sessionId, reason_id, custom_reason, userId } = params;

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("table_sessions")
    .select("id, table_id, branch_id, tables(branch_id)")
    .eq("id", sessionId)
    .eq("status", "active")
    .single();

  if (sessionError || !session) {
    throw createError("Active session not found", 404, "SESSION_NOT_FOUND");
  }

  const sessionRow = session as Record<string, unknown>;
  const table = sessionRow["tables"] as Record<string, unknown> | null;
  const tableId = sessionRow["table_id"] as string | null;
  const branchId =
    (sessionRow["branch_id"] as string | null) ?? (table?.["branch_id"] as string | null) ?? null;

  // `called_by` is NOT NULL: a guest with no account cannot raise a call.
  if (!userId) {
    throw createError("A signed-in user is required to call the waiter", 401, "UNAUTHORIZED");
  }

  const { data: call, error: callError } = await supabaseAdmin
    .from("waiter_calls")
    .insert({
      session_id: sessionId,
      table_id: tableId,
      branch_id: branchId,
      called_by: userId,
      reason_id: reason_id ?? null,
      custom_reason: custom_reason ?? null,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (callError || !call) {
    throw createError(callError?.message ?? "Failed to create waiter call", 500, "CALL_CREATE_FAILED");
  }

  const callId = (call as Record<string, unknown>)["id"] as string;

  // The column is `alert_type` (not `type`) and the allowed statuses are
  // pending / acknowledged / resolved (not unread / read).
  const { error: alertError } = await supabaseAdmin.from("restaurant_alerts").insert({
    branch_id: branchId,
    alert_type: "client_calling",
    reference_type: "waiter_call",
    reference_id: callId,
    recipient_role: "waiter",
    status: "pending",
    created_at: new Date().toISOString(),
  });

  if (alertError) {
    logger.error(
      { err: alertError, sessionId, callId },
      "client_calling alert insert failed (the waiter call itself was created)",
    );
  }

  return {
    call_id: (call as Record<string, unknown>)["id"],
    status: "pending",
  };
};

export const getBranchWaiterCalls = async (branchId: string): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("waiter_calls")
    .select(
      "*, table_sessions(tables(table_number, branch_id))",
    )
    .in("status", ["pending", "acknowledged"])
    .order("created_at", { ascending: true });

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const filtered = (data ?? []).filter((call: Record<string, unknown>) => {
    const session = call["table_sessions"] as Record<string, unknown> | null;
    const table = session?.["tables"] as Record<string, unknown> | null;
    return table?.["branch_id"] === branchId;
  });

  return filtered.map((call: Record<string, unknown>) => {
    const createdAt = new Date(call["created_at"] as string).getTime();
    const elapsed = Math.floor((Date.now() - createdAt) / 1000);
    const session = call["table_sessions"] as Record<string, unknown> | null;
    const table = session?.["tables"] as Record<string, unknown> | null;

    return {
      id: call["id"],
      table_number: table?.["table_number"] ?? null,
      // `waiter_calls` stores only `called_by` (a user id), no display name.
      participant_name: null,
      reason_id: call["reason_id"] ?? null,
      custom_reason: call["custom_reason"] ?? null,
      status: call["status"],
      elapsed_seconds: elapsed,
      created_at: call["created_at"],
    };
  });
};

export const updateWaiterCall = async (params: {
  callId: string;
  status: "acknowledged" | "resolved";
  employeeId: string;
}): Promise<object> => {
  const { callId, status, employeeId } = params;

  const timestampField: Record<string, string> = {
    acknowledged: "acknowledged_at",
    resolved: "resolved_at",
  };

  const { data: call, error } = await supabaseAdmin
    .from("waiter_calls")
    .update({
      status,
      attended_by: employeeId,
      [timestampField[status]]: new Date().toISOString(),
    })
    .eq("id", callId)
    .select("*")
    .single();

  if (error || !call) {
    throw createError(error?.message ?? "Waiter call not found", 404, "CALL_NOT_FOUND");
  }

  const now = new Date().toISOString();
  await supabaseAdmin
    .from("restaurant_alerts")
    .update(
      status === "resolved"
        ? { status: "resolved", resolved_by: employeeId, resolved_at: now }
        : { status: "acknowledged", acknowledged_by: employeeId, acknowledged_at: now },
    )
    .eq("reference_id", callId)
    .eq("reference_type", "waiter_call")
    .eq("alert_type", "client_calling");

  return call;
};
