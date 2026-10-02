import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";
import { resolveEmployeeId } from "../../lib/actors.js";
import { assertSessionActive, loadSessionContext, resolveSeatProof } from "../sessions/session-actor.js";

/**
 * Fixed reason codes a caller may attach to a waiter call, and their Spanish
 * panel labels.
 *
 * A `master_waiter_call_reasons` catalog table already exists (seeded with a
 * different, open-ended set of diner-facing reasons: "Necesito ayuda", "Pedir
 * la cuenta", etc. - managed generically by the admin catalog screens), but it
 * has no notion of a stable machine-readable code and doesn't distinguish a
 * cash payment request from a POS one. Rather than overload that catalog with
 * operational codes it wasn't designed for, this fixed set lives in code and
 * is stored as plain text in `custom_reason` (a column with no FK, already
 * unused by any client today). `reason_id` / the catalog table are untouched.
 */
export const WAITER_CALL_REASONS: Record<string, string> = {
  payment_cash: "Pedido de pago — Efectivo",
  payment_pos: "Pedido de pago — POS",
  supplies: "Salsas / cubiertos",
  help: "Consulta / ayuda",
};

const WAITER_CALL_REASON_CODES = new Set(Object.keys(WAITER_CALL_REASONS));

/** The Spanish label for a stored reason code, or null for a generic call. */
export const waiterCallReasonLabel = (code: string | null | undefined): string | null =>
  (code && WAITER_CALL_REASONS[code]) || null;

/** Free-text detail is capped defensively - this is diner-typed input with no client-side limit we control. */
const MAX_DETAIL_LENGTH = 500;

export type ParsedWaiterCallReason = {
  /** The fixed code (payment_cash/payment_pos/supplies/help), or null. */
  code: string | null;
  /** The Spanish label for `code`, or null for a generic/detail-only call. */
  label: string | null;
  /** Free-text elaboration the diner typed (all chosen reasons + their comment), or null. */
  detail: string | null;
};

/**
 * `waiter_calls` has exactly one spare text column (`custom_reason`), and now
 * needs to carry two independent things: the fixed reason code (drives
 * `reason_label`) and an optional free-text detail the diner typed. Both are
 * packed into that one column as a small JSON object. Rows written before
 * this change (and any row where only a code was ever given) are a bare code
 * string, not JSON - `JSON.parse` on those throws, so the catch path treats
 * the raw string as a legacy code with no detail. This keeps old rows and the
 * panel's existing `reason_label` reads working unchanged.
 */
export const parseWaiterCallReason = (raw: string | null | undefined): ParsedWaiterCallReason => {
  if (!raw) {
    return { code: null, label: null, detail: null };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const code = typeof record["code"] === "string" ? (record["code"] as string) : null;
      const detailRaw = typeof record["detail"] === "string" ? (record["detail"] as string).trim() : "";
      return { code, label: waiterCallReasonLabel(code), detail: detailRaw || null };
    }
  } catch {
    // Not JSON - legacy row written before free-text detail existed.
  }

  return { code: raw, label: waiterCallReasonLabel(raw), detail: null };
};

const encodeWaiterCallReason = (code: string | null, detail: string | null): string | null => {
  if (!code && !detail) return null;
  return JSON.stringify({ code, detail });
};

export const callWaiter = async (params: {
  sessionId: string;
  reason?: string;
  reason_id?: string;
  detail?: string;
  userId?: string;
  participantId?: string;
}): Promise<object> => {
  const { sessionId, reason, reason_id, userId, participantId } = params;

  if (reason !== undefined && !WAITER_CALL_REASON_CODES.has(reason)) {
    throw createError(
      `reason must be one of: ${[...WAITER_CALL_REASON_CODES].join(", ")}`,
      400,
      "INVALID_REASON",
    );
  }

  let detail: string | null = null;
  if (params.detail !== undefined) {
    if (typeof params.detail !== "string") {
      throw createError("detail must be a string", 400, "INVALID_DETAIL");
    }
    const trimmed = params.detail.trim();
    if (trimmed.length > MAX_DETAIL_LENGTH) {
      throw createError(`detail must be at most ${MAX_DETAIL_LENGTH} characters`, 400, "INVALID_DETAIL");
    }
    detail = trimmed || null;
  }

  // Same identity rule as placing an order: the anonymous web seat proves
  // itself with its own participant_id (it has no account to log into), the
  // app keeps proving itself with a JWT. Closed/missing session is refused
  // before identity is even considered.
  const session = await loadSessionContext(sessionId);
  assertSessionActive(session);

  const { data: tableRow, error: tableRowError } = await supabaseAdmin
    .from("table_sessions")
    .select("table_id, tables(branch_id)")
    .eq("id", sessionId)
    .single();

  if (tableRowError || !tableRow) {
    throw createError(tableRowError?.message ?? "Session not found", 404, "SESSION_NOT_FOUND");
  }

  const tableRowRecord = tableRow as Record<string, unknown>;
  const tableId = tableRowRecord["table_id"] as string | null;
  const table = tableRowRecord["tables"] as Record<string, unknown> | null;
  // table_sessions.branch_id is authoritative; fall back to the table's own
  // branch for older rows created before that column was backfilled.
  const branchId = session.branch_id ?? (table?.["branch_id"] as string | null) ?? null;

  // `called_by` is NOT NULL and is a FK to session_participants.id - the
  // diner's participant row in THIS session, not their auth user id.
  const seat = await resolveSeatProof({ sessionId, participantId, authUserId: userId });

  const { data: call, error: callError } = await supabaseAdmin
    .from("waiter_calls")
    .insert({
      session_id: sessionId,
      table_id: tableId,
      branch_id: branchId,
      called_by: seat.participantId,
      reason_id: reason_id ?? null,
      custom_reason: encodeWaiterCallReason(reason ?? null, detail),
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

    const parsedReason = parseWaiterCallReason(call["custom_reason"] as string | null);

    return {
      id: call["id"],
      table_number: table?.["table_number"] ?? null,
      // `waiter_calls` stores only `called_by` (a user id), no display name.
      participant_name: null,
      reason_id: call["reason_id"] ?? null,
      // Kept as the plain fixed code (never the raw JSON storage encoding) for backward compatibility.
      custom_reason: parsedReason.code,
      reason_label: parsedReason.label,
      // Free-text elaboration the diner typed (all chosen reasons + their comment), if any.
      reason_detail: parsedReason.detail,
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

  // attended_by and the mirrored restaurant_alerts.resolved_by /
  // acknowledged_by all identify a member of staff by employees.id, never by
  // the auth user id on req.user.id.
  const actorEmployeeId = await resolveEmployeeId(employeeId);

  const timestampField: Record<string, string> = {
    acknowledged: "acknowledged_at",
    resolved: "resolved_at",
  };

  const { data: call, error } = await supabaseAdmin
    .from("waiter_calls")
    .update({
      status,
      attended_by: actorEmployeeId,
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
        ? { status: "resolved", resolved_by: actorEmployeeId, resolved_at: now }
        : { status: "acknowledged", acknowledged_by: actorEmployeeId, acknowledged_at: now },
    )
    .eq("reference_id", callId)
    .eq("reference_type", "waiter_call")
    .eq("alert_type", "client_calling");

  return call;
};
