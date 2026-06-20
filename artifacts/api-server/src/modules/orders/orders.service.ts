import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

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
  created_by_employee?: string;
  user_id?: string;
  requested_time?: string;
}): Promise<object> => {
  const { session_id, branch_id, items, notes, order_type, created_by_employee, user_id, requested_time } = params;

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
  if (created_by_employee) orderInsert["created_by_employee"] = created_by_employee;
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
  return buildOrder({
    session_id: params.session_id,
    items: params.items,
    notes: params.notes,
    order_type: "traditional",
    created_by_employee: params.employee_id,
  });
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

export const linkOrderToSession = async (
  orderId: string,
  sessionId: string,
): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ session_id: sessionId, is_linked: true })
    .eq("id", orderId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to link order", 400, "LINK_FAILED");
  }

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

export const updateItemStatus = async (
  orderId: string,
  itemId: string,
  status: "in_preparation" | "ready" | "cancelled",
): Promise<object> => {
  const timestampField: Record<string, string> = {
    in_preparation: "in_preparation_at",
    ready: "ready_at",
    cancelled: "cancelled_at",
  };

  const { data: item, error: itemError } = await supabaseAdmin
    .from("order_items")
    .update({ status, [timestampField[status]]: new Date().toISOString() })
    .eq("id", itemId)
    .eq("order_id", orderId)
    .select("*")
    .single();

  if (itemError || !item) {
    throw createError(itemError?.message ?? "Item not found", 404, "ITEM_NOT_FOUND");
  }

  const { data: allItems } = await supabaseAdmin
    .from("order_items")
    .select("status")
    .eq("order_id", orderId)
    .neq("status", "cancelled");

  const allReady = (allItems ?? []).every(
    (i: Record<string, unknown>) => i["status"] === "ready",
  );

  if (allReady) {
    await supabaseAdmin
      .from("orders")
      .update({ status: "ready", ready_at: new Date().toISOString() })
      .eq("id", orderId);
  }

  return item;
};

export const updateOrderStatus = async (
  orderId: string,
  status: "ready" | "delivered",
): Promise<object> => {
  const timestampField: Record<string, string> = {
    ready: "ready_at",
    delivered: "delivered_at",
  };

  await supabaseAdmin
    .from("order_items")
    .update({ status, [timestampField[status]]: new Date().toISOString() })
    .eq("order_id", orderId)
    .neq("status", "cancelled");

  const { data, error } = await supabaseAdmin
    .from("orders")
    .update({ status, [timestampField[status]]: new Date().toISOString() })
    .eq("id", orderId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Order not found", 404, "ORDER_NOT_FOUND");
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

  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("id, status")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    throw createError("Order not found", 404, "ORDER_NOT_FOUND");
  }

  const status = (order as Record<string, unknown>)["status"] as string;

  if (status === "ready" || status === "delivered") {
    throw createError("Cannot cancel completed orders", 400, "CANNOT_CANCEL");
  }

  if (status === "in_preparation") {
    const { data: request, error: reqError } = await supabaseAdmin
      .from("cancellation_requests")
      .insert({
        order_id: orderId,
        item_id: item_id ?? null,
        reason: reason ?? null,
        requested_by: userId,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (reqError || !request) {
      throw createError(reqError?.message ?? "Failed to create cancellation request", 500, "REQUEST_FAILED");
    }

    return {
      message: "Your waiter will come to confirm",
      request_id: (request as Record<string, unknown>)["id"],
    };
  }

  if (item_id) {
    await supabaseAdmin
      .from("order_items")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", item_id)
      .eq("order_id", orderId);
  } else {
    await supabaseAdmin
      .from("order_items")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("order_id", orderId);

    await supabaseAdmin
      .from("orders")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", orderId);
  }

  return { success: true };
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
    .single();

  if (reqError || !request) {
    throw createError("Cancellation request not found", 404, "REQUEST_NOT_FOUND");
  }

  const { data, error } = await supabaseAdmin
    .from("cancellation_requests")
    .update({
      status,
      rejection_reason: rejection_reason ?? null,
      resolved_by: employeeId,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Update failed", 500, "UPDATE_FAILED");
  }

  if (status === "approved") {
    const orderId = (request as Record<string, unknown>)["order_id"] as string;
    const itemId = (request as Record<string, unknown>)["item_id"] as string | null;

    if (itemId) {
      await supabaseAdmin
        .from("order_items")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("id", itemId);
    } else {
      await supabaseAdmin
        .from("order_items")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("order_id", orderId);

      await supabaseAdmin
        .from("orders")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
        .eq("id", orderId);
    }
  }

  return data;
};
