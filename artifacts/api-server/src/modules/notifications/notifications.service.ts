import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

type NotificationType = "order_status" | "payment" | "reservation" | "points" | "promotion" | "system";

const DEFAULT_PREFERENCES: Record<NotificationType, boolean> = {
  order_status: true,
  payment: true,
  reservation: true,
  points: true,
  promotion: true,
  system: true,
};

export const createNotification = async (params: {
  user_id: string;
  notification_type: NotificationType;
  title: string;
  body: string;
  reference_type?: string;
  reference_id?: string;
}): Promise<object | null> => {
  const { user_id, notification_type, title, body, reference_type, reference_id } = params;

  const { data: pref } = await supabaseAdmin
    .from("user_notification_preferences")
    .select("is_enabled")
    .eq("user_id", user_id)
    .eq("notification_type", notification_type)
    .maybeSingle();

  const isEnabled =
    pref !== null
      ? ((pref as Record<string, unknown>)["is_enabled"] as boolean)
      : DEFAULT_PREFERENCES[notification_type] ?? true;

  if (!isEnabled) return null;

  const { data, error } = await supabaseAdmin
    .from("client_notifications")
    .insert({
      user_id,
      notification_type,
      title,
      body,
      reference_type: reference_type ?? null,
      reference_id: reference_id ?? null,
      is_read: false,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    throw createError(error.message, 500, "NOTIFICATION_FAILED");
  }

  return data!;
};

export const getNotifications = async (params: {
  userId: string;
  page: number;
  limit: number;
  unreadOnly: boolean;
}): Promise<{ notifications: object[]; total: number; page: number; limit: number }> => {
  const { userId, page, limit, unreadOnly } = params;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("client_notifications")
    .select("*", { count: "exact" })
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (unreadOnly) {
    query = query.eq("is_read", false);
  }

  const { data, error, count } = await query;

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return { notifications: data ?? [], total: count ?? 0, page, limit };
};

export const getUnreadCount = async (userId: string): Promise<number> => {
  const { count, error } = await supabaseAdmin
    .from("client_notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_read", false);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return count ?? 0;
};

export const markAsRead = async (params: {
  notificationId: string;
  userId: string;
}): Promise<object> => {
  const { notificationId, userId } = params;

  const { data, error } = await supabaseAdmin
    .from("client_notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Notification not found", 404, "NOT_FOUND");
  }

  return data;
};

export const markAllRead = async (userId: string): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("client_notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("is_read", false);

  if (error) {
    throw createError(error.message, 500, "UPDATE_FAILED");
  }
};

export const getPreferences = async (userId: string): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("user_notification_preferences")
    .select("*")
    .eq("user_id", userId);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const existing = (data ?? []) as Array<Record<string, unknown>>;
  const existingTypes = new Set(existing.map((p) => p["notification_type"] as string));

  const defaults = (Object.keys(DEFAULT_PREFERENCES) as NotificationType[])
    .filter((type) => !existingTypes.has(type))
    .map((type) => ({
      user_id: userId,
      notification_type: type,
      is_enabled: DEFAULT_PREFERENCES[type],
    }));

  return [...existing, ...defaults];
};

export const updatePreferences = async (params: {
  userId: string;
  preferences: Partial<Record<NotificationType, boolean>>;
}): Promise<void> => {
  const { userId, preferences } = params;

  const upserts = Object.entries(preferences).map(([notification_type, is_enabled]) => ({
    user_id: userId,
    notification_type,
    is_enabled,
    updated_at: new Date().toISOString(),
  }));

  if (upserts.length === 0) return;

  const { error } = await supabaseAdmin
    .from("user_notification_preferences")
    .upsert(upserts, { onConflict: "user_id,notification_type" });

  if (error) {
    throw createError(error.message, 500, "UPSERT_FAILED");
  }
};
