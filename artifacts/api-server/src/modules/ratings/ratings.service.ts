import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";
import { earnPoints, getConfiguredPointsAmount } from "../points/points.service.js";

export const createDishRating = async (params: {
  userId: string;
  product_id: string;
  order_item_id: string;
  rating: number;
}): Promise<object> => {
  const { userId, product_id, order_item_id, rating } = params;

  if (rating < 1 || rating > 5) {
    throw createError("Rating must be between 1 and 5", 400, "INVALID_RATING");
  }

  const { data: orderItem } = await supabaseAdmin
    .from("order_items")
    .select("id, order_id")
    .eq("id", order_item_id)
    .single();

  if (!orderItem) {
    throw createError("Order item not found", 404, "ORDER_ITEM_NOT_FOUND");
  }

  const oi = orderItem as Record<string, unknown>;
  const orderId = oi["order_id"] as string;

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, status, session_id, user_id")
    .eq("id", orderId)
    .in("status", ["delivered", "ready"])
    .single();

  if (!order) {
    throw createError("Order not found or not yet delivered", 404, "ORDER_NOT_READY");
  }

  const o = order as Record<string, unknown>;

  let isOwner = o["user_id"] === userId;

  if (!isOwner) {
    const { data: participant } = await supabaseAdmin
      .from("session_participants")
      .select("id")
      .eq("session_id", o["session_id"] as string)
      .eq("user_id", userId)
      .maybeSingle();
    isOwner = !!participant;
  }

  if (!isOwner) {
    throw createError("You cannot rate this order item", 403, "FORBIDDEN");
  }

  const { data, error } = await supabaseAdmin
    .from("dish_ratings")
    .insert({
      user_id: userId,
      product_id,
      order_item_id,
      rating,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw createError("You have already rated this item", 409, "ALREADY_RATED");
    }
    throw createError(error.message, 500, "CREATE_FAILED");
  }

  const pointsAmount = await getConfiguredPointsAmount("rating_points");
  if (pointsAmount > 0) {
    await earnPoints({
      user_id: userId,
      amount: pointsAmount,
      reason: "Dish rating",
      reference_type: "dish_rating",
      reference_id: (data as Record<string, unknown>)["id"] as string,
    });
  }

  return data!;
};

export const createDishReview = async (params: {
  userId: string;
  ratingId: string;
  review_text: string;
}): Promise<object> => {
  const { userId, ratingId, review_text } = params;

  const { data: ratingRow } = await supabaseAdmin
    .from("dish_ratings")
    .select("id, user_id")
    .eq("id", ratingId)
    .eq("user_id", userId)
    .single();

  if (!ratingRow) {
    throw createError("Rating not found or not yours", 404, "NOT_FOUND");
  }

  const { data, error } = await supabaseAdmin
    .from("dish_reviews")
    .insert({
      rating_id: ratingId,
      user_id: userId,
      review_text,
      status: "visible",
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw createError("Review already submitted for this rating", 409, "ALREADY_REVIEWED");
    }
    throw createError(error.message, 500, "CREATE_FAILED");
  }

  const pointsAmount = await getConfiguredPointsAmount("review_points");
  if (pointsAmount > 0) {
    await earnPoints({
      user_id: userId,
      amount: pointsAmount,
      reason: "Dish review",
      reference_type: "dish_review",
      reference_id: (data as Record<string, unknown>)["id"] as string,
    });
  }

  return data!;
};

export const getProductRatings = async (productId: string): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("dish_ratings")
    .select("rating")
    .eq("product_id", productId);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const ratings = (data ?? []) as Array<Record<string, unknown>>;
  const total = ratings.length;
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  let sum = 0;
  for (const r of ratings) {
    const val = r["rating"] as number;
    sum += val;
    distribution[val] = (distribution[val] ?? 0) + 1;
  }

  return {
    average_rating: total > 0 ? Math.round((sum / total) * 100) / 100 : 0,
    total_ratings: total,
    distribution,
  };
};

export const getProductReviews = async (params: {
  productId: string;
  page: number;
  limit: number;
  sort: "recent" | "highest" | "lowest";
}): Promise<{ reviews: object[]; total: number; page: number; limit: number }> => {
  const { productId, page, limit, sort } = params;
  const offset = (page - 1) * limit;

  const orderCol = sort === "highest" ? "rating" : sort === "lowest" ? "rating" : "created_at";
  const ascending = sort === "lowest";

  const { data, error, count } = await supabaseAdmin
    .from("dish_reviews")
    .select(
      `id, review_text, status, created_at,
       dish_ratings!inner(rating, product_id, user_id),
       users(full_name, profile_photo_url),
       review_responses(response_text, created_at)`,
      { count: "exact" },
    )
    .eq("dish_ratings.product_id", productId)
    .eq("status", "visible")
    .order(orderCol, { ascending })
    .range(offset, offset + limit - 1);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return { reviews: data ?? [], total: count ?? 0, page, limit };
};

export const createRestaurantRating = async (params: {
  userId: string;
  branch_id: string;
  session_id: string;
  rating: number;
  is_incentivized?: boolean;
}): Promise<object> => {
  const { userId, branch_id, session_id, rating, is_incentivized } = params;

  if (rating < 1 || rating > 5) {
    throw createError("Rating must be between 1 and 5", 400, "INVALID_RATING");
  }

  const { data: participant } = await supabaseAdmin
    .from("session_participants")
    .select("id")
    .eq("session_id", session_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!participant) {
    throw createError("You did not participate in this session", 403, "NOT_PARTICIPANT");
  }

  const { data, error } = await supabaseAdmin
    .from("restaurant_ratings")
    .insert({
      user_id: userId,
      branch_id,
      session_id,
      rating,
      is_incentivized: is_incentivized ?? false,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw createError("You have already rated this session", 409, "ALREADY_RATED");
    }
    throw createError(error.message, 500, "CREATE_FAILED");
  }

  if (is_incentivized) {
    const pointsAmount = await getConfiguredPointsAmount("rating_points");
    if (pointsAmount > 0) {
      await earnPoints({
        user_id: userId,
        amount: pointsAmount,
        reason: "Restaurant rating",
        reference_type: "restaurant_rating",
        reference_id: (data as Record<string, unknown>)["id"] as string,
      });
    }
  }

  return data!;
};

export const getBranchRating = async (branchId: string): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("restaurant_ratings")
    .select("rating")
    .eq("branch_id", branchId);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const ratings = (data ?? []) as Array<Record<string, unknown>>;
  const total = ratings.length;
  const sum = ratings.reduce((acc, r) => acc + ((r["rating"] as number) ?? 0), 0);

  return {
    average_rating: total > 0 ? Math.round((sum / total) * 100) / 100 : 0,
    total_ratings: total,
  };
};

export const respondToReview = async (params: {
  reviewId: string;
  employeeId: string;
  response_text: string;
}): Promise<object> => {
  const { reviewId, employeeId, response_text } = params;

  const { data, error } = await supabaseAdmin
    .from("review_responses")
    .insert({
      review_id: reviewId,
      employee_id: employeeId,
      response_text,
      created_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    throw createError(error.message, 500, "CREATE_FAILED");
  }

  return data!;
};

export const updateReviewStatus = async (params: {
  reviewId: string;
  status: "visible" | "hidden" | "reported";
}): Promise<object> => {
  const { reviewId, status } = params;

  const { data, error } = await supabaseAdmin
    .from("dish_reviews")
    .update({ status })
    .eq("id", reviewId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Review not found", 404, "NOT_FOUND");
  }

  return data;
};

export const getBranchReviews = async (params: {
  branchId: string;
  status?: string;
  page: number;
  limit: number;
}): Promise<{ reviews: object[]; total: number; page: number; limit: number }> => {
  const { branchId, status, page, limit } = params;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("dish_reviews")
    .select(
      `id, review_text, status, created_at,
       dish_ratings!inner(rating, product_id, products!inner(name, branch_id)),
       users(full_name, profile_photo_url),
       review_responses(response_text, created_at)`,
      { count: "exact" },
    )
    .eq("dish_ratings.products.branch_id", branchId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error, count } = await query;

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return { reviews: data ?? [], total: count ?? 0, page, limit };
};
