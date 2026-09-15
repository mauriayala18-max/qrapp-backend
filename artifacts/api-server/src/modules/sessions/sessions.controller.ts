import { type Request, type Response, type NextFunction } from "express";
import * as sessionsService from "./sessions.service.js";
import { createError } from "../../middleware/errorHandler.js";
import {
  loadSessionContext,
  resolveSessionActor,
  resolveSessionReadAccess,
} from "./session-actor.js";
import * as sessionLockService from "./session-lock.service.js";

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
    const participantId =
      typeof req.query["participant_id"] === "string" ? (req.query["participant_id"] as string) : undefined;

    const session = await loadSessionContext(sessionId);
    // Staff of the branch, the session's own seated diner, or (only for a
    // guest seat with no account) whoever presents that seat's id.
    const actor = await resolveSessionReadAccess({ session, authUserId: req.user?.id, participantId });

    // Staff sees the table as-is; a diner sees every seat's display name but
    // only their own seat's id and account (see getSession's redaction).
    const viewerParticipantId = actor.kind === "staff" ? undefined : actor.participantId;
    const result = await sessionsService.getSession(sessionId, viewerParticipantId);
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
    const session = await loadSessionContext(sessionId);
    // Staff of the branch, or a diner currently seated here. Nobody else.
    await resolveSessionActor(req.user!.id, session);
    const result = await sessionsService.getParticipants(sessionId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const lockSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const result = await sessionLockService.lockSession({
      sessionId,
      authUserId: req.user!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const unlockSession = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const result = await sessionLockService.unlockSession({
      sessionId,
      authUserId: req.user!.id,
    });
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
