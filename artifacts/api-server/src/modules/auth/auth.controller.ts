import { type Request, type Response, type NextFunction } from "express";
import * as authService from "./auth.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const register = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { email, password, full_name, registration_source = "email" } = req.body as {
      email?: string;
      password?: string;
      full_name?: string;
      registration_source?: string;
    };

    if (!email || !password || !full_name) {
      return next(createError("email, password, and full_name are required", 400, "MISSING_FIELDS"));
    }

    const result = await authService.registerUser(email, password, full_name, registration_source);

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      return next(createError("email and password are required", 400, "MISSING_FIELDS"));
    }

    const result = await authService.loginUser(email, password);

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const socialAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { provider, access_token } = req.body as {
      provider?: "google" | "apple";
      access_token?: string;
    };

    if (!provider || !access_token) {
      return next(createError("provider and access_token are required", 400, "MISSING_FIELDS"));
    }

    if (provider !== "google" && provider !== "apple") {
      return next(createError("provider must be 'google' or 'apple'", 400, "INVALID_PROVIDER"));
    }

    const result = await authService.socialLogin(provider, access_token);

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getMe = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const profile = await authService.getMe(userId);
    res.json({ data: profile });
  } catch (err) {
    next(err);
  }
};

export const updateMe = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;

    const { full_name, phone, date_of_birth, dining_frequency, preferred_language, font_size, dark_mode } =
      req.body as {
        full_name?: string;
        phone?: string;
        date_of_birth?: string;
        dining_frequency?: string;
        preferred_language?: string;
        font_size?: string;
        dark_mode?: boolean;
      };

    const updates = Object.fromEntries(
      Object.entries({ full_name, phone, date_of_birth, dining_frequency, preferred_language, font_size, dark_mode }).filter(
        ([, v]) => v !== undefined,
      ),
    ) as Parameters<typeof authService.updateMe>[1];

    const profile = await authService.updateMe(userId, updates);

    res.json({ data: profile });
  } catch (err) {
    next(err);
  }
};

export const employeeLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      return next(createError("email and password are required", 400, "MISSING_FIELDS"));
    }

    const result = await authService.employeeLogin(email, password);

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const acceptTerms = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { version } = req.body as { version?: string };

    if (!version) {
      return next(createError("version is required", 400, "MISSING_FIELDS"));
    }

    await authService.acceptTerms(userId, version);

    res.json({ data: null, message: "Terms accepted successfully" });
  } catch (err) {
    next(err);
  }
};
