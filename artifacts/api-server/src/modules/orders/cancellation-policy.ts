import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { logger } from "../../lib/logger.js";
import { computeSessionBalance } from "../payments/balance.service.js";

/**
 * Single authorization model for every cancellation and modification path.
 *
 * The vulnerability this replaces: `cancelOrder` only resolved the caller when
 * the order was `in_preparation`. In every other status it cancelled using
 * nothing but the order id from the URL, so any authenticated user could cancel
 * any order of any restaurant. The guard therefore cannot live in one branch of
 * one function - every entry point loads the order, resolves its branch, and
 * authorizes the actor for THAT branch before touching a single row.
 *
 * Never trust the client: the role, the branch and the ownership are all read
 * from the database using the authenticated user id, never from the request.
 */

/** Staff roles allowed to cancel or resolve cancellations at all. */
const CANCELLATION_ROLES = ["waiter", "manager", "admin"];

/**
 * Roles allowed to override the two hard blocks (self-service mode and an
 * already-paid order). A waiter is deliberately NOT elevated: undoing money
 * that was already collected is a refund decision.
 */
const ELEVATED_ROLES = ["manager", "admin"];

/** Item states that can still be cancelled. */
const CANCELLABLE_ITEM_STATUSES = ["received", "in_preparation"];

export interface OrderContext {
  id: string;
  status: string;
  branch_id: string;
  session_id: string | null;
  user_id: string | null;
  participant_id: string | null;
  created_at: string | null;
  operation_mode: string;
}

export type CancellationActor =
  | { kind: "staff"; authUserId: string; employeeId: string; role: string }
  | { kind: "client"; authUserId: string; participantId: string | null };

/** How a request must be carried out once the actor is authorized. */
export type CancellationMode = "direct" | "request";

/** Every refusal is logged, so a probing caller leaves a trail even though a denial writes no audit row. */
const deny = (code: string, message: string, context: Record<string, unknown>): never => {
  logger.warn({ code, ...context }, "cancellation denied");
  throw createError(message, 403, code);
};

/** Load the order together with the branch it belongs to. */
export const loadOrderContext = async (orderId: string): Promise<OrderContext> => {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "id, status, branch_id, session_id, user_id, participant_id, created_at, branches(operation_mode)",
    )
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "ORDER_LOOKUP_FAILED");
  }

  if (!data) {
    throw createError("Order not found", 404, "ORDER_NOT_FOUND");
  }

  const row = data as Record<string, unknown>;
  const branch = row["branches"] as Record<string, unknown> | null;

  if (!branch) {
    // Without the branch there is no way to authorize anyone, so fail closed.
    throw createError("Order branch could not be resolved", 500, "BRANCH_LOOKUP_FAILED");
  }

  return {
    id: row["id"] as string,
    status: row["status"] as string,
    branch_id: row["branch_id"] as string,
    session_id: (row["session_id"] as string | null) ?? null,
    user_id: (row["user_id"] as string | null) ?? null,
    participant_id: (row["participant_id"] as string | null) ?? null,
    created_at: (row["created_at"] as string | null) ?? null,
    operation_mode: branch["operation_mode"] as string,
  };
};

/**
 * Identify the caller and prove they may act on THIS order's branch.
 *
 * Staff are matched through `employees.auth_user_id` and must hold an active
 * `employee_branches` row for the order's branch. Everyone else is treated as a
 * diner and must own the order.
 */
export const resolveCancellationActor = async (
  authUserId: string,
  order: OrderContext,
): Promise<CancellationActor> => {
  const { data: employee, error: employeeError } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("auth_user_id", authUserId)
    .eq("is_active", true)
    .maybeSingle();

  if (employeeError) {
    throw createError(employeeError.message, 500, "EMPLOYEE_LOOKUP_FAILED");
  }

  if (employee) {
    const employeeRow = employee as Record<string, unknown>;
    const employeeId = employeeRow["id"] as string;
    const role = employeeRow["role"] as string;

    // The cross-restaurant guard: staff may only act inside their own branch.
    const { data: assignment, error: assignmentError } = await supabaseAdmin
      .from("employee_branches")
      .select("branch_id")
      .eq("employee_id", employeeId)
      .eq("branch_id", order.branch_id)
      .eq("is_active", true)
      .maybeSingle();

    if (assignmentError) {
      throw createError(assignmentError.message, 500, "BRANCH_LOOKUP_FAILED");
    }

    if (!assignment) {
      deny("WRONG_BRANCH", "You are not assigned to the branch this order belongs to", {
        employee_id: employeeId,
        order_id: order.id,
        branch_id: order.branch_id,
      });
    }

    // The role gate lives in `assertCancellationRole`, not here: kitchen staff
    // legitimately move items to in_preparation / ready on this same order, they
    // just may not cancel.
    return { kind: "staff", authUserId, employeeId, role };
  }

  // Not staff: a diner may only touch an order that is theirs, either directly
  // (orders.user_id) or through the participant the order was placed by.
  let participantId: string | null = null;

  if (order.session_id) {
    const { data: participant, error: participantError } = await supabaseAdmin
      .from("session_participants")
      .select("id")
      .eq("session_id", order.session_id)
      .eq("user_id", authUserId)
      .maybeSingle();

    if (participantError) {
      throw createError(participantError.message, 500, "PARTICIPANT_LOOKUP_FAILED");
    }

    participantId = ((participant as Record<string, unknown> | null)?.["id"] as string) ?? null;
  }

  const ownsAsUser = order.user_id !== null && order.user_id === authUserId;
  const ownsAsParticipant =
    order.participant_id !== null && participantId !== null && order.participant_id === participantId;

  if (!ownsAsUser && !ownsAsParticipant) {
    deny("NOT_YOUR_ORDER", "This order does not belong to you", {
      auth_user_id: authUserId,
      order_id: order.id,
    });
  }

  return { kind: "client", authUserId, participantId };
};

/**
 * Which of these items have already been paid for through a split claim?
 *
 * A payment identifies its payer by `participant_id`, by `user_id`, or both, so
 * both id spaces have to be considered or a paid item looks unpaid.
 */
const anyItemPaid = async (itemIds: string[], sessionId: string | null): Promise<boolean> => {
  if (!sessionId || itemIds.length === 0) {
    return false;
  }

  const { data: claims, error: claimError } = await supabaseAdmin
    .from("claimed_items")
    .select("participant_id")
    .in("order_item_id", itemIds);

  if (claimError) {
    throw createError(claimError.message, 500, "CLAIM_LOOKUP_FAILED");
  }

  const claimants = new Set(
    (claims ?? [])
      .map((c) => (c as Record<string, unknown>)["participant_id"] as string | null)
      .filter((id): id is string => Boolean(id)),
  );

  if (claimants.size === 0) {
    return false;
  }

  const { data: payments, error: paymentError } = await supabaseAdmin
    .from("payments")
    .select("participant_id, user_id")
    .eq("session_id", sessionId)
    .eq("status", "completed");

  if (paymentError) {
    throw createError(paymentError.message, 500, "PAYMENT_LOOKUP_FAILED");
  }

  const paidParticipants = new Set<string>();
  const paidUsers = new Set<string>();

  for (const payment of payments ?? []) {
    const row = payment as Record<string, unknown>;
    const participantId = row["participant_id"] as string | null;
    const userId = row["user_id"] as string | null;
    if (participantId) paidParticipants.add(participantId);
    if (userId) paidUsers.add(userId);
  }

  if ([...claimants].some((id) => paidParticipants.has(id))) {
    return true;
  }

  if (paidUsers.size === 0) {
    return false;
  }

  const { data: roster, error: rosterError } = await supabaseAdmin
    .from("session_participants")
    .select("id, user_id")
    .in("id", [...claimants]);

  if (rosterError) {
    throw createError(rosterError.message, 500, "PARTICIPANT_LOOKUP_FAILED");
  }

  return (roster ?? []).some((p) => {
    const row = p as Record<string, unknown>;
    const userId = row["user_id"] as string | null;
    return userId !== null && paidUsers.has(userId);
  });
};

/** Has this specific item already been paid for through a split claim? */
export const isItemPaid = async (itemId: string, sessionId: string | null): Promise<boolean> =>
  anyItemPaid([itemId], sessionId);

/**
 * Has this order already been paid for?
 *
 * Payments are recorded per session far more often than per order, so a direct
 * `payments.order_id` hit is only the first test. A closed session is checked
 * before the live balance because appending a new order to a session swings its
 * balance back to "unsettled", and that must never silently drop the protection
 * of money already collected.
 */
export const isOrderPaid = async (order: OrderContext): Promise<boolean> => {
  const { data: direct, error } = await supabaseAdmin
    .from("payments")
    .select("id")
    .eq("order_id", order.id)
    .eq("status", "completed")
    .limit(1);

  if (error) {
    throw createError(error.message, 500, "PAYMENT_LOOKUP_FAILED");
  }

  if ((direct ?? []).length > 0) {
    return true;
  }

  if (!order.session_id) {
    return false;
  }

  // Cancelling the whole order must not skip the per-item check that cancelling
  // one item performs.
  const { data: items, error: itemError } = await supabaseAdmin
    .from("order_items")
    .select("id")
    .eq("order_id", order.id);

  if (itemError) {
    throw createError(itemError.message, 500, "ITEM_LOOKUP_FAILED");
  }

  const itemIds = (items ?? []).map((i) => (i as Record<string, unknown>)["id"] as string);

  if (await anyItemPaid(itemIds, order.session_id)) {
    return true;
  }

  // A payment that landed after this order was placed was collecting a bill
  // this order was already part of. The live balance cannot carry that on its
  // own: appending a new order to the session swings it back to "unsettled",
  // which would silently drop the protection from everything paid earlier.
  const { data: sessionPayments, error: sessionPaymentError } = await supabaseAdmin
    .from("payments")
    .select("participant_id, user_id, completed_at, created_at")
    .eq("session_id", order.session_id)
    .eq("status", "completed");

  if (sessionPaymentError) {
    throw createError(sessionPaymentError.message, 500, "PAYMENT_LOOKUP_FAILED");
  }

  if (order.created_at) {
    const placedAt = Date.parse(order.created_at);

    const covered = (sessionPayments ?? []).some((p) => {
      const row = p as Record<string, unknown>;
      const at = (row["completed_at"] as string | null) ?? (row["created_at"] as string | null);

      // A payment taken before this order existed cannot have covered it.
      if (at === null || Date.parse(at) < placedAt) {
        return false;
      }

      const payerParticipant = row["participant_id"] as string | null;
      const payerUser = row["user_id"] as string | null;

      // A payment attributed to nobody settles the table as a whole.
      if (!payerParticipant && !payerUser) {
        return true;
      }

      // Otherwise it only covers the orders of the diner who paid it: one diner
      // settling their own split must not lock another diner's order.
      if (payerParticipant && order.participant_id && payerParticipant === order.participant_id) {
        return true;
      }

      return Boolean(payerUser && order.user_id && payerUser === order.user_id);
    });

    if (covered) {
      return true;
    }
  }

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("table_sessions")
    .select("status")
    .eq("id", order.session_id)
    .maybeSingle();

  if (sessionError) {
    throw createError(sessionError.message, 500, "SESSION_LOOKUP_FAILED");
  }

  if ((session as Record<string, unknown> | null)?.["status"] === "closed") {
    return true;
  }

  const balance = await computeSessionBalance(order.session_id);

  // total_paid > 0 keeps an empty session (0 ordered, 0 paid, therefore
  // "settled") from being reported as paid.
  return balance.total_paid > 0 && balance.is_settled;
};

export const assertCancellationRole = (actor: CancellationActor): void => {
  if (actor.kind === "staff" && !CANCELLATION_ROLES.includes(actor.role)) {
    deny("FORBIDDEN_ROLE", "Your role cannot cancel or resolve cancellations", {
      employee_id: actor.employeeId,
      role: actor.role,
    });
  }
};

/**
 * Apply the product rules once the actor is known. Returns how the cancellation
 * must proceed: `direct` cancels now, `request` needs waiter confirmation.
 *
 * `itemStatuses` are the current statuses of the items this action would
 * cancel, so a plate already at the pass is protected even when the order as a
 * whole is still open.
 */
export const assertCancellationAllowed = (params: {
  order: OrderContext;
  actor: CancellationActor;
  paid: boolean;
  itemStatuses?: string[];
}): CancellationMode => {
  const { order, actor, paid } = params;
  const itemStatuses = params.itemStatuses ?? [];
  const context = { order_id: order.id, actor: actor.kind, order_status: order.status };

  assertCancellationRole(actor);

  if (order.status === "cancelled") {
    throw createError("This order is already cancelled", 400, "ALREADY_CANCELLED");
  }

  // Nobody cancels a finished plate through the normal path - that is a refund.
  if (order.status === "ready" || order.status === "delivered") {
    deny("STATUS_LOCKED", "An order that is ready or delivered can no longer be cancelled here", context);
  }

  if (itemStatuses.some((status) => !CANCELLABLE_ITEM_STATUSES.includes(status))) {
    deny("STATUS_LOCKED", "An item that is already ready or cancelled can no longer be cancelled here", {
      ...context,
      item_statuses: itemStatuses,
    });
  }

  const elevated = actor.kind === "staff" && ELEVATED_ROLES.includes(actor.role);

  // Self-service is pay-first, so there is nothing for a diner (or a waiter) to
  // cancel: only a manager or admin can reverse it.
  if (order.operation_mode === "self_service" && !elevated) {
    deny("CANCELLATION_NOT_ALLOWED_SELF_SERVICE", "Cancellations are not available in self-service mode", context);
  }

  if (paid && !elevated) {
    deny("ALREADY_PAID", "This order was already paid; only a manager or admin can reverse it", context);
  }

  // A diner may cancel outright only before the kitchen starts. Once it is in
  // preparation the waiter has to confirm, which is the request flow.
  if (actor.kind === "client" && order.status === "in_preparation") {
    return "request";
  }

  return "direct";
};

/**
 * Write the mandatory audit record. Runs AFTER the mutation, because reporting
 * a failure for a cancellation that actually happened is worse than a missing
 * log line - so a failed audit is logged loudly and surfaced to the caller as
 * `audit_logged: false` instead of throwing.
 */
export const recordCancellationAudit = async (params: {
  actor: CancellationActor;
  action: string;
  referenceType: "order" | "order_item" | "cancellation_request";
  referenceId: string;
  order: OrderContext;
  oldStatus: string;
  newStatus: string;
  reason?: string | null;
  paid?: boolean;
  extra?: Record<string, unknown>;
}): Promise<boolean> => {
  const { actor, order } = params;

  const { error } = await supabaseAdmin.from("audit_log").insert({
    actor_type: actor.kind === "staff" ? "employee" : "user",
    // Staff are identified by employees.id, diners by users.id - never the auth
    // id for staff, which is a different id space entirely.
    actor_id: actor.kind === "staff" ? actor.employeeId : actor.authUserId,
    action: params.action,
    module: "orders",
    reference_type: params.referenceType,
    reference_id: params.referenceId,
    log_level: "full",
    old_value: { status: params.oldStatus },
    new_value: {
      status: params.newStatus,
      order_id: order.id,
      branch_id: order.branch_id,
      session_id: order.session_id,
      operation_mode: order.operation_mode,
      actor_role: actor.kind === "staff" ? actor.role : "client",
      reason: params.reason ?? null,
      was_paid: params.paid ?? false,
      ...(params.extra ?? {}),
    },
    created_at: new Date().toISOString(),
  });

  if (error) {
    logger.error(
      {
        err: error,
        action: params.action,
        reference_type: params.referenceType,
        reference_id: params.referenceId,
        actor_id: actor.kind === "staff" ? actor.employeeId : actor.authUserId,
      },
      "cancellation audit_log insert failed",
    );
    return false;
  }

  return true;
};

/**
 * Authorize a staff-only modification (item status, order status, linking)
 * against the order's branch. Same cross-branch guard, without the diner path.
 */
export const authorizeStaffForOrder = async (
  authUserId: string,
  order: OrderContext,
): Promise<Extract<CancellationActor, { kind: "staff" }>> => {
  const actor = await resolveCancellationActor(authUserId, order);

  if (actor.kind !== "staff") {
    deny("FORBIDDEN", "Employee access required", { auth_user_id: authUserId, order_id: order.id });
  }

  return actor as Extract<CancellationActor, { kind: "staff" }>;
};
