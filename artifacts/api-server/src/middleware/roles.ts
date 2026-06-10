import { type Request, type Response, type NextFunction } from "express";
import { createError } from "./errorHandler.js";

/**
 * Gate a route to specific employee roles. Must run AFTER `requireEmployee`,
 * which populates `req.user.role` from the employees table.
 */
export const requireRole = (...roles: string[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      return next(createError("Insufficient role permissions", 403, "FORBIDDEN_ROLE"));
    }
    next();
  };
};
