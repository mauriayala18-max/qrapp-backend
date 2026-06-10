import { type Request, type Response, type NextFunction } from "express";
import * as sessionsService from "./sessions.service.js";
import { createError } from "../../middleware/errorHandler.js";

export const joinSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { token, pin, name, platform } = req.body as {
      token?: string;
      pin?: string;
      name?: string;
      platform?: "app" | "web";
    };

    if (!platform || !["app", "web"].includes(platform)) {
      return next(createError("platform must be 'app' or 'web'", 400, "MISSING_FIELDS"));
    }

    const result = await sessionsService.joinSession({
      token,
      pin,
      name,
      platform,
      userId: req.user?.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const scanAndJoin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { token, platform, name } = req.body as {
      token?: string;
      platform?: "app" | "web";
      name?: string;
    };

    if (!token) {
      return next(createError("token is required", 400, "MISSING_FIELDS"));
    }

    if (!platform || !["app", "web"].includes(platform)) {
      return next(createError("platform must be 'app' or 'web'", 400, "MISSING_FIELDS"));
    }

    const result = await sessionsService.scanAndJoin({
      token,
      platform,
      name,
      userId: req.user?.id,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const result = await sessionsService.getSession(sessionId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getParticipants = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const result = await sessionsService.getParticipants(sessionId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const closeSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    await sessionsService.closeSession(sessionId, req.user!.id);
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
};
