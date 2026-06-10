import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

const getPointsConfig = async (key: string): Promise<number> => {
  const { data } = await supabaseAdmin
    .from("global_configuration")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data ? parseInt((data as Record<string, unknown>)["value"] as string, 10) : 0;
};

export const getBalance = async (userId: string): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("points_balance, points_level, is_premium")
    .eq("id", userId)
    .single();

  if (error || !data) {
    throw createError("User not found", 404, "USER_NOT_FOUND");
  }

  return {
    balance: (data as Record<string, unknown>)["points_balance"] ?? 0,
    level: (data as Record<string, unknown>)["points_level"] ?? null,
  };
};

export const getHistory = async (params: {
  userId: string;
  page: number;
  limit: number;
  type?: "earned" | "redeemed" | "expired";
}): Promise<{ entries: object[]; total: number; page: number; limit: number }> => {
  const { userId, page, limit, type } = params;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("points_ledger")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) {
    query = query.eq("type", type);
  }

  const { data, error, count } = await query;

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return { entries: data ?? [], total: count ?? 0, page, limit };
};

export const earnPoints = async (params: {
  user_id: string;
  amount: number;
  reason: string;
  reference_type: string;
  reference_id: string;
}): Promise<object> => {
  const { user_id, amount, reason, reference_type, reference_id } = params;

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("points_balance, is_premium")
    .eq("id", user_id)
    .single();

  if (!user) {
    throw createError("User not found", 404, "USER_NOT_FOUND");
  }

  const u = user as Record<string, unknown>;
  const isPremium = u["is_premium"] === true;
  const finalAmount = isPremium ? amount * 2 : amount;
  const currentBalance = (u["points_balance"] as number) ?? 0;
  const balanceAfter = currentBalance + finalAmount;

  const { data: entry, error: ledgerError } = await supabaseAdmin
    .from("points_ledger")
    .insert({
      user_id,
      amount: finalAmount,
      type: "earned",
      reason,
      reference_type,
      reference_id,
      balance_after: balanceAfter,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (ledgerError || !entry) {
    throw createError(ledgerError?.message ?? "Failed to record points", 500, "LEDGER_FAILED");
  }

  await supabaseAdmin
    .from("users")
    .update({ points_balance: balanceAfter })
    .eq("id", user_id);

  return entry;
};

export const redeemPoints = async (params: {
  user_id: string;
  amount: number;
  reason: string;
  reference_type: string;
  reference_id: string;
}): Promise<object> => {
  const { user_id, amount, reason, reference_type, reference_id } = params;

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("points_balance")
    .eq("id", user_id)
    .single();

  if (!user) {
    throw createError("User not found", 404, "USER_NOT_FOUND");
  }

  const currentBalance = ((user as Record<string, unknown>)["points_balance"] as number) ?? 0;

  if (currentBalance < amount) {
    throw createError("Insufficient points balance", 400, "INSUFFICIENT_POINTS");
  }

  const balanceAfter = currentBalance - amount;

  const { data: entry, error } = await supabaseAdmin
    .from("points_ledger")
    .insert({
      user_id,
      amount: -amount,
      type: "redeemed",
      reason,
      reference_type,
      reference_id,
      balance_after: balanceAfter,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !entry) {
    throw createError(error?.message ?? "Failed to redeem points", 500, "REDEEM_FAILED");
  }

  await supabaseAdmin
    .from("users")
    .update({ points_balance: balanceAfter })
    .eq("id", user_id);

  return entry;
};

export const getConfiguredPointsAmount = getPointsConfig;
