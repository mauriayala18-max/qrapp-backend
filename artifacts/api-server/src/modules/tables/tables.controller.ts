import type { NextFunction, Request, Response } from "express";
import { createError } from "../../middleware/errorHandler.js";
import * as sessionsService from "../sessions/sessions.service.js";

/**
 * POST /api/v1/tables/:tableId/scan
 *
 * What the permanent QR sticker leads to. The sticker only knows the table id;
 * everything rotating is resolved here, server-side.
 */
export const scanTable = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { tableId } = req.params as { tableId: string };
    const { platform, name } = req.body as { platform?: "app" | "web"; name?: string };

    if (!tableId) {
      return next(createError("tableId is required", 400, "MISSING_FIELDS"));
    }

    if (!platform || !["app", "web"].includes(platform)) {
      return next(createError("platform must be 'app' or 'web'", 400, "MISSING_FIELDS"));
    }

    const result = await sessionsService.scanTable({
      tableId,
      platform,
      ...(name ? { name } : {}),
      ...(req.user?.id ? { userId: req.user.id } : {}),
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
