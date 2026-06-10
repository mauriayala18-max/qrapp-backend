import { type Request, type Response, type NextFunction } from "express";
import * as waiterCallsService from "./waiter-calls.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const callWaiter = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { reason_id, custom_reason } = req.body as {
      reason_id?: string;
      custom_reason?: string;
    };

    const result = await waiterCallsService.callWaiter({
      sessionId,
      reason_id,
      custom_reason,
      userId: req.user?.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getBranchWaiterCalls = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await waiterCallsService.getBranchWaiterCalls(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateWaiterCall = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { callId } = req.params as { callId: string };
    const { status } = req.body as { status?: "acknowledged" | "resolved" };

    if (!status || !["acknowledged", "resolved"].includes(status)) {
      return next(createError("status must be 'acknowledged' or 'resolved'", 400, "INVALID_STATUS"));
    }

    const result = await waiterCallsService.updateWaiterCall({
      callId,
      status,
      employeeId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
