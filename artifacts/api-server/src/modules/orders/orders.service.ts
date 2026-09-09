import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { resolveEmployeeId } from "../../lib/actors.js";
import { logger } from "../../lib/logger.js";
import {
  assertCancellationAllowed,
  assertCancellationRole,
  authorizeStaffForOrder,
  isItemPaid,
  isOrderPaid,
  loadOrderContext,
  recordCancellationAudit,
  resolveCancellationActor,
  type CancellationActor,
  type OrderContext,
} from "./cancellation-policy.js";

interface OrderItem {
  product_id: string;
  quantity: number;
  notes?: string;
  modifications?: Array<{ option_id: string }>;
}

const buildOrder = async (params: {
  session_id?: string;
  branch_id?: string;
  items: OrderItem[];
  notes?: string;
  order_type: string;
  user_id?: string;
  requested_time?: string;
}): Promise<object> => {
  const { session_id, branch_id, items, notes, order_type, user_id, requested_time } = params;

  let resolvedBranchId = branch_id;

  if (session_id && !resolvedBranchId) {
    const { data: session } = await supabaseAdmin
      .from("table_sessions")
      .select("tables(branch_id)")
      .eq("id", session_id)
      .single();

    const table = session && (session as Record<string, unknown>)["tables"] as Record<string, unknown> | null;
    resolvedBranchId = table?.["branch_id"] as string | undefined;

    if (!resolvedBranchId) {
      throw createError("Could not resolve branch from session", 400, "BRANCH_RESOLVE_FAILED");
    }
  }

  const productIds = items.map((i) => i.product_id);
  const { data: products, error: productError } = await supabaseAdmin
    .from("products")
    .select("id, price, is_available, branch_id")
    .in("id", productIds);

  if (productError || !products || products.length !== productIds.length) {
    throw createError("One or more products not found", 404, "PRODUCTS_NOT_FOUND");
  }

  for (const product of products) {
    if (!(product as Record<string, unknown>)["is_available"]) {
      throw createError(`Product ${(product as Record<string, unknown>)["id"]} is not available`, 400, "PRODUCT_UNAVAILABLE");
    }
    if ((product as Record<string, unknown>)["branch_id"] !== resolvedBranchId) {
      throw createError(`Product ${(product as Record<string, unknown>)["id"]} does not belong to this branch`, 400, "PRODUCT_BRANCH_MISMATCH");
    }
  }

  const priceMap = new Map(
    products.map((p) => [(p as Record<string, unknown>)["id"] as string, (p as Record<string, unknown>)["price"] as number]),
  );

  const orderInsert: Record<string, unknown> = {
    order_type,
    status: "received",
    received_at: new Date().toISOString(),
    notes,
  };

  if (session_id) orderInsert["session_id"] = session_id;
  if (resolvedBranchId) orderInsert["branch_id"] = resolvedBranchId;
  // `orders` has NO staff-actor column - created_by_employee does not exist,
  // and writing it made every employee-created order fail. Traditional orders
  // record their author in audit_log instead (see createTraditionalOrder).
  if (user_id) orderInsert["user_id"] = user_id;
  if (requested_time) orderInsert["requested_time"] = requested_time;

  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .insert(orderInsert)
    .select("*")
    .single();

  if (orderError || !order) {
    throw createError(orderError?.message ?? "Failed to create order", 500, "ORDER_CREATE_FAILED");
  }

  let totalAmount = 0;
  const createdItems = [];

  for (const item of items) {
    const unitPrice = priceMap.get(item.product_id) ?? 0;

    let modTotal = 0;
    if (item.modifications?.length) {
      const optionIds = item.modifications.map((m) => m.option_id);
      const { data: options } = await supabaseAdmin
        .from("product_options")
        .select("id, additional_price")
        .in("id", optionIds);

      modTotal = (options ?? []).reduce(
        (sum: number, o: Record<string, unknown>) => sum + ((o["additional_price"] as number) ?? 0),
        0,
      );
    }

    const itemTotal = (unitPrice + modTotal) * item.quantity;
    totalAmount += itemTotal;

    const { data: orderItem, error: itemError } = await supabaseAdmin
      .from("order_items")
      .insert({
        order_id: (order as Record<string, unknown>)["id"],
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: unitPrice,
        total_price: itemTotal,
        notes: item.notes,
        status: "received",
      })
      .select("*")
      .single();

    if (itemError || !orderItem) {
      throw createError(itemError?.message ?? "Failed to create order item", 500, "ITEM_CREATE_FAILED");
    }

    if (item.modifications?.length) {
      await supabaseAdmin.from("order_item_modifications").insert(
        item.modifications.map((m) => ({
          order_item_id: (orderItem as Record<string, unknown>)["id"],
          option_id: m.option_id,
        })),
      );
    }

    createdItems.push(orderItem);
  }

  await supabaseAdmin
    .from("orders")
    .update({ total_amount: totalAmount })
    .eq("id", (order as Record<string, unknown>)["id"]);

  return { ...(order as object), total_amount: totalAmount, order_items: createdItems };
};

export const createOrder = async (params: {
  session_id: string;
  items: OrderItem[];
  notes?: string;
  user_id?: string;
}): Promise<object> => {
  return buildOrder({ ...params, order_type: "digital" });
};

export const createTraditionalOrder = async (params: {
  session_id: string;
  items: OrderItem[];
  notes?: string;
  employee_id: string;
}): Promise<object> => {
  // Resolve first: a caller with no active employee row is refused before any
  // row is written, rather than after a partially-built order.
  const employeeId = await resolveEmployeeId(params.employee_id);

  const order = (await buildOrder({
    session_id: params.session_id,
    items: params.items,
    notes: params.notes,
    order_type: "traditional",
  })) as Record<string, unknown>;

  // `orders` has no column for the staff member who took the order, so the
  // attribution lives in audit_log. Non-fatal: the order itself is already in.
  const { error: auditError } = await supabaseAdmin.from("audit_log").insert({
    actor_type: "employee",
    actor_id: employeeId,
    action: "create_traditional_order",
    module: "orders",
    reference_type: "order",
    reference_id: order["id"],
    log_level: "full",
    new_value: {
      order_type: "traditional",
      session_id: params.session_id,
      total_amount: order["total_amount"] ?? null,
    },
    created_at: new Date().toISOString(),
  });

  if (auditError) {
    logger.error(
      { err: auditError, orderId: order["id"] },
      "create_traditional_order audit_log insert failed",
    );
  }

  return order;
};

export const createAnticipatoryOrder = async (params: {
  branch_id: string;
  order_type: "anticipatory_dine_in" | "anticipatory_pickup";
  requested_time: string;
  items: OrderItem[];
  notes?: string;
  user_id: string;
}): Promise<object> => {
  const { data: branch, error: branchError } = await supabaseAdmin
    .from("branches")
    .select("id, advance_order_enabled, pickup_enabled")
    .eq("id", params.branch_id)
    .single();

  if (branchError || !branch) {
    throw createError("Branch not found", 404, "BRANCH_NOT_FOUND");
  }

  if (
    params.order_type === "anticipatory_dine_in" &&
    !(branch as Record<string, unknown>)["advance_order_enabled"]
  ) {
    throw createError("Advance orders not enabled for this branch", 400, "ADVANCE_ORDER_DISABLED");
  }

  if (
    params.order_type === "anticipatory_pickup" &&
    !(branch as Record<string, unknown>)["pickup_enabled"]
  ) {
    throw createError("Pickup not enabled for this branch", 400, "PICKUP_DISABLED");
  }

  return buildOrder({
    branch_id: params.branch_id,
    items: params.items,
    notes: params.notes,
    order_type: params.order_type,
    user_id: params.user_id,
    requested_time: params.requested_time,
  });
};

export const linkOrderToSession = async (params: {
  orderId: string;
  sessionId: string;
  authUserId: string;
}): Promise<object> => {
  const { orderId, sessionId, authUserId } = params;

  // Linking rewrites which table pays for an order, so it is a modification
  // path and carries the same cross-branch guard as a cancellation.
  const order = await loadOrderContext(orderId);
  const actor = await authorizeStaffForOrder(authUserId, order);

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("table_sessions")
    .select("id, branch_id, status")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    throw createError(sessionError.message, 500, "SESSION_LOOKUP_FAILED");
  }

  if (!session) {
    throw createError("Session not found", 404, "SESSION_NOT_FOUND");
  }

  const sessionRow = session as Record<string, unknown>;

  if ((sessionRow["branch_id"] as string) !== order.branch_id) {
    throw createError("That session belongs to a different branch", 403, "WRONG_BRANCH");
  }

  if ((sessionRow["status"] as string) !== "active") {
    throw createError("That session is not active", 400, "SESSION_NOT_ACTIVE");
  }

  // Moving a paid order into another session would hand it a clean balance and
  // strip the already-paid protection from every later cancellation check.
  if (order.session_id && order.session_id !== sessionId && (await isOrderPaid(order))) {
    throw createError(
      "This order was already paid; it cannot be moved to another session",
      403,
      "ALREADY_PAID",
    );
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ session_id: sessionId, is_linked: true })
    .eq("id", orderId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to link order", 400, "LINK_FAILED");
  }

  await recordCancellationAudit({
    actor,
    action: "link_order_to_session",
    referenceType: "order",
    referenceId: orderId,
    order,
    oldStatus: order.status,
    newStatus: order.status,
    extra: { from_session_id: order.session_id, to_session_id: sessionId },
  });

  return data;
};

export const getOrder = async (orderId: string): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*, order_items(*, order_item_modifications(*))")
    .eq("id", orderId)
    .single();

  if (error || !data) {
    throw createError("Order not found", 404, "ORDER_NOT_FOUND");
  }

  return data;
};

export const getActiveOrders = async (branchId: string): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*, table_sessions(tables(table_number)), order_items(*, order_item_modifications(*))")
    .eq("branch_id", branchId)
    .not("status", "in", '("delivered","cancelled")')
    .order("received_at", { ascending: true });

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return data ?? [];
};

export const updateItemStatus = async (params: {
  orderId: string;
  itemId: string;
  status: "in_preparation" | "ready" | "cancelled";
  authUserId: string;
}): Promise<object> => {
  const { orderId, itemId, status, authUserId } = params;

  const order = await loadOrderContext(orderId);
  const actor = await authorizeStaffForOrder(authUserId, order);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("order_items")
    .select("id, status")
    .eq("id", itemId)
    .eq("order_id", orderId)
    .maybeSingle();

  if (existingError) {
    throw createError(existingError.message, 500, "ITEM_LOOKUP_FAILED");
  }

  if (!existing) {
    throw createError("Item not found", 404, "ITEM_NOT_FOUND");
  }

  const previousStatus = (existing as Record<string, unknown>)["status"] as string;
  let paid = false;

  // A cancelled item is terminal: without this any in-branch employee could
  // resurrect it by setting it back to received / in_preparation / ready.
  if (previousStatus === "cancelled") {
    throw createError("This item is already cancelled", 400, "ITEM_ALREADY_CANCELLED");
  }

  // Forward-only. Downgrading a ready item back to in_preparation and then
  // cancelling it would otherwise walk straight around the ready-item lock.
  if (status !== "cancelled") {
    const flow = ["received", "in_preparation", "ready"];
    if (flow.indexOf(status) <= flow.indexOf(previousStatus)) {
      throw createError(
        `An item cannot go from ${previousStatus} back to ${status}`,
        400,
        "INVALID_STATUS_TRANSITION",
      );
    }
  }

  if (status === "cancelled") {
    paid = (await isItemPaid(itemId, order.session_id)) || (await isOrderPaid(order));
    assertCancellationAllowed({ order, actor, paid, itemStatuses: [previousStatus] });
  }

  // order_items carries a status and nothing else: there is no
  // in_preparation_at / ready_at / cancelled_at column on it, so writing one
  // made every single item status update fail.
  // Compare-and-swap on the status that was authorized, so a concurrent
  // transition loses the race instead of being silently overwritten.
  const { data: updatedItems, error: itemError } = await supabaseAdmin
    .from("order_items")
    .update({ status })
    .eq("id", itemId)
    .eq("order_id", orderId)
    .eq("status", previousStatus)
    .select("*");

  if (itemError) {
    throw createError(itemError.message, 500, "ITEM_UPDATE_FAILED");
  }

  const item = (updatedItems ?? [])[0];

  if (!item) {
    throw createError(
      "This item changed state while it was being updated",
      403,
      "STATUS_LOCKED",
    );
  }

  if (status === "cancelled") {
    await recordCancellationAudit({
      actor,
      action: "cancel_order_item",
      referenceType: "order_item",
      referenceId: itemId,
      order,
      oldStatus: previousStatus,
      newStatus: "cancelled",
      paid,
      extra: { via: "item_status_update" },
    });
  }

  // Keep the parent in step with the kitchen: an order whose items are being
  // prepared must not stay 'received', or its owner could still cancel it
  // outright instead of going through the waiter.
  if (status === "in_preparation") {
    const { error: parentError } = await supabaseAdmin
      .from("orders")
      .update({ status: "in_preparation", in_preparation_at: new Date().toISOString() })
      .eq("id", orderId)
      .eq("status", "received");

    if (parentError) {
      // Not fatal - the item did move - but it leaves the order looking
      // cancellable-on-the-spot, so it must be visible.
      logger.error(
        { err: parentError, order_id: orderId },
        "item moved to in_preparation but the parent order could not follow",
      );
    }
  }

  const { data: allItems } = await supabaseAdmin
    .from("order_items")
    .select("status")
    .eq("order_id", orderId)
    .neq("status", "cancelled");

  const liveItems = allItems ?? [];

  // An empty list must NOT count as "all ready": cancelling the last item would
  // otherwise flip the whole order to ready.
  const allReady =
    liveItems.length > 0 &&
    liveItems.every((i: Record<string, unknown>) => i["status"] === "ready");

  if (allReady) {
    await supabaseAdmin
      .from("orders")
      .update({ status: "ready", ready_at: new Date().toISOString() })
      .eq("id", orderId);
  }

  return item;
};

export const updateOrderStatus = async (params: {
  orderId: string;
  status: "ready" | "delivered";
  authUserId: string;
}): Promise<object> => {
  const { orderId, status, authUserId } = params;

  const order = await loadOrderContext(orderId);
  await authorizeStaffForOrder(authUserId, order);

  if (order.status === "cancelled") {
    throw createError("This order is already cancelled", 400, "ALREADY_CANCELLED");
  }

  // Forward-only: a delivered order must not be walked back to ready.
  const orderFlow = ["received", "in_preparation", "ready", "delivered"];
  if (orderFlow.indexOf(status) <= orderFlow.indexOf(order.status)) {
    throw createError(
      `An order cannot go from ${order.status} back to ${status}`,
      400,
      "INVALID_STATUS_TRANSITION",
    );
  }

  // order_items has no 'delivered' state (its CHECK allows received /
  // in_preparation / ready / cancelled) and no timestamp columns, so only the
  // 'ready' mirror is written, and only the status itself.
  if (status === "ready") {
    await supabaseAdmin
      .from("order_items")
      .update({ status: "ready" })
      .eq("order_id", orderId)
      .neq("status", "cancelled");
  }

  const orderPatch: Record<string, unknown> = { status };
  orderPatch[status === "ready" ? "ready_at" : "delivered_at"] = new Date().toISOString();

  const { data: updated, error } = await supabaseAdmin
    .from("orders")
    .update(orderPatch)
    .eq("id", orderId)
    .eq("status", order.status)
    .select("*");

  if (error) {
    throw createError(error.message, 500, "ORDER_UPDATE_FAILED");
  }

  const data = (updated ?? [])[0];

  if (!data) {
    throw createError(
      "This order changed state while it was being updated",
      403,
      "STATUS_LOCKED",
    );
  }

  return data;
};

export const cancelOrder = async (params: {
  orderId: string;
  reason?: string;
  item_id?: string;
  userId: string;
}): Promise<object> => {
  const { orderId, reason, item_id, userId } = params;

  // Load the order and authorize the caller against ITS branch before touching
  // anything. This is the guard whose absence let any authenticated user cancel
  // any order in the platform.
  const order = await loadOrderContext(orderId);
  const actor = await resolveCancellationActor(userId, order);

  if (item_id) {
    const { data: item, error: itemError } = await supabaseAdmin
      .from("order_items")
      .select("id, status")
      .eq("id", item_id)
      .eq("order_id", orderId)
      .maybeSingle();

    if (itemError) {
      throw createError(itemError.message, 500, "ITEM_LOOKUP_FAILED");
    }

    if (!item) {
      throw createError("Item not found on this order", 404, "ITEM_NOT_FOUND");
    }
  }

  // Cancelling the order cancels every live item, so each of them has to be
  // cancellable - a plate already at the pass locks the whole action.
  const itemStatuses = await targetItemStatuses(orderId, item_id ?? null);

  const paid = item_id
    ? (await isItemPaid(item_id, order.session_id)) || (await isOrderPaid(order))
    : await isOrderPaid(order);

  const mode = assertCancellationAllowed({ order, actor, paid, itemStatuses });

  if (mode === "request") {
    const { data: request, error: reqError } = await supabaseAdmin
      .from("cancellation_requests")
      .insert({
        order_id: orderId,
        // Real columns are order_item_id (FK order_items.id) and
        // requested_by_participant (FK session_participants.id). request_type is
        // REQUIRED and its CHECK allows only 'cancellation' | 'modification'.
        order_item_id: item_id ?? null,
        request_type: "cancellation",
        requested_by_participant: actor.kind === "client" ? actor.participantId : null,
        reason: reason ?? null,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (reqError || !request) {
      throw createError(
        reqError?.message ?? "Failed to create cancellation request",
        500,
        "REQUEST_FAILED",
      );
    }

    const requestId = (request as Record<string, unknown>)["id"] as string;

    const audited = await recordCancellationAudit({
      actor,
      action: "request_cancellation",
      referenceType: "cancellation_request",
      referenceId: requestId,
      order,
      oldStatus: order.status,
      newStatus: "pending",
      reason: reason ?? null,
      paid,
      extra: { order_item_id: item_id ?? null },
    });

    return {
      message: "Your waiter will come to confirm",
      request_id: requestId,
      audit_logged: audited,
    };
  }

  const audited = await cancelNow({ order, actor, itemId: item_id ?? null, reason: reason ?? null, paid });

  return { success: true, audit_logged: audited };
};

/**
 * Perform an authorized cancellation and audit it. Callers MUST have run
 * `assertCancellationAllowed` first - this helper does no authorization.
 */
const cancelNow = async (params: {
  order: OrderContext;
  actor: CancellationActor;
  itemId: string | null;
  reason: string | null;
  paid: boolean;
}): Promise<boolean> => {
  const { order, actor, itemId, reason, paid } = params;

  if (itemId) {
    // The status filter makes a concurrent transition lose the race instead of
    // being silently overwritten between the check and the write.
    const { data: cancelledItem, error } = await supabaseAdmin
      // order_items has no cancelled_at column (orders does).
      .from("order_items")
      .update({ status: "cancelled" })
      .eq("id", itemId)
      .eq("order_id", order.id)
      .in("status", ["received", "in_preparation"])
      .select("id");

    if (error) {
      throw createError(error.message, 500, "CANCEL_FAILED");
    }

    if ((cancelledItem ?? []).length === 0) {
      throw createError(
        "This item changed state while it was being cancelled",
        403,
        "STATUS_LOCKED",
      );
    }

    return recordCancellationAudit({
      actor,
      action: "cancel_order_item",
      referenceType: "order_item",
      referenceId: itemId,
      order,
      oldStatus: order.status,
      newStatus: "cancelled",
      reason,
      paid,
    });
  }

  // The order is cancelled FIRST, and only if it is still in the state that was
  // authorized. Everything reads the order's status, so a half-applied
  // cancellation must never leave dead items under a live order.
  const { data: cancelledOrder, error: orderError } = await supabaseAdmin
    .from("orders")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", order.id)
    .eq("status", order.status)
    .select("id");

  if (orderError) {
    throw createError(orderError.message, 500, "CANCEL_FAILED");
  }

  if ((cancelledOrder ?? []).length === 0) {
    throw createError(
      "This order changed state while it was being cancelled",
      403,
      "STATUS_LOCKED",
    );
  }

  const { error: itemsError } = await supabaseAdmin
    .from("order_items")
    .update({ status: "cancelled" })
    .eq("order_id", order.id)
    .neq("status", "cancelled");

  if (itemsError) {
    // Put the order back the way it was rather than leaving it cancelled with
    // live items underneath: without a transaction this rollback is what makes
    // the whole action retryable.
    const { error: rollbackError } = await supabaseAdmin
      .from("orders")
      .update({ status: order.status, cancelled_at: null })
      .eq("id", order.id)
      .eq("status", "cancelled");

    if (rollbackError) {
      logger.error(
        { err: rollbackError, order_id: order.id, original_status: order.status },
        "order was cancelled but its items were not, and the rollback failed",
      );
    }

    throw createError(itemsError.message, 500, "CANCEL_FAILED");
  }

  return recordCancellationAudit({
    actor,
    action: "cancel_order",
    referenceType: "order",
    referenceId: order.id,
    order,
    oldStatus: order.status,
    newStatus: "cancelled",
    reason,
    paid,
  });
};

/** Statuses of the items an action would cancel: one item, or every live item. */
const targetItemStatuses = async (orderId: string, itemId: string | null): Promise<string[]> => {
  const base = supabaseAdmin.from("order_items").select("status").eq("order_id", orderId);
  const { data, error } = itemId ? await base.eq("id", itemId) : await base.neq("status", "cancelled");

  if (error) {
    throw createError(error.message, 500, "ITEM_LOOKUP_FAILED");
  }

  return (data ?? []).map((i) => (i as Record<string, unknown>)["status"] as string);
};

export const handleCancellationRequest = async (params: {
  requestId: string;
  status: "approved" | "rejected";
  rejection_reason?: string;
  employeeId: string;
}): Promise<object> => {
  const { requestId, status, rejection_reason, employeeId } = params;

  const { data: request, error: reqError } = await supabaseAdmin
    .from("cancellation_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();

  if (reqError) {
    throw createError(reqError.message, 500, "REQUEST_LOOKUP_FAILED");
  }

  if (!request) {
    throw createError("Cancellation request not found", 404, "REQUEST_NOT_FOUND");
  }

  const requestRow = request as Record<string, unknown>;
  const previousStatus = requestRow["status"] as string;

  if (previousStatus !== "pending") {
    throw createError(
      "This cancellation request was already resolved",
      400,
      "REQUEST_ALREADY_RESOLVED",
    );
  }

  // Resolve the request against the branch of ITS order, so a waiter from
  // another branch cannot approve cancellations that are not theirs.
  const order = await loadOrderContext(requestRow["order_id"] as string);
  const actor = await authorizeStaffForOrder(employeeId, order);
  const itemId = (requestRow["order_item_id"] as string | null) ?? null;

  const paid = itemId
    ? (await isItemPaid(itemId, order.session_id)) || (await isOrderPaid(order))
    : await isOrderPaid(order);

  if (status === "approved") {
    // Approving performs the cancellation, so it must satisfy every rule,
    // including the current state of the items it would cancel.
    assertCancellationAllowed({
      order,
      actor,
      paid,
      itemStatuses: await targetItemStatuses(order.id, itemId),
    });
  } else {
    assertCancellationRole(actor);
  }

  const { data: resolved, error } = await supabaseAdmin
    .from("cancellation_requests")
    .update({
      status,
      rejection_reason: rejection_reason ?? null,
      // cancellation_requests.resolved_by identifies staff by employees.id.
      resolved_by: actor.employeeId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    // Claim the request only while it is still pending, so two waiters
    // resolving at the same time cannot both win.
    .eq("status", "pending")
    .select("*");

  if (error) {
    throw createError(error.message, 500, "UPDATE_FAILED");
  }

  const data = (resolved ?? [])[0];

  if (!data) {
    throw createError(
      "This cancellation request was already resolved",
      400,
      "REQUEST_ALREADY_RESOLVED",
    );
  }

  let audited = await recordCancellationAudit({
    actor,
    action: "resolve_cancellation_request",
    referenceType: "cancellation_request",
    referenceId: requestId,
    order,
    oldStatus: previousStatus,
    newStatus: status,
    reason: (requestRow["reason"] as string | null) ?? null,
    paid,
    extra: {
      resolution: status,
      rejection_reason: rejection_reason ?? null,
      order_item_id: itemId,
    },
  });

  if (status === "approved") {
    try {
      const cancelAudited = await cancelNow({
        order,
        actor,
        itemId,
        reason: (requestRow["reason"] as string | null) ?? null,
        paid,
      });
      audited = audited && cancelAudited;
    } catch (err) {
      // The request must never stay 'approved' with nothing cancelled behind it.
      const { error: rollbackError } = await supabaseAdmin
        .from("cancellation_requests")
        .update({ status: "pending", resolved_by: null, resolved_at: null })
        .eq("id", requestId);

      if (rollbackError) {
        logger.error(
          { err: rollbackError, request_id: requestId },
          "cancellation request stayed resolved but the cancellation failed",
        );
      }

      throw err;
    }
  }

  return { ...(data as Record<string, unknown>), audit_logged: audited };
};
