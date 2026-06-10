import { Router, type IRouter } from "express";
import { requireSuperAdmin } from "../../middleware/superAdmin.js";
import * as admin from "./admin.controller.js";

const router: IRouter = Router();

router.use(requireSuperAdmin);

// Dashboard
router.get("/dashboard", admin.getDashboard);

// Restaurant management
router.get("/restaurants", admin.getRestaurants);
router.post("/restaurants", admin.createRestaurant);
router.patch("/restaurants/:restaurantId/status", admin.updateRestaurantStatus);

// Catalog management
router.get("/catalogs/:catalogType", admin.getCatalog);
router.post("/catalogs/:catalogType", admin.createCatalogEntry);
router.patch("/catalogs/:catalogType/:entryId", admin.updateCatalogEntry);

// Premium management
router.get("/premium/plans", admin.getPremiumPlans);
router.post("/premium/plans", admin.createPremiumPlan);
router.patch("/premium/plans/:planId", admin.updatePremiumPlan);
router.get("/premium/subscriptions", admin.getSubscriptions);

// Support tickets
router.get("/support/tickets", admin.getTickets);
router.get("/support/tickets/:ticketId", admin.getTicket);
router.patch("/support/tickets/:ticketId", admin.updateTicket);
router.post("/support/tickets/:ticketId/messages", admin.createTicketMessage);

// Platform alerts
router.get("/alerts", admin.getPlatformAlerts);
router.patch("/alerts/:alertId", admin.updatePlatformAlert);

// Mass communications
router.get("/communications", admin.getCommunications);
router.post("/communications", admin.createCommunication);
router.post("/communications/:communicationId/send", admin.sendCommunication);

// Global configuration
router.get("/config", admin.getConfig);
router.patch("/config/:key", admin.updateConfig);

// Audit log
router.get("/audit-log", admin.getAuditLog);

export default router;
