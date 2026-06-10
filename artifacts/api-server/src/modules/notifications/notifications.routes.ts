import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as notificationsController from "./notifications.controller.js";

const router: IRouter = Router();

router.get("/", authenticate, notificationsController.getNotifications);
router.get("/unread-count", authenticate, notificationsController.getUnreadCount);
router.get("/preferences", authenticate, notificationsController.getPreferences);
router.patch("/preferences", authenticate, notificationsController.updatePreferences);
router.post("/read-all", authenticate, notificationsController.markAllRead);
router.patch("/:notificationId/read", authenticate, notificationsController.markAsRead);

export default router;
