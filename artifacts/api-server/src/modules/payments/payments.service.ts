import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";
import { computeSessionBalance } from "./balance.service.js";
import { closeSession } from "../sessions/sessions.service.js";

/** `branches` has no short_name column - derive a stable prefix from the name. */
const branchShortCode = (branchName?: string | null): string => {
  const cleaned = (branchName ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 4) : "QR";
};

const assertSessionExists = async (sessionId: string): Promise<void> => {
  const { data } = await supabaseAdmin
    .from("table_sessions")
    .select("id")
    .eq("id", sessionId)
    .maybeSingle();

  if (!data) {
    throw createError("Session not found", 404, "SESSION_NOT_FOUND");
  }
};

/**
 * Reported back on the payment response so a failed alert is visible to the
 * caller instead of dying in the server log.
 */
export type WaiterAlertOutcome =
  | { created: true; alert_id: string; recipient_employee_id: string | null }
  | { created: false; code: string | null; message: string; hint: string };

/**
 * A completed DIGITAL payment (card / apple_pay / google_pay) raises a
 * `payment_received` alert for the waiter. Cash and POS are handed to an
 * employee in person, so they raise nothing.
 *
 * `payment_received` must be permitted by the
 * `restaurant_alerts_alert_type_check` CHECK constraint - see
 * artifacts/api-server/migrations/. Until that runs, Postgres rejects the row
 * with SQLSTATE 23514. A failing alert must never roll back a payment that
 * already succeeded, so the failure is returned, never thrown.
 */
const notifyWaiterOfDigitalPayment = async (params: {
  sessionId: string;
  branchId: string | null;
  tableId: string | null;
  paymentId: string;
}): Promise<WaiterAlertOutcome> => {
  const { sessionId, branchId, tableId, paymentId } = params;

  let assignedWaiterId: string | null = null;
  if (tableId) {
    const { data: assignment } = await supabaseAdmin
      .from("table_waiter_assignments")
      .select("employee_id")
      .eq("table_id", tableId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    assignedWaiterId =
      ((assignment as Record<string, unknown> | null)?.["employee_id"] as string | undefined) ??
      null;
  }

  // restaurant_alerts.branch_id is NOT NULL, so never rely on the caller
  // having resolved it.
  let resolvedBranchId = branchId;
  if (!resolvedBranchId) {
    const { data: sessionRow } = await supabaseAdmin
      .from("table_sessions")
      .select("branch_id, tables(branch_id)")
      .eq("id", sessionId)
      .maybeSingle();

    const row = sessionRow as Record<string, unknown> | null;
    resolvedBranchId =
      (row?.["branch_id"] as string | null) ??
      ((row?.["tables"] as Record<string, unknown> | null)?.["branch_id"] as string | null) ??
      null;
  }

  if (!resolvedBranchId) {
    const outcome: WaiterAlertOutcome = {
      created: false,
      code: "BRANCH_UNRESOLVED",
      message: "Could not resolve branch_id for the session",
      hint: "restaurant_alerts.branch_id is NOT NULL; the session has no branch and no table branch.",
    };
    logger.error({ sessionId, paymentId }, "payment_received alert skipped: no branch_id");
    return outcome;
  }

  const { data, error } = await supabaseAdmin
    .from("restaurant_alerts")
    .insert({
      branch_id: resolvedBranchId,
      alert_type: "payment_received",
      reference_type: "session",
      reference_id: sessionId,
      recipient_role: "waiter",
      recipient_employee_id: assignedWaiterId,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    const code = (error as { code?: string } | null)?.code ?? null;
    const hint =
      code === "23514"
        ? "The restaurant_alerts_alert_type_check constraint still rejects 'payment_received'. Run artifacts/api-server/migrations/20260905_allow_payment_received_alert_type.sql in the Supabase SQL editor."
        : "See the API logs for the full PostgREST error.";

    logger.error(
      { err: error, code, sessionId, paymentId, branchId: resolvedBranchId },
      "payment_received alert insert failed (the payment itself succeeded)",
    );

    return { created: false, code, message: error?.message ?? "Alert insert failed", hint };
  }

  return {
    created: true,
    alert_id: (data as Record<string, unknown>)["id"] as string,
    recipient_employee_id: assignedWaiterId,
  };
};

const generateReceiptNumber = (branchShort: string): string => {
  const ts = Date.now();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `REC-${branchShort}-${ts}-${rand}`;
};

const generateInvoiceNumber = async (branchShort: string): Promise<string> => {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");

  const { count } = await supabaseAdmin
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .ilike("invoice_number", `INV-${branchShort}-${dateStr}-%`);

  const seq = String((count ?? 0) + 1).padStart(4, "0");
  return `INV-${branchShort}-${dateStr}-${seq}`;
};

export const createPayment = async (params: {
  session_id: string;
  amount: number;
  payment_method: "card" | "apple_pay" | "google_pay" | "pos" | "cash";
  card_id?: string;
  banking_benefit_id?: string;
  tip_amount?: number;
  tip_type?: "digital" | "cash";
  billing_profile_id?: string;
  userId?: string;
  isEmployee: boolean;
}): Promise<object> => {
  const {
    session_id,
    amount,
    payment_method,
    card_id,
    banking_benefit_id,
    tip_amount,
    tip_type,
    billing_profile_id,
    userId,
    isEmployee,
  } = params;

  if (amount <= 0) {
    throw createError("amount must be greater than 0", 400, "INVALID_AMOUNT");
  }

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("table_sessions")
    .select(
      "id, table_id, branch_id, tables(branch_id, branches(name, branch_payment_methods(payment_method, is_enabled)))",
    )
    .eq("id", session_id)
    .eq("status", "active")
    .single();

  if (sessionError || !session) {
    throw createError("Active session not found", 404, "SESSION_NOT_FOUND");
  }

  const sessionRow = session as Record<string, unknown>;
  const tableId = sessionRow["table_id"] as string | null;
  const table = sessionRow["tables"] as Record<string, unknown> | null;
  const branch = table?.["branches"] as Record<string, unknown> | null;
  const branchId =
    (sessionRow["branch_id"] as string | null) ?? (table?.["branch_id"] as string | null) ?? null;
  const branchShort = branchShortCode(branch?.["name"] as string | undefined);
  const paymentMethods = (branch?.["branch_payment_methods"] as Array<Record<string, unknown>>) ?? [];

  const methodAllowed = paymentMethods.some(
    (pm) => pm["payment_method"] === payment_method && pm["is_enabled"] === true,
  );
  if (!methodAllowed) {
    throw createError(`Payment method '${payment_method}' is not accepted by this branch`, 400, "METHOD_NOT_ACCEPTED");
  }

  const requiresEmployee = payment_method === "cash" || payment_method === "pos";
  if (requiresEmployee && !isEmployee) {
    throw createError("Cash and POS payments must be processed by an employee", 403, "EMPLOYEE_REQUIRED");
  }

  let discountAmount = 0;
  let benefitName: string | null = null;

  if (banking_benefit_id) {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const dayOfWeek = today.getDay();

    const { data: benefit } = await supabaseAdmin
      .from("banking_benefits")
      .select("*")
      .eq("id", banking_benefit_id)
      .eq("is_active", true)
      .lte("valid_from", todayStr)
      .gte("valid_until", todayStr)
      .maybeSingle();

    if (benefit) {
      const b = benefit as Record<string, unknown>;
      const validDays = (b["day_of_week"] as number[] | null) ?? null;
      if (!validDays || validDays.includes(dayOfWeek)) {
        const pct = (b["discount_percentage"] as number) ?? 0;
        const cap = (b["cap_amount"] as number) ?? Infinity;
        discountAmount = Math.min(Math.floor(amount * pct), cap);
        benefitName = b["name"] as string;
      }
    }
  }

  const finalAmount = amount - discountAmount;
  const isDigital = ["card", "apple_pay", "google_pay"].includes(payment_method);
  const completedAt = new Date().toISOString();

  // These are the columns that actually exist on `payments`. branch_id,
  // original_amount, billing_profile_id, benefit_name and paid_by are NOT
  // columns on the table - they are returned to the caller, not persisted.
  const paymentInsert: Record<string, unknown> = {
    session_id,
    amount: finalAmount,
    discount_amount: discountAmount,
    payment_method,
    tip_amount: tip_amount ?? 0,
    tip_type: tip_type ?? null,
    card_id: card_id ?? null,
    banking_benefit_id: banking_benefit_id ?? null,
    status: "completed",
    user_id: userId ?? null,
    completed_at: completedAt,
    created_at: completedAt,
  };

  if (isDigital) {
    paymentInsert["bancard_process_id"] = `PLACEHOLDER-${Date.now()}`;
  }

  const { data: payment, error: paymentError } = await supabaseAdmin
    .from("payments")
    .insert(paymentInsert)
    .select("*")
    .single();

  if (paymentError || !payment) {
    throw createError(paymentError?.message ?? "Failed to create payment", 500, "PAYMENT_FAILED");
  }

  const receiptNumber = generateReceiptNumber(branchShort);

  const paymentId = (payment as Record<string, unknown>)["id"] as string;

  const { data: receipt } = await supabaseAdmin
    .from("payment_receipts")
    .insert({
      payment_id: paymentId,
      receipt_number: receiptNumber,
    })
    .select("*")
    .single();

  const waiter_alert = isDigital
    ? await notifyWaiterOfDigitalPayment({ sessionId: session_id, branchId, tableId, paymentId })
    : null;

  return {
    ...(payment as object),
    original_amount: amount,
    benefit_name: benefitName,
    billing_profile_id: billing_profile_id ?? null,
    receipt,
    waiter_alert,
  };
};

export const getSessionPayments = async (sessionId: string): Promise<object> => {
  await assertSessionExists(sessionId);

  const { data: payments, error } = await supabaseAdmin
    .from("payments")
    .select("*, users(full_name), payment_receipts(*)")
    .eq("session_id", sessionId);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const balance = await computeSessionBalance(sessionId);

  return {
    payments: payments ?? [],
    ...balance,
    // Legacy alias kept so existing clients keep working.
    remaining_balance: balance.remaining,
  };
};

export const getReceipt = async (paymentId: string): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("payment_receipts")
    .select("*, payments(*, table_sessions(tables(table_number, branches(name, short_name))))")
    .eq("payment_id", paymentId)
    .single();

  if (error || !data) {
    throw createError("Receipt not found", 404, "RECEIPT_NOT_FOUND");
  }

  return data;
};

export const createSplit = async (params: {
  sessionId: string;
  split_method: "equal" | "choose_mine" | "custom_amount";
  participants_count: number;
  userId: string;
}): Promise<object> => {
  const { sessionId, split_method, participants_count } = params;

  if (!Number.isInteger(participants_count) || participants_count < 1) {
    throw createError("participants_count must be a positive integer", 400, "INVALID_PARTICIPANTS");
  }

  const { data: orders, error: ordersError } = await supabaseAdmin
    .from("orders")
    .select("total_amount")
    .eq("session_id", sessionId)
    .neq("status", "cancelled");

  if (ordersError) {
    throw createError(ordersError.message, 500, "FETCH_FAILED");
  }

  const total = (orders ?? []).reduce(
    (sum: number, o: Record<string, unknown>) => sum + ((o["total_amount"] as number) ?? 0),
    0,
  );

  let amount_per_person: number | null = null;
  let remainder: number | null = null;

  if (split_method === "equal") {
    amount_per_person = Math.floor(total / participants_count);
    remainder = total - amount_per_person * participants_count;
  }

  // `account_splits` only stores session_id / split_method / total_participants.
  // The per-person figures are derived and returned, never persisted.
  const { data, error } = await supabaseAdmin
    .from("account_splits")
    .insert({
      session_id: sessionId,
      split_method,
      total_participants: participants_count,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create split", 500, "SPLIT_FAILED");
  }

  return {
    ...(data as object),
    total_amount: total,
    amount_per_person,
    remainder,
    first_person_amount: amount_per_person != null ? amount_per_person + (remainder ?? 0) : null,
  };
};

export const claimSplitItems = async (params: {
  splitId: string;
  items: Array<{ order_item_id: string; is_shared?: boolean }>;
  userId: string;
}): Promise<object[]> => {
  const { splitId, items, userId } = params;

  // `claimed_items.participant_id` points at session_participants, not at the
  // auth user, so the caller has to be resolved to their participant row.
  const { data: split } = await supabaseAdmin
    .from("account_splits")
    .select("id, session_id")
    .eq("id", splitId)
    .maybeSingle();

  if (!split) {
    throw createError("Split not found", 404, "SPLIT_NOT_FOUND");
  }

  const { data: participant } = await supabaseAdmin
    .from("session_participants")
    .select("id")
    .eq("session_id", (split as Record<string, unknown>)["session_id"] as string)
    .eq("user_id", userId)
    .maybeSingle();

  if (!participant) {
    throw createError("You are not a participant of this session", 403, "NOT_A_PARTICIPANT");
  }

  const participantId = (participant as Record<string, unknown>)["id"] as string;

  const claimedList: object[] = [];

  for (const item of items) {
    const { order_item_id, is_shared = false } = item;

    if (is_shared) {
      const { data: existing } = await supabaseAdmin
        .from("claimed_items")
        .select("id, share_count")
        .eq("split_id", splitId)
        .eq("order_item_id", order_item_id)
        .maybeSingle();

      if (existing) {
        const e = existing as Record<string, unknown>;
        const { data: updated } = await supabaseAdmin
          .from("claimed_items")
          .update({ share_count: ((e["share_count"] as number) ?? 1) + 1 })
          .eq("id", e["id"])
          .select("*")
          .single();
        if (updated) claimedList.push(updated);
      } else {
        const { data: created } = await supabaseAdmin
          .from("claimed_items")
          .insert({ split_id: splitId, order_item_id, participant_id: participantId, is_shared: true, share_count: 1 })
          .select("*")
          .single();
        if (created) claimedList.push(created);
      }
    } else {
      const { data: already } = await supabaseAdmin
        .from("claimed_items")
        .select("id, is_shared")
        .eq("split_id", splitId)
        .eq("order_item_id", order_item_id)
        .eq("is_shared", false)
        .maybeSingle();

      if (already) {
        throw createError(`Item ${order_item_id} is already claimed`, 409, "ALREADY_CLAIMED");
      }

      const { data: created } = await supabaseAdmin
        .from("claimed_items")
        .insert({ split_id: splitId, order_item_id, participant_id: participantId, is_shared: false, share_count: 1 })
        .select("*")
        .single();
      if (created) claimedList.push(created);
    }
  }

  return claimedList;
};

export const getSplit = async (splitId: string): Promise<object> => {
  const { data: split, error } = await supabaseAdmin
    .from("account_splits")
    .select("*")
    .eq("id", splitId)
    .single();

  if (error || !split) {
    throw createError("Split not found", 404, "SPLIT_NOT_FOUND");
  }

  const s = split as Record<string, unknown>;
  const sessionId = s["session_id"] as string;

  const { data: orders } = await supabaseAdmin
    .from("orders")
    .select("*, order_items(*, products(name, price, menu_categories(name)), claimed_items(*, session_participants(user_id, web_name)))")
    .eq("session_id", sessionId)
    .neq("status", "cancelled");

  const { data: claims } = await supabaseAdmin
    .from("claimed_items")
    .select("*, session_participants(user_id, web_name)")
    .eq("split_id", splitId);

  const claimMap = new Map<string, object>();
  for (const claim of claims ?? []) {
    const c = claim as Record<string, unknown>;
    claimMap.set(c["order_item_id"] as string, claim);
  }

  return {
    split,
    orders: orders ?? [],
    claims: claims ?? [],
  };
};

export const createPaymentLink = async (params: {
  sessionId: string;
  amount: number;
  userId: string;
}): Promise<object> => {
  const { sessionId, amount, userId } = params;

  const { data: config } = await supabaseAdmin
    .from("global_configuration")
    .select("value")
    .eq("key", "payment_link_expiry_minutes")
    .maybeSingle();

  const expiryMinutes = config
    ? parseInt((config as Record<string, unknown>)["value"] as string, 10)
    : 30;

  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();
  const linkId = crypto.randomUUID();
  const url = `https://qrapp.com/pay/${linkId}`;

  const { data, error } = await supabaseAdmin
    .from("payment_links")
    .insert({
      id: linkId,
      session_id: sessionId,
      amount,
      url,
      status: "active",
      expires_at: expiresAt,
      created_by: userId,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create payment link", 500, "LINK_FAILED");
  }

  return { url, amount, expires_at: expiresAt, link_id: linkId };
};

export const getPaymentLink = async (linkId: string): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("payment_links")
    .select("*, table_sessions(tables(table_number, branches(name)))")
    .eq("id", linkId)
    .single();

  if (error || !data) {
    throw createError("Payment link not found", 404, "LINK_NOT_FOUND");
  }

  const d = data as Record<string, unknown>;
  const expiresAt = d["expires_at"] as string;

  if (d["status"] === "used") {
    throw createError("This payment link has already been used", 410, "LINK_USED");
  }

  if (new Date(expiresAt) < new Date()) {
    await supabaseAdmin.from("payment_links").update({ status: "expired" }).eq("id", linkId);
    throw createError("This payment link has expired", 410, "LINK_EXPIRED");
  }

  return data;
};

export const completePaymentLink = async (params: {
  linkId: string;
  payment_method: string;
  card_id?: string;
  userId?: string;
}): Promise<object> => {
  const { linkId, payment_method, card_id, userId } = params;

  const { data: link, error: linkError } = await supabaseAdmin
    .from("payment_links")
    .select("*, table_sessions(id, table_id, branch_id, tables(branch_id, branches(name)))")
    .eq("id", linkId)
    .eq("status", "active")
    .single();

  if (linkError || !link) {
    throw createError("Payment link not found or inactive", 404, "LINK_NOT_FOUND");
  }

  const l = link as Record<string, unknown>;
  if (new Date(l["expires_at"] as string) < new Date()) {
    throw createError("Payment link has expired", 410, "LINK_EXPIRED");
  }

  const linkSession = l["table_sessions"] as Record<string, unknown> | null;
  const table = linkSession?.["tables"] as Record<string, unknown> | null;
  const branch = table?.["branches"] as Record<string, unknown> | null;
  const branchShort = branchShortCode(branch?.["name"] as string | undefined);
  const branchId =
    (linkSession?.["branch_id"] as string | null) ?? (table?.["branch_id"] as string | null) ?? null;
  const tableId = (linkSession?.["table_id"] as string | null) ?? null;
  const sessionId = l["session_id"] as string;
  const isDigital = ["card", "apple_pay", "google_pay"].includes(payment_method);
  const completedAt = new Date().toISOString();

  // Only the columns that exist on `payments`. There is no payment_link_id
  // column - the link records who used it via used_by / used_at instead.
  const { data: payment, error: paymentError } = await supabaseAdmin
    .from("payments")
    .insert({
      session_id: sessionId,
      amount: l["amount"],
      discount_amount: 0,
      payment_method,
      tip_amount: 0,
      card_id: card_id ?? null,
      status: "completed",
      user_id: userId ?? null,
      completed_at: completedAt,
      created_at: completedAt,
      ...(isDigital ? { bancard_process_id: `PLACEHOLDER-${Date.now()}` } : {}),
    })
    .select("*")
    .single();

  if (paymentError || !payment) {
    throw createError(paymentError?.message ?? "Payment failed", 500, "PAYMENT_FAILED");
  }

  await supabaseAdmin
    .from("payment_links")
    .update({ status: "used", used_at: completedAt, used_by: userId ?? null })
    .eq("id", linkId);

  const paymentId = (payment as Record<string, unknown>)["id"] as string;
  const receiptNumber = generateReceiptNumber(branchShort);
  const { data: receipt } = await supabaseAdmin
    .from("payment_receipts")
    .insert({
      payment_id: paymentId,
      receipt_number: receiptNumber,
    })
    .select("*")
    .single();

  // A link payment is a real digital payment, so it raises the same alert.
  const waiter_alert = isDigital
    ? await notifyWaiterOfDigitalPayment({ sessionId, branchId, tableId, paymentId })
    : null;

  return { ...(payment as object), original_amount: l["amount"], receipt, waiter_alert };
};

export const createInvoice = async (params: {
  sessionId: string;
  billing_profile_id?: string;
  customer_name?: string;
  ruc?: string;
  userId: string;
}): Promise<object> => {
  const { sessionId, billing_profile_id, customer_name, ruc, userId } = params;

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("table_sessions")
    .select("id, status, branch_id, tables(branch_id, branches(name, allows_split_invoice))")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    throw createError("Session not found", 404, "SESSION_NOT_FOUND");
  }

  const sessionRow = session as Record<string, unknown>;
  const table = sessionRow["tables"] as Record<string, unknown> | null;
  const branch = table?.["branches"] as Record<string, unknown> | null;
  const branchId =
    (sessionRow["branch_id"] as string | null) ?? (table?.["branch_id"] as string | null) ?? null;
  const branchShort = branchShortCode(branch?.["name"] as string | undefined);
  const allowsSplit = branch?.["allows_split_invoice"] as boolean | undefined;

  const balance = await computeSessionBalance(sessionId);

  if (!balance.is_settled) {
    throw createError(
      "Cannot issue invoice: session is not fully paid",
      400,
      "UNPAID_BALANCE",
      {
        remaining: balance.remaining,
        pending_participant_count: balance.pending_participant_count,
      },
    );
  }

  const invoiceNumber = await generateInvoiceNumber(branchShort);
  const invoiceType = allowsSplit && billing_profile_id ? "individual" : "single";
  const issuedAt = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("invoices")
    .insert({
      session_id: sessionId,
      branch_id: branchId,
      invoice_number: invoiceNumber,
      invoice_type: invoiceType,
      billing_profile_id: billing_profile_id ?? null,
      customer_name: customer_name ?? null,
      ruc: ruc ?? null,
      total_amount: balance.total_ordered,
      status: "issued",
      issued_at: issuedAt,
      created_at: issuedAt,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create invoice", 500, "INVOICE_FAILED");
  }

  // A 'single' invoice is the fiscal close of the whole table, so it closes the
  // session. 'individual' / split invoices are per-diner and must NEVER close it.
  // The invoice row already exists and PostgREST offers no transaction to roll
  // it back, so a failed close is surfaced to the caller instead of hidden.
  let session_closed = false;
  let close_error: string | null = null;

  if (invoiceType === "single" && sessionRow["status"] === "active") {
    try {
      await closeSession(sessionId, userId);
      session_closed = true;
    } catch (err) {
      close_error = err instanceof Error ? err.message : "Unknown error";
      logger.error({ err, sessionId }, "invoice issued but session auto-close failed");
    }
  }

  return {
    ...(data as object),
    session_closed,
    ...(close_error
      ? {
          close_error,
          message: "Invoice issued, but the table could not be closed. Close it manually.",
        }
      : {}),
  };
};

export const getSessionInvoices = async (sessionId: string): Promise<object[]> => {
  await assertSessionExists(sessionId);

  const { data, error } = await supabaseAdmin
    .from("invoices")
    .select("*")
    .eq("session_id", sessionId);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return data ?? [];
};

export const getBankingBenefits = async (params: {
  branchId: string;
  userId?: string;
}): Promise<object[]> => {
  const { branchId, userId } = params;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dayOfWeek = today.getDay();

  const { data: benefits, error } = await supabaseAdmin
    .from("banking_benefits")
    .select("*")
    .eq("branch_id", branchId)
    .eq("is_active", true)
    .lte("valid_from", todayStr)
    .gte("valid_until", todayStr);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const filtered = (benefits ?? []).filter((b: Record<string, unknown>) => {
    const days = b["day_of_week"] as number[] | null;
    return !days || days.includes(dayOfWeek);
  });

  if (!userId) {
    return filtered;
  }

  const { data: userCards } = await supabaseAdmin
    .from("user_cards")
    .select("bank_name, card_level")
    .eq("user_id", userId);

  return filtered.map((b: Record<string, unknown>) => {
    const applies = (userCards ?? []).some(
      (card: Record<string, unknown>) =>
        card["bank_name"] === b["bank_name"] &&
        card["card_level"] === b["card_level"],
    );
    return { ...b, applies_to_user: applies };
  });
};
