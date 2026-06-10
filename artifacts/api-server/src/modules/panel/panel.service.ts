import { randomBytes, randomInt } from "node:crypto";
import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

const startOfToday = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const todayDateStr = (): string => new Date().toISOString().slice(0, 10);

type Period = "today" | "week" | "month" | "custom";

const resolvePeriod = (period: Period, from?: string, to?: string): { fromISO: string; toISO: string } => {
  const now = new Date();
  if (period === "custom") {
    if (!from || !to) {
      throw createError("from and to are required for custom period", 400, "MISSING_RANGE");
    }
    return { fromISO: new Date(`${from}T00:00:00`).toISOString(), toISO: new Date(`${to}T23:59:59`).toISOString() };
  }

  const start = new Date(now);
  if (period === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (period === "week") {
    start.setDate(start.getDate() - 7);
  } else {
    start.setDate(start.getDate() - 30);
  }

  return { fromISO: start.toISOString(), toISO: now.toISOString() };
};

export const getDashboard = async (branchId: string): Promise<object> => {
  const today = startOfToday();
  const todayStr = todayDateStr();

  const [
    activeTables,
    ordersInProgress,
    payments,
    completedOrders,
    reservations,
    alerts,
    recentOrders,
  ] = await Promise.all([
    supabaseAdmin
      .from("table_sessions")
      .select("id, tables!inner(branch_id)", { count: "exact", head: true })
      .eq("tables.branch_id", branchId)
      .eq("status", "active"),
    supabaseAdmin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("branch_id", branchId)
      .in("status", ["received", "in_preparation"]),
    supabaseAdmin
      .from("payments")
      .select("amount")
      .eq("branch_id", branchId)
      .eq("status", "completed")
      .gte("created_at", today),
    supabaseAdmin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("branch_id", branchId)
      .eq("status", "delivered")
      .gte("created_at", today),
    supabaseAdmin
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("branch_id", branchId)
      .eq("date", todayStr)
      .in("status", ["pending", "confirmed"]),
    supabaseAdmin
      .from("restaurant_alerts")
      .select("id", { count: "exact", head: true })
      .eq("branch_id", branchId)
      .eq("status", "pending"),
    supabaseAdmin
      .from("orders")
      .select("id, status, total_amount, created_at, table_sessions(tables(table_number))")
      .eq("branch_id", branchId)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const dashboardResults: Array<{ error: { message: string } | null }> = [
    activeTables,
    ordersInProgress,
    payments,
    completedOrders,
    reservations,
    alerts,
    recentOrders,
  ];
  const dashboardFailed = dashboardResults.find((r) => r.error);
  if (dashboardFailed?.error) {
    throw createError(dashboardFailed.error.message, 500, "DASHBOARD_QUERY_FAILED");
  }

  const dailyRevenue = (payments.data ?? []).reduce(
    (sum: number, p: Record<string, unknown>) => sum + ((p["amount"] as number) ?? 0),
    0,
  );

  return {
    active_tables: activeTables.count ?? 0,
    orders_in_progress: ordersInProgress.count ?? 0,
    daily_revenue: dailyRevenue,
    completed_orders_today: completedOrders.count ?? 0,
    todays_reservations: reservations.count ?? 0,
    pending_alerts: alerts.count ?? 0,
    recent_orders: recentOrders.data ?? [],
  };
};

export const getStatistics = async (params: {
  branchId: string;
  period: Period;
  from?: string;
  to?: string;
}): Promise<object> => {
  const { branchId, period, from, to } = params;
  const { fromISO, toISO } = resolvePeriod(period, from, to);

  const [paymentsRes, ordersRes, ratingsRes] = await Promise.all([
    supabaseAdmin
      .from("payments")
      .select("amount")
      .eq("branch_id", branchId)
      .eq("status", "completed")
      .gte("created_at", fromISO)
      .lte("created_at", toISO),
    supabaseAdmin
      .from("orders")
      .select("id, order_type, status, user_id, created_at, order_items(product_id, quantity, unit_price, products(name))")
      .eq("branch_id", branchId)
      .gte("created_at", fromISO)
      .lte("created_at", toISO),
    supabaseAdmin
      .from("restaurant_ratings")
      .select("rating")
      .eq("branch_id", branchId)
      .gte("created_at", fromISO)
      .lte("created_at", toISO),
  ]);

  const statResults: Array<{ error: { message: string } | null }> = [paymentsRes, ordersRes, ratingsRes];
  const statFailed = statResults.find((r) => r.error);
  if (statFailed?.error) {
    throw createError(statFailed.error.message, 500, "STATISTICS_QUERY_FAILED");
  }

  const payments = (paymentsRes.data ?? []) as Array<Record<string, unknown>>;
  const orders = (ordersRes.data ?? []) as Array<Record<string, unknown>>;
  const ratings = (ratingsRes.data ?? []) as Array<Record<string, unknown>>;

  const salesTotal = payments.reduce((sum, p) => sum + ((p["amount"] as number) ?? 0), 0);
  const orderCount = orders.length;
  const averageTicket = orderCount > 0 ? Math.round((salesTotal / orderCount) * 100) / 100 : 0;

  const productAgg = new Map<string, { name: string; quantity: number; revenue: number }>();
  for (const o of orders) {
    const items = (o["order_items"] as Array<Record<string, unknown>>) ?? [];
    for (const it of items) {
      const pid = it["product_id"] as string;
      const qty = (it["quantity"] as number) ?? 0;
      const unitPrice = (it["unit_price"] as number) ?? 0;
      const name = ((it["products"] as Record<string, unknown> | null)?.["name"] as string) ?? "Unknown";
      const existing = productAgg.get(pid) ?? { name, quantity: 0, revenue: 0 };
      existing.quantity += qty;
      existing.revenue += qty * unitPrice;
      productAgg.set(pid, existing);
    }
  }

  const sortedProducts = [...productAgg.entries()].map(([product_id, v]) => ({ product_id, ...v }));
  sortedProducts.sort((a, b) => b.quantity - a.quantity);
  const topProducts = sortedProducts.slice(0, 10);
  const bottomProducts = [...sortedProducts].sort((a, b) => a.quantity - b.quantity).slice(0, 5);

  const peakHours: Record<number, number> = {};
  const ordersByType: Record<string, number> = {};
  let cancelledCount = 0;

  for (const o of orders) {
    const hour = new Date(o["created_at"] as string).getHours();
    peakHours[hour] = (peakHours[hour] ?? 0) + 1;
    const type = (o["order_type"] as string) ?? "unknown";
    ordersByType[type] = (ordersByType[type] ?? 0) + 1;
    if (o["status"] === "cancelled") cancelledCount += 1;
  }

  const usersInPeriod = [...new Set(orders.map((o) => o["user_id"] as string).filter(Boolean))];

  const { data: priorOrders } = await supabaseAdmin
    .from("orders")
    .select("user_id")
    .eq("branch_id", branchId)
    .lt("created_at", fromISO);

  const priorUsers = new Set(
    ((priorOrders ?? []) as Array<Record<string, unknown>>).map((o) => o["user_id"] as string),
  );

  let newUsers = 0;
  let returningUsers = 0;
  for (const uid of usersInPeriod) {
    if (priorUsers.has(uid)) returningUsers += 1;
    else newUsers += 1;
  }

  const averageRating =
    ratings.length > 0
      ? Math.round((ratings.reduce((s, r) => s + ((r["rating"] as number) ?? 0), 0) / ratings.length) * 100) / 100
      : 0;

  const cancellationRate = orderCount > 0 ? Math.round((cancelledCount / orderCount) * 10000) / 100 : 0;

  return {
    sales_total: salesTotal,
    order_count: orderCount,
    average_ticket: averageTicket,
    top_products: topProducts,
    bottom_products: bottomProducts,
    peak_hours: peakHours,
    orders_by_type: ordersByType,
    new_vs_returning: { new: newUsers, returning: returningUsers },
    average_rating: averageRating,
    cancellation_rate: cancellationRate,
  };
};

export const getEmployees = async (branchId: string): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("employee_branches")
    .select("employees(id, full_name, email, phone, role, is_active)")
    .eq("branch_id", branchId);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => row["employees"])
    .filter((e): e is object => e !== null);
};

export const createEmployee = async (params: {
  branchId: string;
  full_name: string;
  email: string;
  password: string;
  phone?: string;
  role: "admin" | "manager" | "kitchen" | "waiter";
}): Promise<object> => {
  const { branchId, full_name, email, password, phone, role } = params;

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, role },
  });

  if (authError || !authData.user) {
    throw createError(authError?.message ?? "Failed to create auth user", 400, "AUTH_CREATE_FAILED");
  }

  const userId = authData.user.id;

  const { data: employee, error: empError } = await supabaseAdmin
    .from("employees")
    .insert({
      user_id: userId,
      full_name,
      email,
      phone: phone ?? null,
      role,
      is_active: true,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (empError || !employee) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw createError(empError?.message ?? "Failed to create employee", 500, "EMPLOYEE_CREATE_FAILED");
  }

  const employeeId = (employee as Record<string, unknown>)["id"] as string;

  const { error: linkError } = await supabaseAdmin
    .from("employee_branches")
    .insert({ employee_id: employeeId, branch_id: branchId });

  if (linkError) {
    await supabaseAdmin.from("employees").delete().eq("id", employeeId);
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw createError(linkError.message, 500, "LINK_FAILED");
  }

  return employee;
};

export const updateEmployee = async (params: {
  employeeId: string;
  updates: Record<string, unknown>;
}): Promise<object> => {
  const { employeeId, updates } = params;
  const allowed: Record<string, unknown> = {};
  for (const key of ["full_name", "phone", "role"]) {
    if (updates[key] !== undefined) allowed[key] = updates[key];
  }

  const { data, error } = await supabaseAdmin
    .from("employees")
    .update(allowed)
    .eq("id", employeeId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Employee not found", 404, "NOT_FOUND");
  }

  return data;
};

export const deactivateEmployee = async (params: {
  employeeId: string;
  termination_reason_id: string;
}): Promise<object> => {
  const { employeeId, termination_reason_id } = params;

  const { data, error } = await supabaseAdmin
    .from("employees")
    .update({
      is_active: false,
      termination_reason_id,
      terminated_at: new Date().toISOString(),
    })
    .eq("id", employeeId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Employee not found", 404, "NOT_FOUND");
  }

  return data;
};

export const reactivateEmployee = async (employeeId: string): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .update({
      is_active: true,
      termination_reason_id: null,
      terminated_at: null,
    })
    .eq("id", employeeId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Employee not found", 404, "NOT_FOUND");
  }

  return data;
};

export const getWaiterAssignments = async (branchId: string): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("table_waiter_assignments")
    .select("*, tables!inner(branch_id, table_number), employees(full_name)")
    .eq("tables.branch_id", branchId)
    .eq("is_active", true);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return data ?? [];
};

export const setWaiterAssignments = async (params: {
  employee_id: string;
  table_ids: string[];
}): Promise<object[]> => {
  const { employee_id, table_ids } = params;

  await supabaseAdmin
    .from("table_waiter_assignments")
    .update({ is_active: false })
    .eq("employee_id", employee_id)
    .eq("is_active", true);

  if (table_ids.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("table_waiter_assignments")
    .insert(
      table_ids.map((table_id) => ({
        employee_id,
        table_id,
        is_active: true,
        created_at: new Date().toISOString(),
      })),
    )
    .select("*");

  if (error) {
    throw createError(error.message, 500, "ASSIGN_FAILED");
  }

  return data ?? [];
};

export const getClients = async (params: {
  branchId: string;
  segment?: "frequent" | "new" | "inactive";
  page: number;
  limit: number;
}): Promise<{ clients: object[]; total: number; page: number; limit: number }> => {
  const { branchId, segment, page, limit } = params;

  const { data: orders, error } = await supabaseAdmin
    .from("orders")
    .select("user_id, total_amount, created_at")
    .eq("branch_id", branchId)
    .neq("status", "cancelled")
    .not("user_id", "is", null);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const byUser = new Map<string, { total_orders: number; total_spent: number; last_visit: string; first_visit: string }>();
  for (const o of (orders ?? []) as Array<Record<string, unknown>>) {
    const uid = o["user_id"] as string;
    const createdAt = o["created_at"] as string;
    const amount = (o["total_amount"] as number) ?? 0;
    const entry = byUser.get(uid) ?? { total_orders: 0, total_spent: 0, last_visit: createdAt, first_visit: createdAt };
    entry.total_orders += 1;
    entry.total_spent += amount;
    if (createdAt > entry.last_visit) entry.last_visit = createdAt;
    if (createdAt < entry.first_visit) entry.first_visit = createdAt;
    byUser.set(uid, entry);
  }

  const now = Date.now();
  const dayMs = 1000 * 60 * 60 * 24;

  let userIds = [...byUser.keys()];

  userIds = userIds.filter((uid) => {
    const e = byUser.get(uid)!;
    if (segment === "frequent") return e.total_orders >= 5;
    if (segment === "new") return (now - new Date(e.first_visit).getTime()) / dayMs <= 30;
    if (segment === "inactive") return (now - new Date(e.last_visit).getTime()) / dayMs >= 60;
    return true;
  });

  const total = userIds.length;
  const pageIds = userIds.slice((page - 1) * limit, (page - 1) * limit + limit);

  const { data: users } = await supabaseAdmin
    .from("users")
    .select("id, full_name")
    .in("id", pageIds.length > 0 ? pageIds : ["00000000-0000-0000-0000-000000000000"]);

  const { data: ratingsData } = await supabaseAdmin
    .from("restaurant_ratings")
    .select("user_id, rating")
    .eq("branch_id", branchId)
    .in("user_id", pageIds.length > 0 ? pageIds : ["00000000-0000-0000-0000-000000000000"]);

  const ratingsByUser = new Map<string, number[]>();
  for (const r of (ratingsData ?? []) as Array<Record<string, unknown>>) {
    const uid = r["user_id"] as string;
    const arr = ratingsByUser.get(uid) ?? [];
    arr.push((r["rating"] as number) ?? 0);
    ratingsByUser.set(uid, arr);
  }

  const usersById = new Map(
    ((users ?? []) as Array<Record<string, unknown>>).map((u) => [u["id"] as string, u["full_name"]]),
  );

  const clients = pageIds.map((uid) => {
    const e = byUser.get(uid)!;
    const ratings = ratingsByUser.get(uid) ?? [];
    const avgRating =
      ratings.length > 0 ? Math.round((ratings.reduce((s, v) => s + v, 0) / ratings.length) * 100) / 100 : null;
    return {
      user_id: uid,
      full_name: usersById.get(uid) ?? null,
      total_visits: e.total_orders,
      total_orders: e.total_orders,
      total_spent: e.total_spent,
      last_visit: e.last_visit,
      average_rating_given: avgRating,
    };
  });

  return { clients, total, page, limit };
};

export const getClientProfile = async (params: {
  userId: string;
  branchId: string;
}): Promise<object> => {
  const { userId, branchId } = params;

  const [userRes, ordersRes, ratingsRes] = await Promise.all([
    supabaseAdmin.from("users").select("id, full_name, email, phone").eq("id", userId).single(),
    supabaseAdmin
      .from("orders")
      .select("id, status, total_amount, created_at, order_items(product_id, quantity, products(name))")
      .eq("branch_id", branchId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabaseAdmin.from("restaurant_ratings").select("rating, created_at").eq("branch_id", branchId).eq("user_id", userId),
  ]);

  if (userRes.error || !userRes.data) {
    throw createError("Client not found", 404, "NOT_FOUND");
  }

  const orders = (ordersRes.data ?? []) as Array<Record<string, unknown>>;
  const totalSpent = orders
    .filter((o) => o["status"] !== "cancelled")
    .reduce((sum, o) => sum + ((o["total_amount"] as number) ?? 0), 0);

  const productCount = new Map<string, { name: string; quantity: number }>();
  for (const o of orders) {
    const items = (o["order_items"] as Array<Record<string, unknown>>) ?? [];
    for (const it of items) {
      const pid = it["product_id"] as string;
      const name = ((it["products"] as Record<string, unknown> | null)?.["name"] as string) ?? "Unknown";
      const entry = productCount.get(pid) ?? { name, quantity: 0 };
      entry.quantity += (it["quantity"] as number) ?? 0;
      productCount.set(pid, entry);
    }
  }

  const favoriteProducts = [...productCount.entries()]
    .map(([product_id, v]) => ({ product_id, ...v }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5);

  return {
    user: userRes.data,
    total_visits: orders.length,
    total_spent: totalSpent,
    orders,
    ratings_given: ratingsRes.data ?? [],
    favorite_products: favoriteProducts,
  };
};

export const getBranchSettings = async (branchId: string): Promise<object> => {
  const [branchRes, hoursRes, photosRes, methodsRes] = await Promise.all([
    supabaseAdmin.from("branches").select("*").eq("id", branchId).single(),
    supabaseAdmin.from("branch_hours").select("*").eq("branch_id", branchId).order("day_of_week", { ascending: true }),
    supabaseAdmin.from("branch_photos").select("*").eq("branch_id", branchId).order("display_order", { ascending: true }),
    supabaseAdmin.from("branch_payment_methods").select("*").eq("branch_id", branchId),
  ]);

  if (branchRes.error || !branchRes.data) {
    throw createError("Branch not found", 404, "NOT_FOUND");
  }

  return {
    ...(branchRes.data as object),
    hours: hoursRes.data ?? [],
    photos: photosRes.data ?? [],
    payment_methods: methodsRes.data ?? [],
  };
};

export const updateBranchSettings = async (params: {
  branchId: string;
  updates: Record<string, unknown>;
  employeeId: string;
}): Promise<object> => {
  const { branchId, updates, employeeId } = params;

  const allowedKeys = [
    "name",
    "address",
    "latitude",
    "longitude",
    "phone",
    "operation_mode",
    "pickup_enabled",
    "advance_order_enabled",
    "allows_split_invoice",
  ];
  const allowed: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (updates[key] !== undefined) allowed[key] = updates[key];
  }

  const { data, error } = await supabaseAdmin
    .from("branches")
    .update(allowed)
    .eq("id", branchId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Branch not found", 404, "NOT_FOUND");
  }

  await supabaseAdmin.from("audit_log").insert({
    actor_id: employeeId,
    action: "update_branch_settings",
    entity_type: "branch",
    entity_id: branchId,
    changes: allowed,
    created_at: new Date().toISOString(),
  });

  return data;
};

export const replaceBranchHours = async (params: {
  branchId: string;
  hours: Array<{ day_of_week: number; open_time: string; close_time: string; is_closed: boolean }>;
}): Promise<object[]> => {
  const { branchId, hours } = params;

  await supabaseAdmin.from("branch_hours").delete().eq("branch_id", branchId);

  if (hours.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("branch_hours")
    .insert(hours.map((h) => ({ ...h, branch_id: branchId })))
    .select("*");

  if (error) {
    throw createError(error.message, 500, "UPDATE_FAILED");
  }

  return data ?? [];
};

export const addBranchPhoto = async (params: {
  branchId: string;
  photo_url: string;
  is_logo?: boolean;
  display_order?: number;
}): Promise<object> => {
  const { branchId, photo_url, is_logo, display_order } = params;

  const { data, error } = await supabaseAdmin
    .from("branch_photos")
    .insert({
      branch_id: branchId,
      photo_url,
      is_logo: is_logo ?? false,
      display_order: display_order ?? 0,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to add photo", 500, "CREATE_FAILED");
  }

  return data;
};

export const deleteBranchPhoto = async (photoId: string): Promise<void> => {
  const { error } = await supabaseAdmin.from("branch_photos").delete().eq("id", photoId);
  if (error) {
    throw createError(error.message, 400, "DELETE_FAILED");
  }
};

export const setPaymentMethods = async (params: {
  branchId: string;
  methods: Array<{ payment_method: string; is_enabled: boolean }>;
}): Promise<object[]> => {
  const { branchId, methods } = params;

  if (methods.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("branch_payment_methods")
    .upsert(
      methods.map((m) => ({ branch_id: branchId, payment_method: m.payment_method, is_enabled: m.is_enabled })),
      { onConflict: "branch_id,payment_method" },
    )
    .select("*");

  if (error) {
    throw createError(error.message, 500, "UPSERT_FAILED");
  }

  return data ?? [];
};

export const getTables = async (branchId: string): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("tables")
    .select("*, table_sessions(id, status)")
    .eq("branch_id", branchId)
    .order("table_number", { ascending: true });

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return (data ?? []) as object[];
};

export const createTable = async (params: {
  branchId: string;
  table_number: string;
  capacity?: number;
}): Promise<object> => {
  const { branchId, table_number, capacity } = params;

  const token = randomBytes(16).toString("hex");
  const pin = randomInt(1000, 9999).toString();
  const qrCodeUrl = `/t/${branchId}/${token}`;

  const { data, error } = await supabaseAdmin
    .from("tables")
    .insert({
      branch_id: branchId,
      table_number,
      capacity: capacity ?? null,
      qr_code_url: qrCodeUrl,
      token,
      pin,
      is_active: true,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create table", 500, "CREATE_FAILED");
  }

  return data;
};

export const updateTable = async (params: {
  tableId: string;
  updates: Record<string, unknown>;
}): Promise<object> => {
  const { tableId, updates } = params;
  const allowed: Record<string, unknown> = {};
  for (const key of ["capacity", "is_active"]) {
    if (updates[key] !== undefined) allowed[key] = updates[key];
  }

  const { data, error } = await supabaseAdmin
    .from("tables")
    .update(allowed)
    .eq("id", tableId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Table not found", 404, "NOT_FOUND");
  }

  return data;
};

export const getAlerts = async (params: {
  branchId: string;
  status?: string;
  role: string;
}): Promise<object[]> => {
  const { branchId, status, role } = params;

  let query = supabaseAdmin
    .from("restaurant_alerts")
    .select("*")
    .eq("branch_id", branchId)
    .order("created_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const alerts = (data ?? []) as Array<Record<string, unknown>>;

  // Admins and managers see every alert. Other roles (kitchen, waiter) only
  // see alerts targeted at their role; an absent/null target_role is treated
  // as visible to everyone. Filtering in JS keeps this safe whether or not a
  // target_role column is present on the row.
  if (role === "admin" || role === "manager") {
    return alerts;
  }

  return alerts.filter((a) => {
    const target = a["target_role"];
    return target === null || target === undefined || target === role;
  });
};

export const updateAlert = async (params: {
  alertId: string;
  status: "acknowledged" | "resolved";
  employeeId: string;
}): Promise<object> => {
  const { alertId, status, employeeId } = params;

  const update: Record<string, unknown> = { status };
  const now = new Date().toISOString();

  if (status === "acknowledged") {
    update["acknowledged_by"] = employeeId;
    update["acknowledged_at"] = now;
  } else {
    update["resolved_by"] = employeeId;
    update["resolved_at"] = now;
  }

  const { data, error } = await supabaseAdmin
    .from("restaurant_alerts")
    .update(update)
    .eq("id", alertId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Alert not found", 404, "NOT_FOUND");
  }

  return data;
};
