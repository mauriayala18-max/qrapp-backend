import { type Request, type Response, type NextFunction } from "express";
import * as panelService from "./panel.service.js";
import { createError } from "../../middleware/errorHandler.js";

const parsePage = (req: Request): number => Math.max(1, parseInt((req.query["page"] as string) ?? "1", 10));
const parseLimit = (req: Request, def = 20): number =>
  Math.min(100, Math.max(1, parseInt((req.query["limit"] as string) ?? String(def), 10)));

export const getDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await panelService.getDashboard(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getStatistics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const period = (req.query["period"] as "today" | "week" | "month" | "custom") ?? "today";
    const from = req.query["from"] as string | undefined;
    const to = req.query["to"] as string | undefined;

    if (!["today", "week", "month", "custom"].includes(period)) {
      return next(createError("period must be today, week, month, or custom", 400, "INVALID_PERIOD"));
    }

    const result = await panelService.getStatistics({ branchId, period, from, to });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getEmployees = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await panelService.getEmployees(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createEmployee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { full_name, email, password, phone, role } = req.body as {
      full_name?: string;
      email?: string;
      password?: string;
      phone?: string;
      role?: "admin" | "manager" | "kitchen" | "waiter";
    };

    if (!full_name || !email || !password || !role) {
      return next(createError("full_name, email, password, and role are required", 400, "MISSING_FIELDS"));
    }

    if (!["admin", "manager", "kitchen", "waiter"].includes(role)) {
      return next(createError("role must be admin, manager, kitchen, or waiter", 400, "INVALID_ROLE"));
    }

    const result = await panelService.createEmployee({ branchId, full_name, email, password, phone, role });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateEmployee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { employeeId } = req.params as { employeeId: string };
    const result = await panelService.updateEmployee({ employeeId, updates: req.body as Record<string, unknown> });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const deactivateEmployee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { employeeId } = req.params as { employeeId: string };
    const { termination_reason_id } = req.body as { termination_reason_id?: string };

    if (!termination_reason_id) {
      return next(createError("termination_reason_id is required", 400, "MISSING_FIELDS"));
    }

    const result = await panelService.deactivateEmployee({ employeeId, termination_reason_id });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const reactivateEmployee = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { employeeId } = req.params as { employeeId: string };
    const result = await panelService.reactivateEmployee(employeeId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getWaiterAssignments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await panelService.getWaiterAssignments(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const setWaiterAssignments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { employee_id, table_ids } = req.body as { employee_id?: string; table_ids?: string[] };

    if (!employee_id || !Array.isArray(table_ids)) {
      return next(createError("employee_id and table_ids (array) are required", 400, "MISSING_FIELDS"));
    }

    const result = await panelService.setWaiterAssignments({ employee_id, table_ids });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getClients = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const segment = req.query["segment"] as "frequent" | "new" | "inactive" | undefined;
    const result = await panelService.getClients({
      branchId,
      segment,
      page: parsePage(req),
      limit: parseLimit(req),
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getClientProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { userId } = req.params as { userId: string };
    const branchId = req.query["branch_id"] as string | undefined;

    if (!branchId) {
      return next(createError("branch_id query param is required", 400, "MISSING_BRANCH"));
    }

    const result = await panelService.getClientProfile({ userId, branchId });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getBranchSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await panelService.getBranchSettings(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateBranchSettings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await panelService.updateBranchSettings({
      branchId,
      updates: req.body as Record<string, unknown>,
      employeeId: req.user!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const replaceBranchHours = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { hours } = req.body as {
      hours?: Array<{ day_of_week: number; open_time: string; close_time: string; is_closed: boolean }>;
    };

    if (!Array.isArray(hours)) {
      return next(createError("hours (array) is required", 400, "MISSING_FIELDS"));
    }

    const result = await panelService.replaceBranchHours({ branchId, hours });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const addBranchPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { photo_url, is_logo, display_order } = req.body as {
      photo_url?: string;
      is_logo?: boolean;
      display_order?: number;
    };

    if (!photo_url) {
      return next(createError("photo_url is required", 400, "MISSING_FIELDS"));
    }

    const result = await panelService.addBranchPhoto({ branchId, photo_url, is_logo, display_order });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const deleteBranchPhoto = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { photoId } = req.params as { photoId: string };
    await panelService.deleteBranchPhoto(photoId);
    res.json({ data: null, message: "Photo deleted" });
  } catch (err) {
    next(err);
  }
};

export const setPaymentMethods = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { methods } = req.body as { methods?: Array<{ payment_method: string; is_enabled: boolean }> };

    if (!Array.isArray(methods)) {
      return next(createError("methods (array) is required", 400, "MISSING_FIELDS"));
    }

    const result = await panelService.setPaymentMethods({ branchId, methods });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getTables = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const result = await panelService.getTables(branchId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createTable = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const { table_number, capacity } = req.body as { table_number?: string; capacity?: number };

    if (!table_number) {
      return next(createError("table_number is required", 400, "MISSING_FIELDS"));
    }

    const result = await panelService.createTable({ branchId, table_number, capacity });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateTable = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { tableId } = req.params as { tableId: string };
    const result = await panelService.updateTable({ tableId, updates: req.body as Record<string, unknown> });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getAlerts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { branchId } = req.params as { branchId: string };
    const status = req.query["status"] as string | undefined;
    const result = await panelService.getAlerts({ branchId, status, role: req.user!.role ?? "" });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateAlert = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { alertId } = req.params as { alertId: string };
    const { status } = req.body as { status?: "acknowledged" | "resolved" };

    if (!status || !["acknowledged", "resolved"].includes(status)) {
      return next(createError("status must be 'acknowledged' or 'resolved'", 400, "INVALID_STATUS"));
    }

    const result = await panelService.updateAlert({ alertId, status, employeeId: req.user!.id });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
