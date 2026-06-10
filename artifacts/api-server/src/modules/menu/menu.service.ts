import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

export const getBranchMenu = async (params: {
  branchId: string;
  time_slot_id?: string;
  language?: string;
  category_id?: string;
}): Promise<object> => {
  const { branchId, time_slot_id, language, category_id } = params;

  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;

  let catQuery = supabaseAdmin
    .from("menu_categories")
    .select("*")
    .eq("branch_id", branchId)
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  if (category_id) {
    catQuery = catQuery.eq("id", category_id);
  }

  const { data: categories, error: catError } = await catQuery;

  if (catError) {
    throw createError(catError.message, 500, "FETCH_FAILED");
  }

  const { data: timeSlots } = await supabaseAdmin
    .from("menu_time_slots")
    .select("*")
    .eq("branch_id", branchId);

  const activeSlot = (timeSlots ?? []).find((slot: Record<string, unknown>) => {
    const start = slot["start_time"] as string;
    const end = slot["end_time"] as string;
    return currentTime >= start && currentTime <= end;
  });

  const enrichedCategories = await Promise.all(
    (categories ?? []).map(async (category: Record<string, unknown>) => {
      let prodQuery = supabaseAdmin
        .from("products")
        .select(
          "id, name, description, price, image_url, prep_time_minutes, is_featured, display_order, is_available, category_id, modification_groups(id, name, is_required, min_selections, max_selections, modification_options(id, name, additional_price))",
        )
        .eq("category_id", category["id"] as string)
        .eq("is_active", true)
        .eq("is_available", true)
        .order("display_order", { ascending: true });

      if (time_slot_id) {
        const { data: slotProducts } = await supabaseAdmin
          .from("product_time_slots")
          .select("product_id")
          .eq("time_slot_id", time_slot_id);
        const productIds = (slotProducts ?? []).map((p: Record<string, unknown>) => p["product_id"] as string);
        if (productIds.length > 0) {
          prodQuery = prodQuery.in("id", productIds);
        }
      }

      const { data: products } = await prodQuery;

      const enrichedProducts = await Promise.all(
        (products ?? []).map(async (product: Record<string, unknown>) => {
          const { data: ratings } = await supabaseAdmin
            .from("dish_ratings")
            .select("rating")
            .eq("product_id", product["id"] as string);

          const ratingValues = (ratings ?? []).map((r: Record<string, unknown>) => r["rating"] as number);
          const review_count = ratingValues.length;
          const rating =
            review_count > 0
              ? ratingValues.reduce((a, b) => a + b, 0) / review_count
              : null;

          let name = product["name"];
          let description = product["description"];

          if (language && language !== "default") {
            const { data: translation } = await supabaseAdmin
              .from("product_translations")
              .select("name, description")
              .eq("product_id", product["id"] as string)
              .eq("language_code", language)
              .maybeSingle();

            if (translation) {
              name = (translation as Record<string, unknown>)["name"] ?? name;
              description = (translation as Record<string, unknown>)["description"] ?? description;
            }
          }

          return { ...product, name, description, rating, review_count };
        }),
      );

      return { ...category, products: enrichedProducts };
    }),
  );

  return {
    categories: enrichedCategories,
    active_time_slot: activeSlot ?? null,
  };
};

export const searchMenu = async (
  branchId: string,
  q: string,
): Promise<object[]> => {
  const { data: byName } = await supabaseAdmin
    .from("products")
    .select("id, name, description, price, image_url, category_id, menu_categories!inner(name)")
    .eq("menu_categories.branch_id", branchId)
    .eq("is_active", true)
    .eq("is_available", true)
    .ilike("name", `%${q}%`);

  const { data: byDesc } = await supabaseAdmin
    .from("products")
    .select("id, name, description, price, image_url, category_id, menu_categories!inner(name)")
    .eq("menu_categories.branch_id", branchId)
    .eq("is_active", true)
    .eq("is_available", true)
    .ilike("description", `%${q}%`);

  const { data: byIngredient } = await supabaseAdmin
    .from("products")
    .select(
      "id, name, description, price, image_url, category_id, menu_categories!inner(name), product_ingredients!inner(master_ingredients!inner(name))",
    )
    .eq("menu_categories.branch_id", branchId)
    .eq("is_active", true)
    .eq("is_available", true)
    .ilike("master_ingredients.name", `%${q}%`);

  const seen = new Set<string>();
  const merged: object[] = [];

  for (const item of [...(byName ?? []), ...(byDesc ?? []), ...(byIngredient ?? [])]) {
    const id = (item as Record<string, unknown>)["id"] as string;
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(item);
    }
  }

  const enriched = await Promise.all(
    merged.map(async (product) => {
      const p = product as Record<string, unknown>;
      const { data: ratings } = await supabaseAdmin
        .from("dish_ratings")
        .select("rating")
        .eq("product_id", p["id"] as string);

      const ratingValues = (ratings ?? []).map((r: Record<string, unknown>) => r["rating"] as number);
      const review_count = ratingValues.length;
      const rating =
        review_count > 0
          ? ratingValues.reduce((a, b) => a + b, 0) / review_count
          : null;

      return { ...p, rating, review_count };
    }),
  );

  return enriched;
};

export const getFeaturedProducts = async (branchId: string): Promise<object[]> => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select(
      "id, name, description, price, image_url, prep_time_minutes, display_order, category_id, menu_categories!inner(branch_id, name)",
    )
    .eq("menu_categories.branch_id", branchId)
    .eq("is_featured", true)
    .eq("is_active", true)
    .eq("is_available", true)
    .order("display_order", { ascending: true });

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  const enriched = await Promise.all(
    (data ?? []).map(async (product: Record<string, unknown>) => {
      const { data: ratings } = await supabaseAdmin
        .from("dish_ratings")
        .select("rating")
        .eq("product_id", product["id"] as string);

      const ratingValues = (ratings ?? []).map((r: Record<string, unknown>) => r["rating"] as number);
      const review_count = ratingValues.length;
      const rating =
        review_count > 0
          ? ratingValues.reduce((a, b) => a + b, 0) / review_count
          : null;

      return { ...product, rating, review_count };
    }),
  );

  return enriched;
};

export const getProductDetail = async (productId: string): Promise<object> => {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select(
      "*, menu_categories(name, branch_id), product_ingredients(master_ingredients(id, name)), modification_groups(id, name, is_required, min_selections, max_selections, modification_options(id, name, additional_price)), product_time_slots(menu_time_slots(id, name, start_time, end_time)), product_translations(language_code, name, description)",
    )
    .eq("id", productId)
    .single();

  if (error || !data) {
    throw createError("Product not found", 404, "PRODUCT_NOT_FOUND");
  }

  const { data: ratings } = await supabaseAdmin
    .from("dish_ratings")
    .select("rating")
    .eq("product_id", productId);

  const ratingValues = (ratings ?? []).map((r: Record<string, unknown>) => r["rating"] as number);
  const review_count = ratingValues.length;
  const rating =
    review_count > 0
      ? ratingValues.reduce((a, b) => a + b, 0) / review_count
      : null;

  return { ...(data as object), rating, review_count };
};

export const getProductReviews = async (params: {
  productId: string;
  page: number;
  limit: number;
  sort: "recent" | "highest" | "lowest";
}): Promise<{ reviews: object[]; total: number; page: number; limit: number }> => {
  const { productId, page, limit, sort } = params;
  const offset = (page - 1) * limit;

  let orderField = "created_at";
  let ascending = false;

  if (sort === "highest") {
    orderField = "rating";
    ascending = false;
  } else if (sort === "lowest") {
    orderField = "rating";
    ascending = true;
  }

  const { data, error, count } = await supabaseAdmin
    .from("dish_ratings")
    .select("*, users(full_name), restaurant_review_responses(*)", { count: "exact" })
    .eq("product_id", productId)
    .eq("status", "visible")
    .order(orderField, { ascending })
    .range(offset, offset + limit - 1);

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return { reviews: data ?? [], total: count ?? 0, page, limit };
};

export const createProduct = async (params: {
  branchId: string;
  category_id: string;
  name: string;
  description?: string;
  price: number;
  image_url?: string;
  prep_time_minutes?: number;
  is_featured?: boolean;
  display_order?: number;
  is_ratable?: boolean;
  time_slot_ids?: string[];
  ingredients?: string[];
  modifications?: Array<{
    name: string;
    is_required: boolean;
    min_selections: number;
    max_selections: number;
    options: Array<{ name: string; additional_price: number }>;
  }>;
  employeeId: string;
}): Promise<object> => {
  const {
    branchId,
    category_id,
    name,
    description,
    price,
    image_url,
    prep_time_minutes,
    is_featured,
    display_order,
    is_ratable,
    time_slot_ids,
    ingredients,
    modifications,
    employeeId,
  } = params;

  const { data: product, error: prodError } = await supabaseAdmin
    .from("products")
    .insert({
      category_id,
      name,
      description,
      price,
      image_url,
      prep_time_minutes,
      is_featured: is_featured ?? false,
      display_order,
      is_ratable: is_ratable ?? true,
      is_active: true,
      is_available: true,
    })
    .select("*")
    .single();

  if (prodError || !product) {
    throw createError(prodError?.message ?? "Failed to create product", 500, "CREATE_FAILED");
  }

  const productId = (product as Record<string, unknown>)["id"] as string;

  const tasks: PromiseLike<unknown>[] = [];

  if (time_slot_ids?.length) {
    tasks.push(
      supabaseAdmin.from("product_time_slots").insert(
        time_slot_ids.map((ts_id) => ({ product_id: productId, time_slot_id: ts_id })),
      ).then(),
    );
  }

  if (ingredients?.length) {
    tasks.push(
      supabaseAdmin.from("product_ingredients").insert(
        ingredients.map((ing_id) => ({ product_id: productId, ingredient_id: ing_id })),
      ).then(),
    );
  }

  if (modifications?.length) {
    for (const mod of modifications) {
      const { data: group } = await supabaseAdmin
        .from("modification_groups")
        .insert({
          product_id: productId,
          name: mod.name,
          is_required: mod.is_required,
          min_selections: mod.min_selections,
          max_selections: mod.max_selections,
        })
        .select("id")
        .single();

      if (group && mod.options?.length) {
        tasks.push(
          supabaseAdmin.from("modification_options").insert(
            mod.options.map((opt) => ({
              group_id: (group as Record<string, unknown>)["id"],
              name: opt.name,
              additional_price: opt.additional_price,
            })),
          ).then(),
        );
      }
    }
  }

  await Promise.all(tasks);

  await supabaseAdmin.from("menu_change_log").insert({
    branch_id: branchId,
    entity_type: "product",
    entity_id: productId,
    change_type: "create",
    changed_by: employeeId,
    created_at: new Date().toISOString(),
  });

  return await getProductDetail(productId);
};

export const updateProduct = async (params: {
  productId: string;
  updates: Partial<{
    name: string;
    description: string;
    price: number;
    image_url: string;
    prep_time_minutes: number;
    is_featured: boolean;
    display_order: number;
    is_ratable: boolean;
    category_id: string;
  }>;
  employeeId: string;
}): Promise<object> => {
  const { productId, updates, employeeId } = params;

  const { data: existing } = await supabaseAdmin
    .from("products")
    .select("*")
    .eq("id", productId)
    .single();

  const { data, error } = await supabaseAdmin
    .from("products")
    .update(updates)
    .eq("id", productId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Product not found", 404, "NOT_FOUND");
  }

  const changedFields = Object.entries(updates)
    .filter(([key, val]) => existing && (existing as Record<string, unknown>)[key] !== val)
    .map(([key, val]) => ({
      branch_id: (existing as Record<string, unknown>)?.["category_id"],
      entity_type: "product",
      entity_id: productId,
      change_type: "update",
      field_name: key,
      old_value: JSON.stringify((existing as Record<string, unknown>)[key]),
      new_value: JSON.stringify(val),
      changed_by: employeeId,
      created_at: new Date().toISOString(),
    }));

  if (changedFields.length) {
    await supabaseAdmin.from("menu_change_log").insert(changedFields);
  }

  return data;
};

export const toggleProductAvailability = async (params: {
  productId: string;
  is_available: boolean;
  employeeId: string;
}): Promise<object> => {
  const { productId, is_available, employeeId } = params;

  const { data, error } = await supabaseAdmin
    .from("products")
    .update({ is_available })
    .eq("id", productId)
    .select("id, name, is_available")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Product not found", 404, "NOT_FOUND");
  }

  const { data: product } = await supabaseAdmin
    .from("products")
    .select("menu_categories(branch_id)")
    .eq("id", productId)
    .single();

  const category = product && (product as Record<string, unknown>)["menu_categories"] as Record<string, unknown> | null;

  await supabaseAdmin.from("menu_change_log").insert({
    branch_id: category?.["branch_id"] ?? null,
    entity_type: "product",
    entity_id: productId,
    change_type: "availability",
    new_value: JSON.stringify(is_available),
    changed_by: employeeId,
    created_at: new Date().toISOString(),
  });

  return data;
};

export const softDeleteProduct = async (params: {
  productId: string;
  employeeId: string;
}): Promise<void> => {
  const { productId, employeeId } = params;

  const { error } = await supabaseAdmin
    .from("products")
    .update({ is_active: false })
    .eq("id", productId);

  if (error) {
    throw createError(error.message, 400, "DELETE_FAILED");
  }

  const { data: product } = await supabaseAdmin
    .from("products")
    .select("menu_categories(branch_id)")
    .eq("id", productId)
    .single();

  const category = product && (product as Record<string, unknown>)["menu_categories"] as Record<string, unknown> | null;

  await supabaseAdmin.from("menu_change_log").insert({
    branch_id: category?.["branch_id"] ?? null,
    entity_type: "product",
    entity_id: productId,
    change_type: "delete",
    changed_by: employeeId,
    created_at: new Date().toISOString(),
  });
};

export const createCategory = async (params: {
  branchId: string;
  name: string;
  description?: string;
  display_order?: number;
  employeeId: string;
}): Promise<object> => {
  const { branchId, name, description, display_order, employeeId } = params;

  const { data, error } = await supabaseAdmin
    .from("menu_categories")
    .insert({
      branch_id: branchId,
      name,
      description,
      display_order,
      is_active: true,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Failed to create category", 500, "CREATE_FAILED");
  }

  await supabaseAdmin.from("menu_change_log").insert({
    branch_id: branchId,
    entity_type: "category",
    entity_id: (data as Record<string, unknown>)["id"],
    change_type: "create",
    changed_by: employeeId,
    created_at: new Date().toISOString(),
  });

  return data;
};

export const updateCategory = async (params: {
  categoryId: string;
  updates: Partial<{ name: string; description: string; display_order: number; is_active: boolean }>;
  employeeId: string;
}): Promise<object> => {
  const { categoryId, updates, employeeId } = params;

  const { data, error } = await supabaseAdmin
    .from("menu_categories")
    .update(updates)
    .eq("id", categoryId)
    .select("*")
    .single();

  if (error || !data) {
    throw createError(error?.message ?? "Category not found", 404, "NOT_FOUND");
  }

  await supabaseAdmin.from("menu_change_log").insert({
    branch_id: (data as Record<string, unknown>)["branch_id"],
    entity_type: "category",
    entity_id: categoryId,
    change_type: "update",
    new_value: JSON.stringify(updates),
    changed_by: employeeId,
    created_at: new Date().toISOString(),
  });

  return data;
};

export const getChangeLog = async (params: {
  branchId: string;
  page: number;
  limit: number;
  entity_type?: "product" | "category";
}): Promise<{ logs: object[]; total: number; page: number; limit: number }> => {
  const { branchId, page, limit, entity_type } = params;
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("menu_change_log")
    .select("*", { count: "exact" })
    .eq("branch_id", branchId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (entity_type) {
    query = query.eq("entity_type", entity_type);
  }

  const { data, error, count } = await query;

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }

  return { logs: data ?? [], total: count ?? 0, page, limit };
};
