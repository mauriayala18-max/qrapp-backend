import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

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
    .select("id, table_id, tables(branch_id, branches(short_name, branch_payment_methods(*)))")
    .eq("id", session_id)
    .eq("status", "active")
    .single();

  if (sessionError || !session) {
    throw createError("Active session not found", 404, "SESSION_NOT_FOUND");
  }

  const table = (session as Record<string, unknown>)["tables"] as Record<string, unknown> | null;
  const branch = table?.["branches"] as Record<string, unknown> | null;
  const branchId = branch?.["id"] as string | undefined;
  const branchShort = (branch?.["short_name"] as string | undefined) ?? "QR";
  const paymentMethods = (branch?.["branch_payment_methods"] as Array<Record<string, unknown>>) ?? [];

  const methodAllowed = paymentMethods.some(
    (pm) => pm["method"] === payment_method && pm["is_active"] === true,
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
  const status = "completed";

  const paymentInsert: Record<string, unknown> = {
    session_id,
    branch_id: branchId ?? null,
    amount: finalAmount,
    original_amount: amount,
    discount_amount: discountAmount,
    payment_method,
    tip_amount: tip_amount ?? 0,
    tip_type: tip_type ?? null,
    billing_profile_id: billing_profile_id ?? null,
    card_id: card_id ?? null,
    banking_benefit_id: banking_benefit_id ?? null,
    benefit_name: benefitName,
    status,
    paid_by: userId ?? null,
    created_at: new Date().toISOString(),
  };

  if (isDigital) {
    paymentInsert["bancard_process_id"] = `PLACEHOLDER-${Date.now()}`;
    paymentInsert["completed_at"] = new Date().toISOString();
  } else {
    paymentInsert["completed_at"] = new Date().toISOString();
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

  const { data: receipt } = await supabaseAdmin
    .from("payment_receipts")
    .insert({
      payment_id: (payment as Record<string, unknown>)["id"],
      receipt_number: receiptNumber,
      issued_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  return { ...(payment as object), receipt };
};

export const getSessionPayments = async (sessionId: string): Promise<object> => {
  const { data: payments, error } = await supabaseAdmin
    .from("payments")
    .select("*, users(full_name), payment_receipts(*)")
    .eq("session_id", sessionId);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const { data: orders } = await supabaseAdmin
    .from("orders")
    .select("total_amount")
    .eq("session_id", sessionId)
    .neq("status", "cancelled");

  const total_ordered = (orders ?? []).reduce(
    (sum: number, o: Record<string, unknown>) => sum + ((o["total_amount"] as number) ?? 0),
    0,
  );

  const total_paid = (payments ?? []).reduce(
    (sum: number, p: Record<string, unknown>) =>
      p["status"] === "completed" ? sum + ((p["amount"] as number) ?? 0) : sum,
    0,
  );

  return {
    payments: payments ?? [],
    total_ordered,
    total_paid,
    remaining_balance: Math.max(0, total_ordered - total_paid),
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
  const { sessionId, split_method, participants_count, userId } = params;

  const { data: orders } = await supabaseAdmin
    .from("orders")
    .select("total_amount")
    .eq("session_id", sessionId)
    .neq("status", "cancelled");

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

  const { data, error } = await supabaseAdmin
    .from("account_splits")
    .insert({
      session_id: sessionId,
      split_method,
      participants_count,
      total_amount: total,
      amount_per_person,
      created_by: userId,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create split", 500, "SPLIT_FAILED");
  }

  return {
    ...(data as object),
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
          .insert({ split_id: splitId, order_item_id, claimed_by: userId, is_shared: true, share_count: 1 })
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
        .insert({ split_id: splitId, order_item_id, claimed_by: userId, is_shared: false, share_count: 1 })
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
    .select("*, table_sessions(tables(branch_id, branches(short_name, branch_payment_methods(*))))")
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

  const table = (l["table_sessions"] as Record<string, unknown> | null)?.["tables"] as Record<string, unknown> | null;
  const branch = table?.["branches"] as Record<string, unknown> | null;
  const branchShort = (branch?.["short_name"] as string | undefined) ?? "QR";

  const { data: payment, error: paymentError } = await supabaseAdmin
    .from("payments")
    .insert({
      session_id: l["session_id"],
      branch_id: table?.["branch_id"] ?? null,
      amount: l["amount"],
      original_amount: l["amount"],
      discount_amount: 0,
      payment_method,
      tip_amount: 0,
      card_id: card_id ?? null,
      status: "completed",
      paid_by: userId ?? null,
      payment_link_id: linkId,
      completed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (paymentError || !payment) {
    throw createError(paymentError?.message ?? "Payment failed", 500, "PAYMENT_FAILED");
  }

  await supabaseAdmin.from("payment_links").update({ status: "used" }).eq("id", linkId);

  const receiptNumber = generateReceiptNumber(branchShort);
  const { data: receipt } = await supabaseAdmin
    .from("payment_receipts")
    .insert({
      payment_id: (payment as Record<string, unknown>)["id"],
      receipt_number: receiptNumber,
      issued_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  return { ...(payment as object), receipt };
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
    .select("id, tables(branch_id, branches(short_name, allows_split_invoice))")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    throw createError("Session not found", 404, "SESSION_NOT_FOUND");
  }

  const table = (session as Record<string, unknown>)["tables"] as Record<string, unknown> | null;
  const branch = table?.["branches"] as Record<string, unknown> | null;
  const branchShort = (branch?.["short_name"] as string | undefined) ?? "QR";
  const allowsSplit = branch?.["allows_split_invoice"] as boolean | undefined;

  const { data: orders } = await supabaseAdmin
    .from("orders")
    .select("total_amount")
    .eq("session_id", sessionId)
    .neq("status", "cancelled");

  const { data: payments } = await supabaseAdmin
    .from("payments")
    .select("amount")
    .eq("session_id", sessionId)
    .eq("status", "completed");

  const totalOrdered = (orders ?? []).reduce(
    (sum: number, o: Record<string, unknown>) => sum + ((o["total_amount"] as number) ?? 0),
    0,
  );
  const totalPaid = (payments ?? []).reduce(
    (sum: number, p: Record<string, unknown>) => sum + ((p["amount"] as number) ?? 0),
    0,
  );

  if (totalPaid < totalOrdered) {
    throw createError("Cannot issue invoice: session is not fully paid", 400, "UNPAID_BALANCE");
  }

  const invoiceNumber = await generateInvoiceNumber(branchShort);
  const invoiceType = allowsSplit && billing_profile_id ? "individual" : "single";

  const { data, error } = await supabaseAdmin
    .from("invoices")
    .insert({
      session_id: sessionId,
      branch_id: table?.["branch_id"] ?? null,
      invoice_number: invoiceNumber,
      invoice_type: invoiceType,
      billing_profile_id: billing_profile_id ?? null,
      customer_name: customer_name ?? null,
      ruc: ruc ?? null,
      total_amount: totalOrdered,
      created_by: userId,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create invoice", 500, "INVOICE_FAILED");
  }

  return data;
};

export const getSessionInvoices = async (sessionId: string): Promise<object[]> => {
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
