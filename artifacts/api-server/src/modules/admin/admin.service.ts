import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

type Row = Record<string, unknown>;

const now = (): Date => new Date();

const startOfTodayISO = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const startOfMonthISO = (): string => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
};

const daysAgoISO = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

const CATALOG_TABLES: Record<string, string> = {
  dietary_restrictions: "master_dietary_restrictions",
  cuisine_types: "master_cuisine_types",
  banks: "master_banks",
  card_levels: "master_card_levels",
  card_networks: "master_card_networks",
  languages: "master_languages",
  waiter_call_reasons: "master_waiter_call_reasons",
  termination_reasons: "master_termination_reasons",
};

const resolveCatalogTable = (catalogType: string): string => {
  const table = CATALOG_TABLES[catalogType];
  if (!table) {
    throw createError(`Unknown catalog type: ${catalogType}`, 400, "INVALID_CATALOG_TYPE");
  }
  return table;
};

const failIfAnyError = (
  results: Array<{ error: { message: string } | null }>,
  code: string,
): void => {
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    throw createError(failed.error.message, 500, code);
  }
};

// ----------------------------- DASHBOARD ------------------------------------

export const getDashboard = async (): Promise<object> => {
  const monthStart = startOfMonthISO();
  const todayStart = startOfTodayISO();
  const weekStart = daysAgoISO(7);
  const thirtyDaysAgo = daysAgoISO(30);
  // Pull orders over the wider of the two windows we report on.
  const ordersWindowStart = monthStart < thirtyDaysAgo ? monthStart : thirtyDaysAgo;

  const [
    restaurantsTotal,
    restaurantsActive,
    restaurantsInactive,
    restaurantsNew,
    usersTotal,
    usersNew,
    usersWebToApp,
    premiumActiveCount,
    premiumSubs,
    ordersWindow,
    ratings,
    pointsRows,
    couponRows,
    reservationRows,
  ] = await Promise.all([
    supabaseAdmin.from("restaurants").select("*", { count: "exact", head: true }),
    supabaseAdmin.from("restaurants").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabaseAdmin.from("restaurants").select("*", { count: "exact", head: true }).eq("is_active", false),
    supabaseAdmin
      .from("restaurants")
      .select("*", { count: "exact", head: true })
      .gte("created_at", monthStart),
    supabaseAdmin.from("users").select("*", { count: "exact", head: true }),
    supabaseAdmin.from("users").select("*", { count: "exact", head: true }).gte("created_at", monthStart),
    supabaseAdmin
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("registration_source", "app"),
    supabaseAdmin
      .from("premium_subscriptions")
      .select("*", { count: "exact", head: true })
      .eq("status", "active"),
    supabaseAdmin
      .from("premium_subscriptions")
      .select("id, status, premium_plans(price)")
      .eq("status", "active"),
    supabaseAdmin
      .from("orders")
      .select("id, user_id, order_type, total_amount, status, created_at")
      .gte("created_at", ordersWindowStart),
    supabaseAdmin.from("restaurant_ratings").select("rating, created_at"),
    supabaseAdmin
      .from("points_ledger")
      .select("amount, type, created_at")
      .gte("created_at", monthStart),
    supabaseAdmin.from("coupons").select("status, created_at").gte("created_at", monthStart),
    supabaseAdmin.from("reservations").select("status, created_at").gte("created_at", monthStart),
  ]);

  failIfAnyError(
    [
      restaurantsTotal,
      restaurantsActive,
      restaurantsInactive,
      restaurantsNew,
      usersTotal,
      usersNew,
      usersWebToApp,
      premiumActiveCount,
      premiumSubs,
      ordersWindow,
      ratings,
      pointsRows,
      couponRows,
      reservationRows,
    ],
    "DASHBOARD_QUERY_FAILED",
  );

  // Operations derived from the orders window.
  const orders = (ordersWindow.data ?? []) as Row[];
  const ordersToday = orders.filter((o) => (o["created_at"] as string) >= todayStart);
  const ordersThisWeek = orders.filter((o) => (o["created_at"] as string) >= weekStart);
  const ordersThisMonth = orders.filter((o) => (o["created_at"] as string) >= monthStart);
  const activeUserIds = new Set(
    orders
      .filter((o) => (o["created_at"] as string) >= thirtyDaysAgo && o["user_id"])
      .map((o) => o["user_id"] as string),
  );

  const traditionalCount = ordersThisMonth.filter((o) => o["order_type"] === "traditional").length;
  const digitalCount = ordersThisMonth.length - traditionalCount;

  const todayTickets = ordersToday.map((o) => (o["total_amount"] as number) ?? 0);
  const avgTicketToday =
    todayTickets.length > 0
      ? Math.round((todayTickets.reduce((s, v) => s + v, 0) / todayTickets.length) * 100) / 100
      : 0;

  const hourBuckets = new Array<number>(24).fill(0);
  for (const o of ordersToday) {
    const h = new Date(o["created_at"] as string).getHours();
    hourBuckets[h] = (hourBuckets[h] ?? 0) + 1;
  }
  let peakHourToday: number | null = null;
  let peakCount = 0;
  hourBuckets.forEach((c, h) => {
    if (c > peakCount) {
      peakCount = c;
      peakHourToday = h;
    }
  });

  const monthCancelled = ordersThisMonth.filter((o) => o["status"] === "cancelled").length;
  const cancellationRate =
    ordersThisMonth.length > 0
      ? Math.round((monthCancelled / ordersThisMonth.length) * 10000) / 10000
      : 0;

  // Financial.
  const premiumRevenue = ((premiumSubs.data ?? []) as Row[]).reduce((sum, s) => {
    const plan = s["premium_plans"] as Row | Row[] | null;
    const price = Array.isArray(plan)
      ? ((plan[0]?.["price"] as number) ?? 0)
      : ((plan?.["price"] as number) ?? 0);
    return sum + price;
  }, 0);

  // Engagement.
  const ratingRows = (ratings.data ?? []) as Row[];
  const avgRating =
    ratingRows.length > 0
      ? Math.round((ratingRows.reduce((s, r) => s + ((r["rating"] as number) ?? 0), 0) / ratingRows.length) * 100) /
        100
      : 0;
  const reviewsThisMonth = ratingRows.filter((r) => (r["created_at"] as string) >= monthStart).length;

  const points = (pointsRows.data ?? []) as Row[];
  const pointsIssued = points
    .filter((p) => p["type"] === "earned")
    .reduce((s, p) => s + ((p["amount"] as number) ?? 0), 0);
  const pointsRedeemed = points
    .filter((p) => p["type"] === "redeemed")
    .reduce((s, p) => s + Math.abs((p["amount"] as number) ?? 0), 0);

  const coupons = (couponRows.data ?? []) as Row[];
  const couponsIssued = coupons.length;
  const couponsUsed = coupons.filter((c) => c["status"] === "used" || c["status"] === "redeemed").length;

  const reservations = (reservationRows.data ?? []) as Row[];
  const reservationsMade = reservations.length;
  const reservationsCancelled = reservations.filter((r) => r["status"] === "cancelled").length;

  return {
    restaurants: {
      total: restaurantsTotal.count ?? 0,
      active: restaurantsActive.count ?? 0,
      inactive: restaurantsInactive.count ?? 0,
      new_this_month: restaurantsNew.count ?? 0,
    },
    users: {
      total_registered: usersTotal.count ?? 0,
      new_this_month: usersNew.count ?? 0,
      active_last_30_days: activeUserIds.size,
      premium_count: premiumActiveCount.count ?? 0,
      web_to_app_conversion: usersWebToApp.count ?? 0,
    },
    operations: {
      orders_today: ordersToday.length,
      orders_this_week: ordersThisWeek.length,
      orders_this_month: ordersThisMonth.length,
      digital_vs_traditional_ratio: {
        digital: digitalCount,
        traditional: traditionalCount,
        ratio: traditionalCount > 0 ? Math.round((digitalCount / traditionalCount) * 100) / 100 : null,
      },
      avg_ticket_today: avgTicketToday,
      peak_hour_today: peakHourToday,
      cancellation_rate_this_month: cancellationRate,
    },
    financial: {
      commission_revenue_this_month: 0,
      premium_subscription_revenue: premiumRevenue,
      total_billed_this_month: 0,
    },
    engagement: {
      avg_restaurant_rating: avgRating,
      total_reviews_this_month: reviewsThisMonth,
      points_issued_this_month: pointsIssued,
      points_redeemed_this_month: pointsRedeemed,
      coupons_issued_vs_used: { issued: couponsIssued, used: couponsUsed },
      reservations_made_vs_cancelled: { made: reservationsMade, cancelled: reservationsCancelled },
    },
  };
};

// ----------------------- RESTAURANT MANAGEMENT ------------------------------

export const getRestaurants = async (params: {
  status?: string;
  cuisineType?: string;
  page: number;
  limit: number;
}): Promise<object> => {
  const { status, cuisineType, page, limit } = params;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("restaurants")
    .select("*, branches(id, name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status === "active") query = query.eq("is_active", true);
  if (status === "inactive") query = query.eq("is_active", false);
  if (cuisineType) query = query.eq("cuisine_type", cuisineType);

  const { data, error, count } = await query;
  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const restaurants = (data ?? []) as Row[];
  const branchIds: string[] = [];
  for (const r of restaurants) {
    const branches = (r["branches"] as Row[] | null) ?? [];
    for (const b of branches) branchIds.push(b["id"] as string);
  }

  const ordersByBranch = new Map<string, number>();
  const ratingsByBranch = new Map<string, { sum: number; n: number }>();

  if (branchIds.length > 0) {
    const [ordersRes, ratingsRes] = await Promise.all([
      supabaseAdmin.from("orders").select("branch_id").in("branch_id", branchIds),
      supabaseAdmin.from("restaurant_ratings").select("branch_id, rating").in("branch_id", branchIds),
    ]);
    failIfAnyError([ordersRes, ratingsRes], "FETCH_FAILED");

    for (const o of (ordersRes.data ?? []) as Row[]) {
      const bid = o["branch_id"] as string;
      ordersByBranch.set(bid, (ordersByBranch.get(bid) ?? 0) + 1);
    }
    for (const r of (ratingsRes.data ?? []) as Row[]) {
      const bid = r["branch_id"] as string;
      const acc = ratingsByBranch.get(bid) ?? { sum: 0, n: 0 };
      acc.sum += (r["rating"] as number) ?? 0;
      acc.n += 1;
      ratingsByBranch.set(bid, acc);
    }
  }

  const items = restaurants.map((r) => {
    const branches = (r["branches"] as Row[] | null) ?? [];
    let totalOrders = 0;
    let ratingSum = 0;
    let ratingN = 0;
    for (const b of branches) {
      const bid = b["id"] as string;
      totalOrders += ordersByBranch.get(bid) ?? 0;
      const acc = ratingsByBranch.get(bid);
      if (acc) {
        ratingSum += acc.sum;
        ratingN += acc.n;
      }
    }
    return {
      id: r["id"],
      name: r["name"],
      slug: r["slug"],
      plan: r["plan"] ?? null,
      status: r["is_active"] ? "active" : "inactive",
      branch_count: branches.length,
      total_orders: totalOrders,
      avg_rating: ratingN > 0 ? Math.round((ratingSum / ratingN) * 100) / 100 : 0,
    };
  });

  return {
    items,
    pagination: { page, limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limit) },
  };
};

export const createRestaurant = async (params: {
  name: string;
  slug: string;
  description?: string;
  branches: Array<{
    name: string;
    address: string;
    latitude?: number;
    longitude?: number;
    phone?: string;
    operation_mode?: string;
  }>;
}): Promise<object> => {
  const { name, slug, description, branches } = params;

  const { data: restaurant, error: restaurantError } = await supabaseAdmin
    .from("restaurants")
    .insert({ name, slug, description: description ?? null, is_active: true })
    .select()
    .single();

  if (restaurantError || !restaurant) {
    throw createError(restaurantError?.message ?? "Failed to create restaurant", 500, "CREATE_FAILED");
  }

  const restaurantId = (restaurant as Row)["id"] as string;

  const branchRows = branches.map((b) => ({
    restaurant_id: restaurantId,
    name: b.name,
    address: b.address,
    latitude: b.latitude ?? null,
    longitude: b.longitude ?? null,
    phone: b.phone ?? null,
    operation_mode: b.operation_mode ?? null,
    is_active: true,
  }));

  const { data: createdBranches, error: branchError } = await supabaseAdmin
    .from("branches")
    .insert(branchRows)
    .select();

  if (branchError) {
    await supabaseAdmin.from("restaurants").delete().eq("id", restaurantId);
    throw createError(branchError.message, 500, "CREATE_FAILED");
  }

  return { ...(restaurant as Row), branches: createdBranches ?? [] };
};

export const updateRestaurantStatus = async (params: {
  restaurantId: string;
  action: "activate" | "deactivate" | "suspend";
  deactivationReason?: string;
}): Promise<object> => {
  const { restaurantId, action, deactivationReason } = params;

  const updates: Row =
    action === "activate"
      ? { is_active: true, deactivation_reason: null, deactivated_at: null }
      : {
          is_active: false,
          deactivation_reason: deactivationReason ?? null,
          deactivated_at: now().toISOString(),
        };

  const { data, error } = await supabaseAdmin
    .from("restaurants")
    .update(updates)
    .eq("id", restaurantId)
    .select()
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Restaurant not found", 404, "NOT_FOUND");
  }

  return data;
};

// ------------------------- CATALOG MANAGEMENT -------------------------------

export const getCatalog = async (catalogType: string): Promise<object[]> => {
  const table = resolveCatalogTable(catalogType);
  const { data, error } = await supabaseAdmin.from(table).select("*").order("name", { ascending: true });
  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }
  return data ?? [];
};

export const createCatalogEntry = async (params: {
  catalogType: string;
  name: string;
  code?: string;
}): Promise<object> => {
  const { catalogType, name, code } = params;
  const table = resolveCatalogTable(catalogType);

  const payload: Row = { name };
  if (catalogType === "languages") {
    if (!code) {
      throw createError("code is required for languages", 400, "MISSING_FIELDS");
    }
    payload["code"] = code;
  }

  const { data, error } = await supabaseAdmin.from(table).insert(payload).select().single();
  if (error || !data) {
    throw createError(error?.message ?? "Failed to create entry", 500, "CREATE_FAILED");
  }
  return data;
};

export const updateCatalogEntry = async (params: {
  catalogType: string;
  entryId: string;
  updates: Row;
}): Promise<object> => {
  const { catalogType, entryId, updates } = params;
  const table = resolveCatalogTable(catalogType);

  const allowed: Row = {};
  if (updates["name"] !== undefined) allowed["name"] = updates["name"];
  if (updates["is_active"] !== undefined) allowed["is_active"] = updates["is_active"];

  if (Object.keys(allowed).length === 0) {
    throw createError("No updatable fields provided", 400, "NO_UPDATES");
  }

  const { data, error } = await supabaseAdmin.from(table).update(allowed).eq("id", entryId).select().single();
  if (error || !data) {
    throw createError(error?.message ?? "Entry not found", 404, "NOT_FOUND");
  }
  return data;
};

// ------------------------- PREMIUM MANAGEMENT -------------------------------

export const getPremiumPlans = async (): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("premium_plans")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }
  return data ?? [];
};

export const createPremiumPlan = async (params: {
  name: string;
  price: number;
  billing_period: string;
  double_points?: boolean;
  priority_reservations?: boolean;
  direct_promo_access?: boolean;
}): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("premium_plans")
    .insert({
      name: params.name,
      price: params.price,
      billing_period: params.billing_period,
      double_points: params.double_points ?? false,
      priority_reservations: params.priority_reservations ?? false,
      direct_promo_access: params.direct_promo_access ?? false,
    })
    .select()
    .single();
  if (error || !data) {
    throw createError(error?.message ?? "Failed to create plan", 500, "CREATE_FAILED");
  }
  return data;
};

export const updatePremiumPlan = async (params: { planId: string; updates: Row }): Promise<object> => {
  const { planId, updates } = params;
  const allowed: Row = {};
  for (const key of [
    "name",
    "price",
    "billing_period",
    "double_points",
    "priority_reservations",
    "direct_promo_access",
    "is_active",
  ]) {
    if (updates[key] !== undefined) allowed[key] = updates[key];
  }

  if (Object.keys(allowed).length === 0) {
    throw createError("No updatable fields provided", 400, "NO_UPDATES");
  }

  const { data, error } = await supabaseAdmin
    .from("premium_plans")
    .update(allowed)
    .eq("id", planId)
    .select()
    .single();
  if (error || !data) {
    throw createError(error?.message ?? "Plan not found", 404, "NOT_FOUND");
  }
  return data;
};

export const getSubscriptions = async (params: {
  status?: string;
  page: number;
  limit: number;
}): Promise<object> => {
  const { status, page, limit } = params;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("premium_subscriptions")
    .select("*, users(id, full_name, email), premium_plans(id, name, price)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // Default to active subscriptions when no explicit status filter is provided.
  query = query.eq("status", status ?? "active");

  const { data, error, count } = await query;
  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return {
    items: data ?? [],
    pagination: { page, limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limit) },
  };
};

// --------------------------- SUPPORT TICKETS --------------------------------

export const getTickets = async (params: {
  status?: string;
  priority?: string;
  page: number;
  limit: number;
}): Promise<object> => {
  const { status, priority, page, limit } = params;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("support_tickets")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (priority) query = query.eq("priority", priority);

  const { data, error, count } = await query;
  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return {
    items: data ?? [],
    pagination: { page, limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limit) },
  };
};

export const getTicket = async (ticketId: string): Promise<object> => {
  const { data: ticket, error } = await supabaseAdmin
    .from("support_tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle();

  if (error || !ticket) {
    throw createError(error?.message ?? "Ticket not found", 404, "NOT_FOUND");
  }

  const { data: messages, error: messagesError } = await supabaseAdmin
    .from("support_ticket_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  if (messagesError) {
    throw createError(messagesError.message, 500, "FETCH_FAILED");
  }

  return { ...(ticket as Row), messages: messages ?? [] };
};

export const updateTicket = async (params: { ticketId: string; updates: Row }): Promise<object> => {
  const { ticketId, updates } = params;
  const allowed: Row = {};
  if (updates["status"] !== undefined) allowed["status"] = updates["status"];
  if (updates["priority"] !== undefined) allowed["priority"] = updates["priority"];
  if (updates["assigned_to"] !== undefined) allowed["assigned_to"] = updates["assigned_to"];

  if (Object.keys(allowed).length === 0) {
    throw createError("No updatable fields provided", 400, "NO_UPDATES");
  }

  const { data, error } = await supabaseAdmin
    .from("support_tickets")
    .update(allowed)
    .eq("id", ticketId)
    .select()
    .single();
  if (error || !data) {
    throw createError(error?.message ?? "Ticket not found", 404, "NOT_FOUND");
  }
  return data;
};

export const createTicketMessage = async (params: {
  ticketId: string;
  message: string;
  superAdminId: string;
}): Promise<object> => {
  const { ticketId, message, superAdminId } = params;

  const { data, error } = await supabaseAdmin
    .from("support_ticket_messages")
    .insert({
      ticket_id: ticketId,
      message,
      sender_type: "super_admin",
      sender_id: superAdminId,
    })
    .select()
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create message", 500, "CREATE_FAILED");
  }
  return data;
};

// --------------------------- PLATFORM ALERTS --------------------------------

export const getPlatformAlerts = async (params: {
  status?: string;
  type?: string;
}): Promise<object[]> => {
  const { status, type } = params;
  let query = supabaseAdmin
    .from("platform_alerts")
    .select("*")
    .order("created_at", { ascending: false });

  if (status) query = query.eq("status", status);
  if (type) query = query.eq("type", type);

  const { data, error } = await query;
  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }
  return data ?? [];
};

export const updatePlatformAlert = async (params: {
  alertId: string;
  status: "acknowledged" | "resolved";
  superAdminId: string;
}): Promise<object> => {
  const { alertId, status, superAdminId } = params;

  const { data, error } = await supabaseAdmin
    .from("platform_alerts")
    .update({
      status,
      acknowledged_by: superAdminId,
      acknowledged_at: now().toISOString(),
    })
    .eq("id", alertId)
    .select()
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Alert not found", 404, "NOT_FOUND");
  }
  return data;
};

// ------------------------- MASS COMMUNICATIONS ------------------------------

export const getCommunications = async (): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("mass_communications")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }
  return data ?? [];
};

export const createCommunication = async (params: {
  target_type: "all_users" | "all_restaurants" | "segment";
  segment_criteria?: Row;
  title: string;
  body: string;
  channel: "push" | "email" | "both";
  superAdminId: string;
}): Promise<object> => {
  const { target_type, segment_criteria, title, body, channel, superAdminId } = params;

  const { data, error } = await supabaseAdmin
    .from("mass_communications")
    .insert({
      target_type,
      segment_criteria: segment_criteria ?? null,
      title,
      body,
      channel,
      status: "draft",
      created_by: superAdminId,
    })
    .select()
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create communication", 500, "CREATE_FAILED");
  }
  return data;
};

export const sendCommunication = async (communicationId: string): Promise<object> => {
  // Actual push/email delivery is integrated later; for now we just flip status.
  const { data, error } = await supabaseAdmin
    .from("mass_communications")
    .update({ status: "sent", sent_at: now().toISOString() })
    .eq("id", communicationId)
    .select()
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Communication not found", 404, "NOT_FOUND");
  }
  return data;
};

// ------------------------- GLOBAL CONFIGURATION -----------------------------

export const getConfig = async (): Promise<object[]> => {
  const { data, error } = await supabaseAdmin.from("global_configuration").select("*").order("key", {
    ascending: true,
  });
  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }
  return data ?? [];
};

export const updateConfig = async (params: {
  key: string;
  value: unknown;
  superAdminId: string;
}): Promise<object> => {
  const { key, value, superAdminId } = params;

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("global_configuration")
    .select("*")
    .eq("key", key)
    .maybeSingle();

  if (existingError || !existing) {
    throw createError(existingError?.message ?? "Configuration key not found", 404, "NOT_FOUND");
  }

  const oldValue = (existing as Row)["value"];

  const { data, error } = await supabaseAdmin
    .from("global_configuration")
    .update({ value })
    .eq("key", key)
    .select()
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to update configuration", 500, "UPDATE_FAILED");
  }

  const { error: auditError } = await supabaseAdmin.from("audit_log").insert({
    actor_type: "super_admin",
    actor_id: superAdminId,
    module: "global_configuration",
    action: "update_config",
    log_level: "full",
    entity_type: "global_configuration",
    entity_id: key,
    old_value: oldValue,
    new_value: value,
    created_at: now().toISOString(),
  });

  if (auditError) {
    throw createError(`Configuration updated but audit logging failed: ${auditError.message}`, 500, "AUDIT_LOG_FAILED");
  }

  return data;
};

// ------------------------------ AUDIT LOG -----------------------------------

export const getAuditLog = async (params: {
  actorType?: string;
  module?: string;
  logLevel?: string;
  page: number;
  limit: number;
}): Promise<object> => {
  const { actorType, module, logLevel, page, limit } = params;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("audit_log")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (actorType) query = query.eq("actor_type", actorType);
  if (module) query = query.eq("module", module);
  if (logLevel) query = query.eq("log_level", logLevel);

  const { data, error, count } = await query;
  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return {
    items: data ?? [],
    pagination: { page, limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limit) },
  };
};
