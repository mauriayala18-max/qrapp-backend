import { type Request, type Response, type NextFunction } from "express";
import * as notificationsService from "./notifications.service.js";

export const getNotifications = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const page = Math.max(1, parseInt((req.query["page"] as string) ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string) ?? "20", 10)));
    const unreadOnly = req.query["unread_only"] === "true";

    const result = await notificationsService.getNotifications({
      userId: req.user!.id,
      page,
      limit,
      unreadOnly,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const getUnreadCount = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const count = await notificationsService.getUnreadCount(req.user!.id);
    res.json({ data: { count } });
  } catch (err) {
    next(err);
  }
};

export const markAsRead = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { notificationId } = req.params as { notificationId: string };
    const result = await notificationsService.markAsRead({
      notificationId,
      userId: req.user!.id,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const markAllRead = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await notificationsService.markAllRead(req.user!.id);
    res.json({ data: null, message: "All notifications marked as read" });
  } catch (err) {
    next(err);
  }
};

export const getPreferences = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await notificationsService.getPreferences(req.user!.id);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
};

export const updatePreferences = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await notificationsService.updatePreferences({
      userId: req.user!.id,
      preferences: req.body as Record<string, boolean>,
    });
    res.json({ data: null, message: "Preferences updated" });
  } catch (err) {
    next(err);
  }
};
