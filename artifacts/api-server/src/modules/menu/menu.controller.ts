import { type Request, type Response, type NextFunction } from "express";
import * as menuService from "./menu.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const getBranchMenu = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { time_slot_id, language, category_id } = req.query as Record<string, string | undefined>;

    const result = await menuService.getBranchMenu({ branchId, time_slot_id, language, category_id });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const searchMenu = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { q } = req.query as { q?: string };

    if (!q || q.trim().length < 2) {
      return next(createError("Query param 'q' must be at least 2 characters", 400, "INVALID_QUERY"));
    }

    const result = await menuService.searchMenu(branchId, q.trim());
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getFeaturedProducts = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await menuService.getFeaturedProducts(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getProductDetail = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { productId } = req.params as { productId: string };
    const result = await menuService.getProductDetail(productId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getProductReviews = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { productId } = req.params as { productId: string };
    const page = Math.max(1, parseInt((req.query["page"] as string) ?? "1", 10));
    const limit = Math.min(50, Math.max(1, parseInt((req.query["limit"] as string) ?? "10", 10)));
    const sort = ((req.query["sort"] as string) ?? "recent") as "recent" | "highest" | "lowest";

    if (!["recent", "highest", "lowest"].includes(sort)) {
      return next(createError("sort must be 'recent', 'highest', or 'lowest'", 400, "INVALID_SORT"));
    }

    const result = await menuService.getProductReviews({ productId, page, limit, sort });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createProduct = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { category_id, name, price } = req.body as { category_id?: string; name?: string; price?: number };

    if (!category_id || !name || price === undefined) {
      return next(createError("category_id, name, and price are required", 400, "MISSING_FIELDS"));
    }

    const body = req.body as Omit<Parameters<typeof menuService.createProduct>[0], "branchId" | "employeeId">;
    const result = await menuService.createProduct({
      ...body,
      branchId,
      employeeId: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateProduct = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { productId } = req.params as { productId: string };
    const result = await menuService.updateProduct({
      productId,
      updates: req.body as Parameters<typeof menuService.updateProduct>[0]["updates"],
      employeeId: req.user!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const toggleProductAvailability = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { productId } = req.params as { productId: string };
    const { is_available } = req.body as { is_available?: boolean };

    if (is_available === undefined) {
      return next(createError("is_available is required", 400, "MISSING_FIELDS"));
    }

    const result = await menuService.toggleProductAvailability({
      productId,
      is_available,
      employeeId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const deleteProduct = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { productId } = req.params as { productId: string };
    await menuService.softDeleteProduct({ productId, employeeId: req.user!.id });
    res.json({ data: null, message: "Product deactivated successfully" });
  } catch (err) {
    next(err);
  }
};

export const createCategory = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { name } = req.body as { name?: string };

    if (!name) {
      return next(createError("name is required", 400, "MISSING_FIELDS"));
    }

    const catBody = req.body as Omit<Parameters<typeof menuService.createCategory>[0], "branchId" | "employeeId">;
    const result = await menuService.createCategory({
      ...catBody,
      branchId,
      employeeId: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateCategory = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { categoryId } = req.params as { categoryId: string };
    const result = await menuService.updateCategory({
      categoryId,
      updates: req.body as Parameters<typeof menuService.updateCategory>[0]["updates"],
      employeeId: req.user!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getChangeLog = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const page = Math.max(1, parseInt((req.query["page"] as string) ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string) ?? "20", 10)));
    const entity_type = req.query["entity_type"] as "product" | "category" | undefined;

    if (entity_type && !["product", "category"].includes(entity_type)) {
      return next(createError("entity_type must be 'product' or 'category'", 400, "INVALID_PARAM"));
    }

    const result = await menuService.getChangeLog({ branchId, page, limit, entity_type });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
