import { type Request, type Response, type NextFunction } from "express";
import * as ratingsService from "./ratings.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const createDishRating = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { product_id, order_item_id, rating } = req.body as {
      product_id?: string;
      order_item_id?: string;
      rating?: number;
    };

    if (!product_id || !order_item_id || rating === undefined) {
      return next(createError("product_id, order_item_id, and rating are required", 400, "MISSING_FIELDS"));
    }

    const result = await ratingsService.createDishRating({
      userId: req.user!.id,
      product_id,
      order_item_id,
      rating,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createDishReview = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { ratingId } = req.params as { ratingId: string };
    const { review_text } = req.body as { review_text?: string };

    if (!review_text) {
      return next(createError("review_text is required", 400, "MISSING_FIELDS"));
    }

    const result = await ratingsService.createDishReview({
      userId: req.user!.id,
      ratingId,
      review_text,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getProductRatings = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { productId } = req.params as { productId: string };
    const result = await ratingsService.getProductRatings(productId);
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
    const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string) ?? "10", 10)));
    const sort = (req.query["sort"] as "recent" | "highest" | "lowest") ?? "recent";

    if (!["recent", "highest", "lowest"].includes(sort)) {
      return next(createError("sort must be 'recent', 'highest', or 'lowest'", 400, "INVALID_SORT"));
    }

    const result = await ratingsService.getProductReviews({ productId, page, limit, sort });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createRestaurantRating = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branch_id, session_id, rating, is_incentivized } = req.body as {
      branch_id?: string;
      session_id?: string;
      rating?: number;
      is_incentivized?: boolean;
    };

    if (!branch_id || !session_id || rating === undefined) {
      return next(createError("branch_id, session_id, and rating are required", 400, "MISSING_FIELDS"));
    }

    const result = await ratingsService.createRestaurantRating({
      userId: req.user!.id,
      branch_id,
      session_id,
      rating,
      is_incentivized,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getBranchRating = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await ratingsService.getBranchRating(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const respondToReview = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { reviewId } = req.params as { reviewId: string };
    const { response_text } = req.body as { response_text?: string };

    if (!response_text) {
      return next(createError("response_text is required", 400, "MISSING_FIELDS"));
    }

    const result = await ratingsService.respondToReview({
      reviewId,
      employeeId: req.user!.id,
      response_text,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateReviewStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { reviewId } = req.params as { reviewId: string };
    const { status } = req.body as { status?: "visible" | "hidden" | "reported" };

    if (!status || !["visible", "hidden", "reported"].includes(status)) {
      return next(createError("status must be 'visible', 'hidden', or 'reported'", 400, "INVALID_STATUS"));
    }

    const result = await ratingsService.updateReviewStatus({ reviewId, status });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getBranchReviews = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const page = Math.max(1, parseInt((req.query["page"] as string) ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string) ?? "20", 10)));
    const status = req.query["status"] as string | undefined;

    const result = await ratingsService.getBranchReviews({ branchId, status, page, limit });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
