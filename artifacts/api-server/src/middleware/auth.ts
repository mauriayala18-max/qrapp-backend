import { type Request, type Response, type NextFunction } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { createError } from "./errorHandler.js";

export const authenticate = async (
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

    req.user = {
      id: data.user.id,
      email: data.user.email ?? "",
      role: (data.user.user_metadata?.["role"] as string) ?? "user",
    };

    next();
  } catch {
    next(createError("Authentication failed", 401, "AUTH_FAILED"));
  }
};
