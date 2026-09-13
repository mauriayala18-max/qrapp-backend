-- Two-level category hierarchy for the QR App menu.
-- Idempotent: safe to run more than once.
--
-- NULL parent_category_id  = top-level (madre) category
-- non-NULL                 = subcategory of that category
--
-- The "a subcategory may not have children" rule is enforced in the backend
-- (menu/category-hierarchy.ts), because a CHECK constraint cannot look at
-- another row. The self-parent case IS expressible, so it is enforced here too.

BEGIN;

-- 1. The parent link.
ALTER TABLE public.menu_categories
  ADD COLUMN IF NOT EXISTS parent_category_id uuid NULL;

-- 2. FK to menu_categories(id). RESTRICT: a category with subcategories cannot be
--    hard-deleted out from under them (the API soft-deletes anyway).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'menu_categories_parent_category_id_fkey'
      AND conrelid = 'public.menu_categories'::regclass
  ) THEN
    ALTER TABLE public.menu_categories
      ADD CONSTRAINT menu_categories_parent_category_id_fkey
      FOREIGN KEY (parent_category_id)
      REFERENCES public.menu_categories(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- 3. A category can never be its own parent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'menu_categories_no_self_parent'
      AND conrelid = 'public.menu_categories'::regclass
  ) THEN
    ALTER TABLE public.menu_categories
      ADD CONSTRAINT menu_categories_no_self_parent
      CHECK (parent_category_id IS NULL OR parent_category_id <> id);
  END IF;
END $$;

-- 4. Lookup index for "give me the children of X".
CREATE INDEX IF NOT EXISTS idx_menu_categories_parent_category_id
  ON public.menu_categories (parent_category_id)
  WHERE parent_category_id IS NOT NULL;

COMMIT;
