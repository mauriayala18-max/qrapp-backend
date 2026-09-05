import { type Request, type Response, type NextFunction } from "express";

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  /** Extra machine-readable fields merged into the error response body. */
  details?: Record<string, unknown>;
}

export const errorHandler = (
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const statusCode = err.statusCode ?? 500;
  const code = err.code ?? "INTERNAL_ERROR";
  const message = err.message ?? "An unexpected error occurred";

  res.status(statusCode).json({
    error: true,
    message,
    code,
    ...(err.details ?? {}),
  });
};

export const createError = (
  message: string,
  statusCode: number,
  code: string,
  details?: Record<string, unknown>,
): AppError => {
  const err: AppError = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details) err.details = details;
  return err;
};
