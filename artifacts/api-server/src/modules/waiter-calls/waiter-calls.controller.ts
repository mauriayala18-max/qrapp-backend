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
    const { reason, reason_id, participant_id, detail, comment, note } = req.body as {
      reason?: string;
      reason_id?: string;
      participant_id?: string;
      // The client's exact field name for the free-text detail wasn't confirmed against its
      // source (not present in this workspace), so the three most likely names are all accepted;
      // whichever arrives first (in this precedence) wins. See the report for follow-up.
      detail?: string;
      comment?: string;
      note?: string;
    };

    const result = await waiterCallsService.callWaiter({
      sessionId,
      reason,
      reason_id,
      detail: detail ?? comment ?? note,
      userId: req.user?.id,
      participantId: participant_id,
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
