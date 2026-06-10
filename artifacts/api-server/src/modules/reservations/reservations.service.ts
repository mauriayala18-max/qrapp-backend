import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

export const createReservation = async (params: {
  user_id: string;
  branch_id: string;
  date: string;
  time: string;
  party_size: number;
  special_requests?: string;
}): Promise<object> => {
  const { user_id, branch_id, date, time, party_size, special_requests } = params;

  if (new Date(`${date}T${time}`) < new Date()) {
    throw createError("Reservation date must be in the future", 400, "PAST_DATE");
  }

  const { data: branch } = await supabaseAdmin
    .from("branches")
    .select("id, is_active")
    .eq("id", branch_id)
    .eq("is_active", true)
    .maybeSingle();

  if (!branch) {
    throw createError("Branch not found or inactive", 404, "BRANCH_NOT_FOUND");
  }

  const { data, error } = await supabaseAdmin
    .from("reservations")
    .insert({
      user_id,
      branch_id,
      date,
      time,
      party_size,
      special_requests: special_requests ?? null,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create reservation", 500, "CREATE_FAILED");
  }

  return data;
};

export const getMyReservations = async (params: {
  user_id: string;
  status?: string;
  upcoming?: boolean;
}): Promise<object[]> => {
  const { user_id, status, upcoming } = params;

  let query = supabaseAdmin
    .from("reservations")
    .select("*, branches(name, address)")
    .eq("user_id", user_id)
    .order("date", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  if (upcoming) {
    query = query.gte("date", new Date().toISOString().slice(0, 10));
  }

  const { data, error } = await query;

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return data ?? [];
};

export const getBranchReservations = async (params: {
  branchId: string;
  date?: string;
  status?: string;
}): Promise<object[]> => {
  const { branchId, date, status } = params;

  let query = supabaseAdmin
    .from("reservations")
    .select("*, users(full_name, phone)")
    .eq("branch_id", branchId)
    .order("date", { ascending: true });

  if (date) query = query.eq("date", date);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return data ?? [];
};

export const updateReservation = async (params: {
  reservationId: string;
  status: "confirmed" | "rejected" | "cancelled" | "completed" | "no_show";
  rejection_reason?: string;
  employeeId: string;
}): Promise<object> => {
  const { reservationId, status, rejection_reason, employeeId } = params;

  const update: Record<string, unknown> = {
    status,
    rejection_reason: rejection_reason ?? null,
    updated_at: new Date().toISOString(),
  };

  if (status === "confirmed") {
    update["confirmed_by"] = employeeId;
    update["confirmed_at"] = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from("reservations")
    .update(update)
    .eq("id", reservationId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Reservation not found", 404, "NOT_FOUND");
  }

  return data;
};

export const cancelReservation = async (params: {
  reservationId: string;
  userId: string;
}): Promise<void> => {
  const { reservationId, userId } = params;

  const { data: reservation } = await supabaseAdmin
    .from("reservations")
    .select("id, status, user_id")
    .eq("id", reservationId)
    .eq("user_id", userId)
    .single();

  if (!reservation) {
    throw createError("Reservation not found or not yours", 404, "NOT_FOUND");
  }

  const r = reservation as Record<string, unknown>;
  if (!["pending", "confirmed"].includes(r["status"] as string)) {
    throw createError("Only pending or confirmed reservations can be cancelled", 400, "INVALID_STATUS");
  }

  await supabaseAdmin
    .from("reservations")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", reservationId);
};
