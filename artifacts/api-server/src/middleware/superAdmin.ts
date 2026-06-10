import { type Request, type Response, type NextFunction } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { createError } from "./errorHandler.js";

export interface SuperAdminContext {
  id: string;
  user_id: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      superAdmin?: SuperAdminContext;
    }
  }
}

/**
 * Validates the Bearer token via Supabase Auth, confirms the user is an active
 * super admin, and attaches super admin context to the request.
 */
export const requireSuperAdmin = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(createError("Missing or invalid authorization header", 401, "UNAUTHORIZED"));
    }

    const token = authHeader.slice(7);
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data.user) {
      return next(createError("Invalid or expired token", 401, "INVALID_TOKEN"));
    }

    const { data: sa, error: saError } = await supabaseAdmin
      .from("super_admins")
      .select("id, user_id, email, is_active")
      .eq("user_id", data.user.id)
      .eq("is_active", true)
      .maybeSingle();

    if (saError || !sa) {
      return next(createError("Super admin access required", 403, "FORBIDDEN"));
    }

    const record = sa as Record<string, unknown>;
    req.user = {
      id: data.user.id,
      email: data.user.email ?? "",
      role: "super_admin",
    };
    req.superAdmin = {
      id: record["id"] as string,
      user_id: record["user_id"] as string,
      email: (record["email"] as string) ?? data.user.email ?? "",
    };

    next();
  } catch {
    next(createError("Authentication failed", 401, "AUTH_FAILED"));
  }
};
