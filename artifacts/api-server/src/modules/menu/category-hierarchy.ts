import { supabaseAdmin } from "../../config/supabase.js";
import { createError } from "../../middleware/errorHandler.js";

/**
 * Two-level category tree rules.
 *
 * A category is either TOP-LEVEL (parent_category_id IS NULL) or a SUBCATEGORY
 * of a top-level category. Depth is exactly two: a subcategory can never have
 * children of its own. Postgres cannot express that in a CHECK (it needs to
 * look at another row), so every write goes through the guards below.
 */

export type CategoryRow = Record<string, unknown>;

const MISSING_COLUMN_CODES = new Set(["42703", "PGRST204"]);

const mentionsParentColumn = (message?: string | null): boolean =>
  typeof message === "string" && message.includes("parent_category_id");

/**
 * True when the failure is "this database has not run the hierarchy migration
 * yet". Both PostgREST variants name the column in the message, so the message
 * is the reliable signal; the codes are only a sanity check.
 */
export const isMissingHierarchyColumn = (error: {
  code?: string | null;
  message?: string | null;
} | null): boolean => {
  if (!error) return false;
  if (mentionsParentColumn(error.message)) return true;
  return MISSING_COLUMN_CODES.has(String(error.code ?? "")) && !error.message;
};

let installedCache = false;

/**
 * Probes whether menu_categories.parent_category_id exists.
 *
 * Only a POSITIVE answer is cached: once the column is there it cannot go away
 * while the process runs. A negative or unrecognized result is re-probed next
 * time, so a transient error or a schema-cache blip cannot pin the server to
 * "not installed" until someone restarts it.
 */
export const hierarchyInstalled = async (): Promise<boolean> => {
  if (installedCache) return true;

  const { error } = await supabaseAdmin
    .from("menu_categories")
    .select("id, parent_category_id")
    .limit(1);

  if (!error) {
    installedCache = true;
    return true;
  }
  if (isMissingHierarchyColumn(error)) return false;

  // Something else went wrong (network, permissions). Do not guess either way.
  throw createError(error.message, 500, "FETCH_FAILED");
};

/** Endpoints that cannot work at all without the migration say so explicitly. */
export const requireHierarchyInstalled = async (): Promise<void> => {
  if (await hierarchyInstalled()) return;
  throw createError(
    "Category hierarchy is not installed yet: run migrations/20260912_menu_category_hierarchy.sql",
    503,
    "HIERARCHY_NOT_INSTALLED",
  );
};

export const getParentId = (category: CategoryRow | null | undefined): string | null => {
  const value = category?.["parent_category_id"];
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const loadCategory = async (categoryId: string): Promise<CategoryRow> => {
  const { data, error } = await supabaseAdmin
    .from("menu_categories")
    .select("*")
    .eq("id", categoryId)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }
  if (!data) {
    throw createError("Category not found", 404, "NOT_FOUND");
  }
  return data as CategoryRow;
};

/**
 * Validates a proposed parent: it must exist, live in the same branch, be
 * top-level itself, and not be the category being edited.
 */
export const assertValidParent = async (params: {
  parentCategoryId: string;
  branchId: string;
  categoryId?: string;
}): Promise<void> => {
  const { parentCategoryId, branchId, categoryId } = params;

  if (categoryId && parentCategoryId === categoryId) {
    throw createError("A category cannot be its own parent", 400, "SELF_PARENT");
  }

  const { data, error } = await supabaseAdmin
    .from("menu_categories")
    .select("*")
    .eq("id", parentCategoryId)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }
  if (!data) {
    throw createError("Parent category not found", 404, "PARENT_NOT_FOUND");
  }

  const parent = data as CategoryRow;

  if (parent["branch_id"] !== branchId) {
    throw createError(
      "Parent category belongs to a different branch",
      400,
      "PARENT_OTHER_BRANCH",
    );
  }

  if (getParentId(parent) !== null) {
    throw createError(
      "Parent category is already a subcategory: the menu supports exactly two levels",
      400,
      "PARENT_NOT_TOP_LEVEL",
    );
  }

  if (parent["is_active"] === false) {
    throw createError(
      "Parent category is deactivated: reactivate it before hanging subcategories from it",
      409,
      "PARENT_INACTIVE",
    );
  }
};

/**
 * Re-checks the invariant AFTER the write landed.
 *
 * There are no transactions available here, so two panel edits racing each
 * other could each validate against a state the other is about to change
 * (A under B while B moves under A, or a child created while its parent is
 * being demoted). Re-reading afterwards catches that; the caller undoes its
 * own write and returns 409 rather than leaving a three-level menu behind.
 */
export const hierarchyStillValid = async (params: {
  categoryId: string;
  parentCategoryId: string;
}): Promise<boolean> => {
  const { categoryId, parentCategoryId } = params;

  const { data: parent, error } = await supabaseAdmin
    .from("menu_categories")
    .select("id, parent_category_id")
    .eq("id", parentCategoryId)
    .maybeSingle();

  if (error) {
    throw createError(error.message, 500, "FETCH_FAILED");
  }
  if (!parent || getParentId(parent as CategoryRow) !== null) return false;

  const children = await listSubcategories(categoryId);
  return children.length === 0;
};

/** Children of a category. `activeOnly` is what deactivation cares about. */
export const listSubcategories = async (
  categoryId: string,
  options: { activeOnly?: boolean } = {},
): Promise<CategoryRow[]> => {
  let query = supabaseAdmin
    .from("menu_categories")
    .select("id, name, is_active")
    .eq("parent_category_id", categoryId);

  if (options.activeOnly) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;

  if (error) {
    if (isMissingHierarchyColumn(error)) return [];
    throw createError(error.message, 500, "FETCH_FAILED");
  }
  return (data ?? []) as CategoryRow[];
};

/**
 * A category that already has children cannot itself become a subcategory —
 * that would create a third level.
 */
export const assertCanBecomeSubcategory = async (categoryId: string): Promise<void> => {
  const children = await listSubcategories(categoryId);
  if (children.length > 0) {
    throw createError(
      `This category has ${children.length} subcategory(ies) and cannot become a subcategory itself`,
      409,
      "CATEGORY_HAS_SUBCATEGORIES",
    );
  }
};
