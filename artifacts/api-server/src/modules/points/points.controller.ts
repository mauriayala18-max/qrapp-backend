import { type Request, type Response, type NextFunction } from "express";
import * as pointsService from "./points.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const getBalance = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await pointsService.getBalance(req.user!.id);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getHistory = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const page = Math.max(1, parseInt((req.query["page"] as string) ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string) ?? "20", 10)));
    const type = req.query["type"] as "earned" | "redeemed" | "expired" | undefined;

    if (type && !["earned", "redeemed", "expired"].includes(type)) {
      return next(createError("type must be 'earned', 'redeemed', or 'expired'", 400, "INVALID_TYPE"));
    }

    const result = await pointsService.getHistory({ userId: req.user!.id, page, limit, type });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const redeemPoints = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { amount, reason, reference_type, reference_id } = req.body as {
      amount?: number;
      reason?: string;
      reference_type?: string;
      reference_id?: string;
    };

    if (!amount || !reason || !reference_type || !reference_id) {
      return next(createError("amount, reason, reference_type, and reference_id are required", 400, "MISSING_FIELDS"));
    }

    const result = await pointsService.redeemPoints({
      user_id: req.user!.id,
      amount,
      reason,
      reference_type,
      reference_id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
