import { type Request, type Response, type NextFunction } from "express";
import * as promotionsService from "./promotions.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const getBranchPromotions = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await promotionsService.getBranchPromotions({
      branchId,
      userId: req.user?.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const applyPromotion = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { promotionId } = req.params as { promotionId: string };
    const { order_id } = req.body as { order_id?: string };

    if (!order_id) {
      return next(createError("order_id is required", 400, "MISSING_FIELDS"));
    }

    const result = await promotionsService.applyPromotion({
      promotionId,
      order_id,
      userId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getMyCoupons = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await promotionsService.getMyCoupons(req.user!.id);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const applyCoupon = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { couponId } = req.params as { couponId: string };
    const { order_id } = req.body as { order_id?: string };

    if (!order_id) {
      return next(createError("order_id is required", 400, "MISSING_FIELDS"));
    }

    const result = await promotionsService.applyCoupon({
      couponId,
      order_id,
      userId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createPromotion = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { name, valid_from, valid_until } = req.body as {
      name?: string;
      valid_from?: string;
      valid_until?: string;
    };

    if (!name || !valid_from || !valid_until) {
      return next(createError("name, valid_from, and valid_until are required", 400, "MISSING_FIELDS"));
    }

    const result = await promotionsService.createPromotion({
      ...(req.body as Record<string, unknown>),
      branchId,
      employeeId: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updatePromotion = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { promotionId } = req.params as { promotionId: string };
    const result = await promotionsService.updatePromotion({
      promotionId,
      updates: req.body as Record<string, unknown>,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const deletePromotion = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { promotionId } = req.params as { promotionId: string };
    await promotionsService.deletePromotion(promotionId);
    res.json({ data: null, message: "Promotion deactivated" });
  } catch (err) {
    next(err);
  }
};

export const createCoupon = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { user_id, coupon_type, value, cap_amount, expires_at, reason } = req.body as {
      user_id?: string;
      coupon_type?: string;
      value?: number;
      cap_amount?: number;
      expires_at?: string;
      reason?: string;
    };

    if (!user_id || !coupon_type || value === undefined || !expires_at || !reason) {
      return next(createError("user_id, coupon_type, value, expires_at, and reason are required", 400, "MISSING_FIELDS"));
    }

    const result = await promotionsService.createCoupon({
      branchId,
      user_id,
      coupon_type,
      value,
      cap_amount,
      expires_at,
      reason,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getPromotionStats = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await promotionsService.getPromotionStats(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
