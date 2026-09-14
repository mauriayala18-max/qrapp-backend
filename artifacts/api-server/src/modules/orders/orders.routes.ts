import { Router, type IRouter } from "express";
import { authenticate } from "../../middleware/auth.js";
import { requireEmployee, optionalAuthenticate } from "../../middleware/employee.js";
import * as ordersController from "./orders.controller.js";

const router: IRouter = Router();

// A web diner has no account, so the token is optional here. The seat itself
// (`participant_id` in an active session) is the credential, and the service
// decides whether a token was required for that seat.
router.post("/", optionalAuthenticate, ordersController.createOrder);
router.post("/traditional", authenticate, requireEmployee, ordersController.createTraditionalOrder);
router.post("/anticipatory", authenticate, ordersController.createAnticipatoryOrder);
router.get("/:orderId", ordersController.getOrder);
router.post("/:orderId/link", authenticate, requireEmployee, ordersController.linkOrder);
router.patch("/:orderId/items/:itemId/status", authenticate, requireEmployee, ordersController.updateItemStatus);
router.patch("/:orderId/status", authenticate, requireEmployee, ordersController.updateOrderStatus);
router.post("/:orderId/cancel", authenticate, ordersController.cancelOrder);

export default router;
