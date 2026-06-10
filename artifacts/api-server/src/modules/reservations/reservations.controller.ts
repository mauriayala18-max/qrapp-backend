import { type Request, type Response, type NextFunction } from "express";
import * as reservationsService from "./reservations.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const createReservation = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branch_id, date, time, party_size, special_requests } = req.body as {
      branch_id?: string;
      date?: string;
      time?: string;
      party_size?: number;
      special_requests?: string;
    };

    if (!branch_id || !date || !time || !party_size) {
      return next(createError("branch_id, date, time, and party_size are required", 400, "MISSING_FIELDS"));
    }

    const result = await reservationsService.createReservation({
      user_id: req.user!.id,
      branch_id,
      date,
      time,
      party_size,
      special_requests,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getMyReservations = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { status, upcoming } = req.query as { status?: string; upcoming?: string };

    const result = await reservationsService.getMyReservations({
      user_id: req.user!.id,
      status,
      upcoming: upcoming === "true",
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getBranchReservations = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { date, status } = req.query as { date?: string; status?: string };

    const result = await reservationsService.getBranchReservations({ branchId, date, status });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateReservation = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { reservationId } = req.params as { reservationId: string };
    const { status, rejection_reason } = req.body as {
      status?: "confirmed" | "rejected" | "cancelled" | "completed" | "no_show";
      rejection_reason?: string;
    };

    const validStatuses = ["confirmed", "rejected", "cancelled", "completed", "no_show"];
    if (!status || !validStatuses.includes(status)) {
      return next(createError(`status must be one of: ${validStatuses.join(", ")}`, 400, "INVALID_STATUS"));
    }

    const result = await reservationsService.updateReservation({
      reservationId,
      status,
      rejection_reason,
      employeeId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const cancelReservation = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { reservationId } = req.params as { reservationId: string };
    await reservationsService.cancelReservation({ reservationId, userId: req.user!.id });
    res.json({ data: null, message: "Reservation cancelled" });
  } catch (err) {
    next(err);
  }
};
