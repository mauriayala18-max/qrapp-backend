import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { redeemPoints } from "../points/points.service.js";

const generateCouponCode = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "QR-";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

export const getBranchPromotions = async (params: {
  branchId: string;
  userId?: string;
}): Promise<object[]> => {
  const { branchId, userId } = params;

  const todayStr = new Date().toISOString().slice(0, 10);

  const { data: promotions, error } = await supabaseAdmin
    .from("promotions")
    .select("*")
    .eq("branch_id", branchId)
    .eq("is_active", true)
    .lte("valid_from", todayStr)
    .gte("valid_until", todayStr);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  let userSegment: string | null = null;

  if (userId) {
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("dining_frequency, is_premium, created_at")
      .eq("id", userId)
      .single();

    if (user) {
      const u = user as Record<string, unknown>;
      if (u["is_premium"]) {
        userSegment = "premium";
      } else {
        const createdAt = new Date(u["created_at"] as string);
        const daysSince = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
        const freq = u["dining_frequency"] as string | null;

        if (daysSince < 30) userSegment = "new";
        else if (freq === "frequent") userSegment = "frequent";
        else if (daysSince > 90) userSegment = "inactive";
        else userSegment = "all";
      }
    }
  }

  return (promotions ?? []).filter((p: Record<string, unknown>) => {
    const target = p["segment_targeting"] as string;
    if (target === "all") return true;
    if (!userSegment) return target === "all";
    return target === userSegment || target === "all";
  });
};

export const applyPromotion = async (params: {
  promotionId: string;
  order_id: string;
  userId: string;
}): Promise<object> => {
  const { promotionId, order_id, userId } = params;

  const todayStr = new Date().toISOString().slice(0, 10);

  const { data: promotion, error: promoError } = await supabaseAdmin
    .from("promotions")
    .select("*")
    .eq("id", promotionId)
    .eq("is_active", true)
    .lte("valid_from", todayStr)
    .gte("valid_until", todayStr)
    .single();

  if (promoError || !promotion) {
    throw createError("Promotion not found or inactive", 404, "PROMO_NOT_FOUND");
  }

  const p = promotion as Record<string, unknown>;

  const maxUses = p["max_uses"] as number | null;
  const currentUses = p["current_uses"] as number ?? 0;

  if (maxUses !== null && currentUses >= maxUses) {
    throw createError("Promotion has reached its usage limit", 400, "MAX_USES_REACHED");
  }

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("total_amount")
    .eq("id", order_id)
    .single();

  if (!order) {
    throw createError("Order not found", 404, "ORDER_NOT_FOUND");
  }

  const orderTotal = ((order as Record<string, unknown>)["total_amount"] as number) ?? 0;
  const minOrder = (p["min_order_amount"] as number | null) ?? 0;

  if (orderTotal < minOrder) {
    throw createError(`Minimum order amount of ${minOrder} required`, 400, "MIN_ORDER_NOT_MET");
  }

  if (p["requires_points"]) {
    const cost = (p["points_cost"] as number) ?? 0;
    if (cost > 0) {
      await redeemPoints({
        user_id: userId,
        amount: cost,
        reason: `Promotion: ${p["name"]}`,
        reference_type: "promotion",
        reference_id: promotionId,
      });
    }
  }

  let discountApplied = 0;
  const promoType = p["promotion_type"] as string;
  const value = (p["value"] as number) ?? 0;

  if (promoType === "percentage") {
    discountApplied = Math.floor(orderTotal * (value / 100));
  } else if (promoType === "fixed_amount") {
    discountApplied = Math.min(value, orderTotal);
  }

  await supabaseAdmin.from("promotion_usage").insert({
    promotion_id: promotionId,
    user_id: userId,
    order_id,
    discount_applied: discountApplied,
    used_at: new Date().toISOString(),
  });

  await supabaseAdmin
    .from("promotions")
    .update({ current_uses: currentUses + 1 })
    .eq("id", promotionId);

  return { discount_applied: discountApplied, promotion };
};

export const getMyCoupons = async (userId: string): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("coupons")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const now = new Date().toISOString();

  return (data ?? []).map((c: Record<string, unknown>) => {
    let status = c["status"] as string;
    if (status === "active" && c["expires_at"] && (c["expires_at"] as string) < now) {
      status = "expired";
    }
    return { ...c, status };
  });
};

export const applyCoupon = async (params: {
  couponId: string;
  order_id: string;
  userId: string;
}): Promise<object> => {
  const { couponId, order_id, userId } = params;

  const { data: coupon, error } = await supabaseAdmin
    .from("coupons")
    .select("*")
    .eq("id", couponId)
    .eq("user_id", userId)
    .eq("status", "active")
    .single();

  if (error || !coupon) {
    throw createError("Coupon not found, not yours, or already used", 404, "COUPON_NOT_FOUND");
  }

  const c = coupon as Record<string, unknown>;

  if (c["expires_at"] && new Date(c["expires_at"] as string) < new Date()) {
    throw createError("Coupon has expired", 400, "COUPON_EXPIRED");
  }

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("total_amount")
    .eq("id", order_id)
    .single();

  if (!order) {
    throw createError("Order not found", 404, "ORDER_NOT_FOUND");
  }

  const orderTotal = ((order as Record<string, unknown>)["total_amount"] as number) ?? 0;
  const couponType = c["coupon_type"] as string;
  const value = (c["value"] as number) ?? 0;
  const cap = (c["cap_amount"] as number | null) ?? null;

  let discountApplied = 0;

  if (couponType === "percentage") {
    discountApplied = Math.floor(orderTotal * (value / 100));
    if (cap !== null) discountApplied = Math.min(discountApplied, cap);
  } else if (couponType === "fixed_amount") {
    discountApplied = Math.min(value, orderTotal);
  }

  await supabaseAdmin
    .from("coupons")
    .update({ status: "used", used_at: new Date().toISOString(), order_id })
    .eq("id", couponId);

  return { discount_applied: discountApplied };
};

export const createPromotion = async (params: Record<string, unknown> & {
  branchId: string;
  employeeId: string;
}): Promise<object> => {
  const { branchId, employeeId, ...fields } = params;
  void employeeId;

  const { data, error } = await supabaseAdmin
    .from("promotions")
    .insert({ ...fields, branch_id: branchId, current_uses: 0, is_active: true, created_at: new Date().toISOString() })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create promotion", 500, "CREATE_FAILED");
  }

  return data;
};

export const updatePromotion = async (params: {
  promotionId: string;
  updates: Record<string, unknown>;
}): Promise<object> => {
  const { promotionId, updates } = params;

  const { data, error } = await supabaseAdmin
    .from("promotions")
    .update(updates)
    .eq("id", promotionId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Promotion not found", 404, "NOT_FOUND");
  }

  return data;
};

export const deletePromotion = async (promotionId: string): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("promotions")
    .update({ is_active: false })
    .eq("id", promotionId);

  if (error) {
    throw createError(error.message, 400, "DELETE_FAILED");
  }
};

export const createCoupon = async (params: {
  branchId: string;
  user_id: string;
  coupon_type: string;
  value: number;
  cap_amount?: number;
  expires_at: string;
  reason: string;
}): Promise<object> => {
  const { branchId, user_id, coupon_type, value, cap_amount, expires_at, reason } = params;

  const code = generateCouponCode();

  const { data, error } = await supabaseAdmin
    .from("coupons")
    .insert({
      branch_id: branchId,
      user_id,
      code,
      coupon_type,
      value,
      cap_amount: cap_amount ?? null,
      expires_at,
      reason,
      status: "active",
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create coupon", 500, "CREATE_FAILED");
  }

  return data;
};

export const getPromotionStats = async (branchId: string): Promise<object[]> => {
  const { data: promotions, error } = await supabaseAdmin
    .from("promotions")
    .select("*, promotion_usage(discount_applied)")
    .eq("branch_id", branchId);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return (promotions ?? []).map((p: Record<string, unknown>) => {
    const usage = (p["promotion_usage"] as Array<Record<string, unknown>>) ?? [];
    const total_discount = usage.reduce(
      (sum: number, u) => sum + ((u["discount_applied"] as number) ?? 0),
      0,
    );
    const maxUses = (p["max_uses"] as number | null) ?? null;
    const conversionRate =
      maxUses ? Math.round(((p["current_uses"] as number) / maxUses) * 100) : null;

    const { promotion_usage: _usage, ...rest } = p;
    void _usage;

    return { ...rest, total_discount_given: total_discount, conversion_rate: conversionRate };
  });
};
