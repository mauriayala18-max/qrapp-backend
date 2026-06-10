import { type Request, type Response, type NextFunction } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { createError } from "./errorHandler.js";

export const requireEmployee = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  if (!req.user) {
    return next(createError("Authentication required", 401, "UNAUTHORIZED"));
  }

  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role, is_active")
    .eq("user_id", req.user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) {
    return next(createError("Employee access required", 403, "FORBIDDEN"));
  }

  req.user.role = data.role as string;
  next();
};

export const optionalAuthenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.slice(7);
  const { data } = await supabaseAdmin.auth.getUser(token);

  if (data?.user) {
    req.user = {
      id: data.user.id,
      email: data.user.email ?? "",
      role: (data.user.user_metadata?.["role"] as string) ?? "user",
    };
  }

  next();
};
