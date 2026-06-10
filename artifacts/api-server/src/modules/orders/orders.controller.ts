import { type Request, type Response, type NextFunction } from "express";
import * as ordersService from "./orders.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const createOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { session_id, items, notes } = req.body as {
      session_id?: string;
      items?: unknown[];
      notes?: string;
    };

    if (!session_id || !items?.length) {
      return next(createError("session_id and items are required", 400, "MISSING_FIELDS"));
    }

    const result = await ordersService.createOrder({
      session_id,
      items: items as Parameters<typeof ordersService.createOrder>[0]["items"],
      notes,
      user_id: req.user?.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createTraditionalOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { session_id, items, notes } = req.body as {
      session_id?: string;
      items?: unknown[];
      notes?: string;
    };

    if (!session_id || !items?.length) {
      return next(createError("session_id and items are required", 400, "MISSING_FIELDS"));
    }

    const result = await ordersService.createTraditionalOrder({
      session_id,
      items: items as Parameters<typeof ordersService.createTraditionalOrder>[0]["items"],
      notes,
      employee_id: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createAnticipatoryOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branch_id, order_type, requested_time, items, notes } = req.body as {
      branch_id?: string;
      order_type?: "anticipatory_dine_in" | "anticipatory_pickup";
      requested_time?: string;
      items?: unknown[];
      notes?: string;
    };

    if (!branch_id || !order_type || !requested_time || !items?.length) {
      return next(
        createError("branch_id, order_type, requested_time, and items are required", 400, "MISSING_FIELDS"),
      );
    }

    const result = await ordersService.createAnticipatoryOrder({
      branch_id,
      order_type,
      requested_time,
      items: items as Parameters<typeof ordersService.createAnticipatoryOrder>[0]["items"],
      notes,
      user_id: req.user!.id,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const linkOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { orderId } = req.params as { orderId: string };
    const { session_id } = req.body as { session_id?: string };

    if (!session_id) {
      return next(createError("session_id is required", 400, "MISSING_FIELDS"));
    }

    const result = await ordersService.linkOrderToSession(orderId, session_id);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { orderId } = req.params as { orderId: string };
    const result = await ordersService.getOrder(orderId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getActiveOrders = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await ordersService.getActiveOrders(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateItemStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { orderId, itemId } = req.params as { orderId: string; itemId: string };
    const { status } = req.body as { status?: "in_preparation" | "ready" | "cancelled" };

    if (!status || !["in_preparation", "ready", "cancelled"].includes(status)) {
      return next(createError("status must be 'in_preparation', 'ready', or 'cancelled'", 400, "INVALID_STATUS"));
    }

    const result = await ordersService.updateItemStatus(orderId, itemId, status);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateOrderStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { orderId } = req.params as { orderId: string };
    const { status } = req.body as { status?: "ready" | "delivered" };

    if (!status || !["ready", "delivered"].includes(status)) {
      return next(createError("status must be 'ready' or 'delivered'", 400, "INVALID_STATUS"));
    }

    const result = await ordersService.updateOrderStatus(orderId, status);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const cancelOrder = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { orderId } = req.params as { orderId: string };
    const { reason, item_id } = req.body as { reason?: string; item_id?: string };

    const result = await ordersService.cancelOrder({
      orderId,
      reason,
      item_id,
      userId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const handleCancellation = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { requestId } = req.params as { requestId: string };
    const { status, rejection_reason } = req.body as {
      status?: "approved" | "rejected";
      rejection_reason?: string;
    };

    if (!status || !["approved", "rejected"].includes(status)) {
      return next(createError("status must be 'approved' or 'rejected'", 400, "INVALID_STATUS"));
    }

    const result = await ordersService.handleCancellationRequest({
      requestId,
      status,
      rejection_reason,
      employeeId: req.user!.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
