import { type Request, type Response, type NextFunction } from "express";
import * as adminService from "./admin.service.js";
import { createError } from "../../middleware/errorHandler.js";

const parsePage = (req: Request): number => {
  const n = parseInt((req.query["page"] as string) ?? "1", 10);
  return Number.isNaN(n) ? 1 : Math.max(1, n);
};
const parseLimit = (req: Request, def = 20): number => {
  const n = parseInt((req.query["limit"] as string) ?? String(def), 10);
  return Number.isNaN(n) ? def : Math.min(100, Math.max(1, n));
};

// ----------------------------- DASHBOARD ------------------------------------

export const getDashboard = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await adminService.getDashboard();
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

// ----------------------- RESTAURANT MANAGEMENT ------------------------------

export const getRestaurants = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await adminService.getRestaurants({
      status: req.query["status"] as string | undefined,
      cuisineType: req.query["cuisine_type"] as string | undefined,
      page: parsePage(req),
      limit: parseLimit(req),
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createRestaurant = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, slug, description, branches } = req.body as {
      name?: string;
      slug?: string;
      description?: string;
      branches?: Array<{
        name: string;
        address: string;
        latitude?: number;
        longitude?: number;
        phone?: string;
        operation_mode?: string;
      }>;
    };

    if (!name || !slug || !Array.isArray(branches) || branches.length === 0) {
      return next(createError("name, slug, and at least one branch are required", 400, "MISSING_FIELDS"));
    }

    for (const b of branches) {
      if (!b.name || !b.address) {
        return next(createError("each branch requires name and address", 400, "MISSING_FIELDS"));
      }
    }

    const result = await adminService.createRestaurant({ name, slug, description, branches });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateRestaurantStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { restaurantId } = req.params as { restaurantId: string };
    const { action, deactivation_reason } = req.body as {
      action?: "activate" | "deactivate" | "suspend";
      deactivation_reason?: string;
    };

    if (!action || !["activate", "deactivate", "suspend"].includes(action)) {
      return next(createError("action must be activate, deactivate, or suspend", 400, "INVALID_ACTION"));
    }

    const result = await adminService.updateRestaurantStatus({
      restaurantId,
      action,
      deactivationReason: deactivation_reason,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

// ------------------------- CATALOG MANAGEMENT -------------------------------

export const getCatalog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { catalogType } = req.params as { catalogType: string };
    const result = await adminService.getCatalog(catalogType);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createCatalogEntry = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { catalogType } = req.params as { catalogType: string };
    const { name, code } = req.body as { name?: string; code?: string };

    if (!name) {
      return next(createError("name is required", 400, "MISSING_FIELDS"));
    }

    const result = await adminService.createCatalogEntry({ catalogType, name, code });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateCatalogEntry = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { catalogType, entryId } = req.params as { catalogType: string; entryId: string };
    const result = await adminService.updateCatalogEntry({
      catalogType,
      entryId,
      updates: req.body as Record<string, unknown>,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

// ------------------------- PREMIUM MANAGEMENT -------------------------------

export const getPremiumPlans = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await adminService.getPremiumPlans();
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createPremiumPlan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, price, billing_period, double_points, priority_reservations, direct_promo_access } =
      req.body as {
        name?: string;
        price?: number;
        billing_period?: string;
        double_points?: boolean;
        priority_reservations?: boolean;
        direct_promo_access?: boolean;
      };

    if (!name || price === undefined || !billing_period) {
      return next(createError("name, price, and billing_period are required", 400, "MISSING_FIELDS"));
    }

    const result = await adminService.createPremiumPlan({
      name,
      price,
      billing_period,
      double_points,
      priority_reservations,
      direct_promo_access,
    });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updatePremiumPlan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { planId } = req.params as { planId: string };
    const result = await adminService.updatePremiumPlan({
      planId,
      updates: req.body as Record<string, unknown>,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getSubscriptions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await adminService.getSubscriptions({
      status: req.query["status"] as string | undefined,
      page: parsePage(req),
      limit: parseLimit(req),
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

// --------------------------- SUPPORT TICKETS --------------------------------

export const getTickets = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await adminService.getTickets({
      status: req.query["status"] as string | undefined,
      priority: req.query["priority"] as string | undefined,
      page: parsePage(req),
      limit: parseLimit(req),
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getTicket = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { ticketId } = req.params as { ticketId: string };
    const result = await adminService.getTicket(ticketId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateTicket = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { ticketId } = req.params as { ticketId: string };
    const result = await adminService.updateTicket({
      ticketId,
      updates: req.body as Record<string, unknown>,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createTicketMessage = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { ticketId } = req.params as { ticketId: string };
    const { message } = req.body as { message?: string };

    if (!message) {
      return next(createError("message is required", 400, "MISSING_FIELDS"));
    }

    const result = await adminService.createTicketMessage({
      ticketId,
      message,
      superAdminId: req.superAdmin!.id,
    });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

// --------------------------- PLATFORM ALERTS --------------------------------

export const getPlatformAlerts = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await adminService.getPlatformAlerts({
      status: req.query["status"] as string | undefined,
      type: req.query["type"] as string | undefined,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updatePlatformAlert = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { alertId } = req.params as { alertId: string };
    const { status } = req.body as { status?: "acknowledged" | "resolved" };

    if (!status || !["acknowledged", "resolved"].includes(status)) {
      return next(createError("status must be 'acknowledged' or 'resolved'", 400, "INVALID_STATUS"));
    }

    const result = await adminService.updatePlatformAlert({
      alertId,
      status,
      superAdminId: req.superAdmin!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

// ------------------------- MASS COMMUNICATIONS ------------------------------

export const getCommunications = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await adminService.getCommunications();
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const createCommunication = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { target_type, segment_criteria, title, body, channel } = req.body as {
      target_type?: "all_users" | "all_restaurants" | "segment";
      segment_criteria?: Record<string, unknown>;
      title?: string;
      body?: string;
      channel?: "push" | "email" | "both";
    };

    if (!target_type || !["all_users", "all_restaurants", "segment"].includes(target_type)) {
      return next(createError("target_type must be all_users, all_restaurants, or segment", 400, "INVALID_TARGET"));
    }
    if (!title || !body) {
      return next(createError("title and body are required", 400, "MISSING_FIELDS"));
    }
    if (!channel || !["push", "email", "both"].includes(channel)) {
      return next(createError("channel must be push, email, or both", 400, "INVALID_CHANNEL"));
    }

    const result = await adminService.createCommunication({
      target_type,
      segment_criteria,
      title,
      body,
      channel,
      superAdminId: req.superAdmin!.id,
    });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const sendCommunication = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { communicationId } = req.params as { communicationId: string };
    const result = await adminService.sendCommunication(communicationId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

// ------------------------- GLOBAL CONFIGURATION -----------------------------

export const getConfig = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await adminService.getConfig();
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updateConfig = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { key } = req.params as { key: string };
    const { value } = req.body as { value?: unknown };

    if (value === undefined) {
      return next(createError("value is required", 400, "MISSING_FIELDS"));
    }

    const result = await adminService.updateConfig({
      key,
      value,
      superAdminId: req.superAdmin!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

// ------------------------------ AUDIT LOG -----------------------------------

export const getAuditLog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await adminService.getAuditLog({
      actorType: req.query["actor_type"] as string | undefined,
      module: req.query["module"] as string | undefined,
      logLevel: req.query["log_level"] as string | undefined,
      page: parsePage(req),
      limit: parseLimit(req, 50),
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};
